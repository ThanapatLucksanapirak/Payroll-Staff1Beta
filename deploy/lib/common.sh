#!/usr/bin/env bash
# Shared helpers for the Payroll installer, CLI and updater.
# Sourced, never executed. See deploy/CONTRACT.md for the layout.
# shellcheck disable=SC2034

# Predictable permissions no matter how we were started (some shells use umask 000).
umask 022

PAYROLL_ROOT="${PAYROLL_ROOT:-/opt/payroll}"
PAYROLL_ETC="${PAYROLL_ETC:-/etc/payroll}"
PAYROLL_ENV_FILE="$PAYROLL_ETC/payroll.env"
PAYROLL_DATA="${PAYROLL_DATA:-/var/lib/payroll}"
PAYROLL_BACKUPS="${PAYROLL_BACKUPS:-/var/backups/payroll}"
PAYROLL_LOGS="${PAYROLL_LOGS:-/var/log/payroll}"
PAYROLL_USER="payroll"
PAYROLL_REPO_DIR="$PAYROLL_ROOT/repo"
PAYROLL_RELEASES="$PAYROLL_ROOT/releases"
PAYROLL_CURRENT="$PAYROLL_ROOT/current"
PAYROLL_PREVIOUS="$PAYROLL_ROOT/previous"
PAYROLL_NODE_DIR="$PAYROLL_ROOT/node"
PAYROLL_NODE_MAJOR="${PAYROLL_NODE_MAJOR:-22}"
PAYROLL_KEEP_RELEASES="${PAYROLL_KEEP_RELEASES:-3}"
PAYROLL_DEFAULT_REPO="https://github.com/ThanapatLucksanapirak/Payroll-Staff1Beta.git"

# ── Output ────────────────────────────────────────────────────────────────────
if [[ -t 1 && -z "${NO_COLOR:-}" ]]; then
  C_RESET=$'\e[0m' C_BOLD=$'\e[1m' C_DIM=$'\e[2m' C_RED=$'\e[31m' C_GREEN=$'\e[32m' C_YELLOW=$'\e[33m' C_BLUE=$'\e[34m'
else
  C_RESET="" C_BOLD="" C_DIM="" C_RED="" C_GREEN="" C_YELLOW="" C_BLUE=""
fi

step() { printf '\n%s==>%s %s%s%s\n' "$C_BLUE" "$C_RESET" "$C_BOLD" "$*" "$C_RESET"; }
info() { printf '    %s\n' "$*"; }
ok()   { printf '    %s✓%s %s\n' "$C_GREEN" "$C_RESET" "$*"; }
warn() { printf '    %s!%s %s\n' "$C_YELLOW" "$C_RESET" "$*" >&2; }
die()  { printf '\n%s✗ %s%s\n' "$C_RED" "$*" "$C_RESET" >&2; exit 1; }

# Ask a question on the terminal even when stdin is a pipe (curl | bash).
# ask VAR "Question" "default"
ask() {
  local __var="$1" __q="$2" __def="${3:-}" __ans=""
  if [[ -n "${!__var:-}" ]]; then return 0; fi
  if [[ "${PAYROLL_NONINTERACTIVE:-0}" == 1 ]] || ! { : </dev/tty; } 2>/dev/null; then
    printf -v "$__var" '%s' "$__def"; return 0
  fi
  if [[ -n "$__def" ]]; then printf '    %s %s[%s]%s: ' "$__q" "$C_DIM" "$__def" "$C_RESET" >/dev/tty
  else printf '    %s: ' "$__q" >/dev/tty; fi
  IFS= read -r __ans </dev/tty || true
  printf -v "$__var" '%s' "${__ans:-$__def}"
}

# ask_secret VAR "Question"  (no echo)
ask_secret() {
  local __var="$1" __q="$2" __ans=""
  if [[ -n "${!__var:-}" ]]; then return 0; fi
  if [[ "${PAYROLL_NONINTERACTIVE:-0}" == 1 ]] || ! { : </dev/tty; } 2>/dev/null; then return 0; fi
  printf '    %s: ' "$__q" >/dev/tty
  IFS= read -rs __ans </dev/tty || true
  printf '\n' >/dev/tty
  printf -v "$__var" '%s' "$__ans"
}

# confirm "Question" [default y|n]  -> returns 0 for yes
confirm() {
  local q="$1" def="${2:-y}" ans=""
  ask ans "$q (y/n)" "$def"
  [[ "$ans" =~ ^[Yy] ]]
}

# ── Environment ───────────────────────────────────────────────────────────────
require_root() { [[ $EUID -eq 0 ]] || die "Please run this with sudo."; }

has_systemd() { [[ -d /run/systemd/system ]]; }

detect_os() {
  [[ -r /etc/os-release ]] || die "Cannot detect the operating system (/etc/os-release missing)."
  # shellcheck disable=SC1091
  . /etc/os-release
  case "${ID:-} ${ID_LIKE:-}" in
    *debian*|*ubuntu*) ;;
    *) die "This installer supports Debian and Ubuntu. Found: ${PRETTY_NAME:-unknown}." ;;
  esac
  OS_PRETTY="${PRETTY_NAME:-$ID}"
  case "$(uname -m)" in
    x86_64|amd64) NODE_ARCH=x64 ;;
    aarch64|arm64) NODE_ARCH=arm64 ;;
    armv7l) NODE_ARCH=armv7l ;;
    *) die "Unsupported CPU architecture: $(uname -m)." ;;
  esac
}

# Read KEY from the env file (empty if missing).
env_get() {
  local key="$1"
  [[ -f "$PAYROLL_ENV_FILE" ]] || return 0
  sed -n "s/^${key}=//p" "$PAYROLL_ENV_FILE" | tail -n1 | sed -e 's/^"//' -e 's/"$//'
}

# Set KEY=VALUE in the env file, replacing an existing line.
env_set() {
  local key="$1" val="$2" tmp
  mkdir -p "$PAYROLL_ETC"
  touch "$PAYROLL_ENV_FILE"
  tmp="$(mktemp "$PAYROLL_ETC/.env.XXXXXX")"
  grep -v "^${key}=" "$PAYROLL_ENV_FILE" >"$tmp" || true
  printf '%s=%s\n' "$key" "$val" >>"$tmp"
  chmod 640 "$tmp"
  getent group "$PAYROLL_USER" >/dev/null && chgrp "$PAYROLL_USER" "$tmp"
  mv -f "$tmp" "$PAYROLL_ENV_FILE"
}

env_unset() {
  local key="$1" tmp
  [[ -f "$PAYROLL_ENV_FILE" ]] || return 0
  tmp="$(mktemp "$PAYROLL_ETC/.env.XXXXXX")"
  grep -v "^${key}=" "$PAYROLL_ENV_FILE" >"$tmp" || true
  chmod 640 "$tmp"
  getent group "$PAYROLL_USER" >/dev/null && chgrp "$PAYROLL_USER" "$tmp"
  mv -f "$tmp" "$PAYROLL_ENV_FILE"
}

app_port() { local p; p="$(env_get PORT)"; echo "${p:-5000}"; }

node_bin() { echo "$PAYROLL_NODE_DIR/bin/node"; }
npm_bin() { echo "$PAYROLL_NODE_DIR/bin/npm"; }

# Run a command as the payroll user with our Node on PATH.
as_payroll() {
  runuser -u "$PAYROLL_USER" -- env HOME="$PAYROLL_DATA" PATH="$PAYROLL_NODE_DIR/bin:/usr/local/bin:/usr/bin:/bin" \
    npm_config_cache="$PAYROLL_DATA/.npm" npm_config_update_notifier=false npm_config_fund=false npm_config_audit=false "$@"
}

# ── Git access (public repo, token or deploy key) ─────────────────────────────
# Runs git with stored credentials. The token travels in the environment (not argv,
# which other local users could read with ps).
_git_auth() {
  local tok="$PAYROLL_ETC/github-token" b64=""
  if [[ -s "$tok" ]]; then
    b64="$(printf 'x-access-token:%s' "$(tr -d '\r\n' <"$tok")" | base64 -w0)"
    GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0="http.https://github.com/.extraheader" GIT_CONFIG_VALUE_0="Authorization: Basic $b64" \
      GIT_TERMINAL_PROMPT=0 GIT_SSH_COMMAND="$(_git_ssh)" git -c safe.directory='*' "$@"
  else
    GIT_TERMINAL_PROMPT=0 GIT_SSH_COMMAND="$(_git_ssh)" git -c safe.directory='*' "$@"
  fi
}
_git_ssh() {
  if [[ -s "$PAYROLL_ETC/deploy_key" ]]; then
    echo "ssh -i $PAYROLL_ETC/deploy_key -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=$PAYROLL_ETC/known_hosts"
  else
    echo "ssh -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=$PAYROLL_ETC/known_hosts"
  fi
}

# git_repo <args...>  -- git on the mirror clone with stored credentials.
git_repo() { _git_auth -C "$PAYROLL_REPO_DIR" "$@"; }

# git_anywhere <args...> -- same auth, no -C (for clone / ls-remote).
git_anywhere() { _git_auth "$@"; }

# ── Releases ──────────────────────────────────────────────────────────────────
current_release() { [[ -L "$PAYROLL_CURRENT" ]] && readlink -f "$PAYROLL_CURRENT" || true; }
release_sha() { [[ -n "${1:-}" && -f "$1/.release-sha" ]] && cat "$1/.release-sha" || true; }

# build_release <git-ref>  -> prints the new release directory on the last line of stdout.
# Exports the ref from the mirror clone, installs deps and builds as the payroll user.
build_release() {
  local ref="$1" sha stamp dir log
  sha="$(git_repo rev-parse --verify "$ref^{commit}")" || die "Unknown version: $ref"
  stamp="$(date -u +%Y%m%d%H%M%S)"
  dir="$PAYROLL_RELEASES/$stamp-${sha:0:7}"
  log="$PAYROLL_LOGS/build-$stamp.log"
  mkdir -p "$dir" "$PAYROLL_LOGS"
  git_repo archive "$sha" | tar -x -C "$dir"
  echo "$sha" >"$dir/.release-sha"
  chown -R "$PAYROLL_USER:$PAYROLL_USER" "$dir"
  info "Installing dependencies (this can take a few minutes)…" >&2
  if ! (cd "$dir" && as_payroll npm ci --no-audit --no-fund --loglevel=error) >>"$log" 2>&1; then
    tail -n 30 "$log" >&2; rm -rf "$dir"; die "Installing dependencies failed. Full log: $log"
  fi
  info "Building the app…" >&2
  if ! (cd "$dir" && as_payroll npm run build) >>"$log" 2>&1; then
    tail -n 30 "$log" >&2; rm -rf "$dir"; die "Build failed. Full log: $log"
  fi
  # Trim dev dependencies to keep the release small; ignore failures (build is done).
  (cd "$dir" && as_payroll npm prune --omit=dev --no-audit --no-fund --loglevel=error) >>"$log" 2>&1 || true
  [[ -f "$dir/dist/index.cjs" ]] || { rm -rf "$dir"; die "Build produced no dist/index.cjs. Full log: $log"; }
  chown -R root:root "$dir"
  chmod -R a+rX,go-w "$dir"
  echo "$dir"
}

# Point current at a release (atomic) and remember the old one as previous.
activate_release() {
  local dir="$1" old
  old="$(current_release)"
  ln -sfn "$dir" "$PAYROLL_ROOT/.current.tmp" && mv -Tf "$PAYROLL_ROOT/.current.tmp" "$PAYROLL_CURRENT"
  if [[ -n "$old" && "$old" != "$dir" ]]; then
    ln -sfn "$old" "$PAYROLL_ROOT/.previous.tmp" && mv -Tf "$PAYROLL_ROOT/.previous.tmp" "$PAYROLL_PREVIOUS"
  fi
  install_deploy_tools "$dir"
}

# Copy deploy/ from a release to /opt/payroll/deploy and refresh the CLI link + units.
install_deploy_tools() {
  local dir="$1"
  [[ -d "$dir/deploy" ]] || return 0
  rm -rf "$PAYROLL_ROOT/.deploy.new"
  cp -a "$dir/deploy" "$PAYROLL_ROOT/.deploy.new"
  rm -rf "$PAYROLL_ROOT/deploy.old"
  [[ -d "$PAYROLL_ROOT/deploy" ]] && mv "$PAYROLL_ROOT/deploy" "$PAYROLL_ROOT/deploy.old"
  mv "$PAYROLL_ROOT/.deploy.new" "$PAYROLL_ROOT/deploy"
  rm -rf "$PAYROLL_ROOT/deploy.old"
  chmod 755 "$PAYROLL_ROOT/deploy/payroll" 2>/dev/null || true
  ln -sfn "$PAYROLL_ROOT/deploy/payroll" /usr/local/bin/payroll
  install_units
}

install_units() {
  local src="$PAYROLL_ROOT/deploy/systemd" changed=0 f
  [[ -d "$src" ]] || return 0
  for f in "$src"/*.service "$src"/*.timer "$src"/*.path; do
    [[ -e "$f" ]] || continue
    if ! cmp -s "$f" "/etc/systemd/system/$(basename "$f")"; then
      install -m 644 "$f" "/etc/systemd/system/$(basename "$f")"; changed=1
    fi
  done
  if [[ $changed == 1 ]] && has_systemd; then systemctl daemon-reload; fi
}

prune_releases() {
  local keep="$PAYROLL_KEEP_RELEASES" cur prev d n=0
  cur="$(current_release)"; prev=""
  [[ -L "$PAYROLL_PREVIOUS" ]] && prev="$(readlink -f "$PAYROLL_PREVIOUS")"
  while IFS= read -r d; do
    [[ "$d" == "$cur" || "$d" == "$prev" ]] && continue
    n=$((n + 1))
    (( n > keep - 2 )) && rm -rf "$d"
  done < <(find "$PAYROLL_RELEASES" -mindepth 1 -maxdepth 1 -type d | sort -r)
}

# ── Service health ────────────────────────────────────────────────────────────
health_ok() {
  curl -fsS --max-time 4 "http://127.0.0.1:$(app_port)/api/health" 2>/dev/null | grep -q '"ok":true'
}

# wait_healthy [seconds]
wait_healthy() {
  local t="${1:-60}" i
  for ((i = 0; i < t; i++)); do
    health_ok && return 0
    sleep 1
  done
  return 1
}

restart_app() {
  if has_systemd; then systemctl restart payroll.service
  else warn "systemd is not running; start the app manually."; fi
}

# Snapshot DATA_DIR before risky changes. Prints the archive path.
snapshot_data() {
  local reason="${1:-manual}" f
  mkdir -p "$PAYROLL_BACKUPS"; chmod 700 "$PAYROLL_BACKUPS"
  f="$PAYROLL_BACKUPS/data-$(date -u +%Y%m%d-%H%M%S)-$reason.tar.gz"
  # SQLite in WAL mode: copy with sqlite3 .backup when available for a consistent snapshot.
  local tmp; tmp="$(mktemp -d)"
  cp -a "$PAYROLL_DATA/." "$tmp/" 2>/dev/null || true
  rm -rf "$tmp/backups" "$tmp/.npm"
  if command -v sqlite3 >/dev/null; then
    local db
    while IFS= read -r db; do
      rm -f "$tmp/${db#"$PAYROLL_DATA"/}-wal" "$tmp/${db#"$PAYROLL_DATA"/}-shm"
      sqlite3 "$db" ".backup '$tmp/${db#"$PAYROLL_DATA"/}'" 2>/dev/null || true
    done < <(find "$PAYROLL_DATA" -maxdepth 2 -type f -name '*.db' -not -path '*/backups/*')
  fi
  tar -czf "$f" -C "$tmp" .
  rm -rf "$tmp"
  chmod 600 "$f"
  ls -1t "$PAYROLL_BACKUPS"/data-*.tar.gz 2>/dev/null | tail -n +11 | xargs -r rm -f
  echo "$f"
}

write_status() {
  # write_status state from to message
  # Built in the root-owned parent folder and renamed into place: the app user owns
  # DATA_DIR, so writing/chowning a temp file there would follow planted symlinks.
  local f="$PAYROLL_DATA/update-status.json" tmp msg="${4:-}"
  msg="${msg//\\/\\\\}"; msg="${msg//\"/\\\"}"; msg="$(printf '%s' "$msg" | tr '\000-\037' ' ')"
  tmp="$(mktemp "$(dirname "$PAYROLL_DATA")/.payroll-status.XXXXXX")" || return 0
  printf '{"state":"%s","from":"%s","to":"%s","at":"%s","message":"%s"}\n' \
    "$1" "${2:-}" "${3:-}" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$msg" >"$tmp"
  chmod 644 "$tmp"; mv -f "$tmp" "$f"
}

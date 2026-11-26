#!/usr/bin/env bash
# Payroll — one-command installer for Debian / Ubuntu.
#
#   From a copy of the repository:   sudo ./deploy/install.sh
#   Straight from GitHub:            curl -fsSL <raw install.sh URL> | sudo bash -s -- --token <github token>
#
# Safe to run again: it repairs or upgrades an existing install and keeps your data.
# Run with --help for all options.
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || echo /nonexistent)"

usage() {
  cat <<'EOF'
Usage: sudo ./deploy/install.sh [options]

  --repo URL           Git URL of the app (default: this checkout's origin)
  --branch NAME        Branch to install and follow for updates (default: main)
  --ref REF            Install a specific commit or tag (updates still follow --branch)
  --token TOKEN        GitHub token with read access, for a private repository
                       (or set PAYROLL_GITHUB_TOKEN)
  --deploy-key         Use an SSH deploy key for a private repository instead of a token
  --port N             Local port for the app (default: 5000)
  --lan                Also allow access from other computers on your network
                       (default: only this machine and the Cloudflare Tunnel)
  --admin-user NAME    First administrator's username (default: admin)
                       The password is asked for, or read from PAYROLL_ADMIN_PASSWORD.
  --tunnel-token TOKEN Set up a Cloudflare Tunnel with this token (or CF_TUNNEL_TOKEN)
  --no-tunnel          Skip the Cloudflare Tunnel step
  --no-auto-update     Do not turn on automatic updates
  --yes, -y            Accept defaults, ask nothing (for scripts)
  -h, --help           Show this help
EOF
}

# ── Arguments ─────────────────────────────────────────────────────────────────
ARG_REPO="" ARG_BRANCH="" ARG_REF="" ARG_PORT="" ARG_LAN=0 ARG_NO_TUNNEL=0 ARG_NO_AUTO=0 ARG_DEPLOY_KEY=0
ARG_ADMIN_USER="${PAYROLL_ADMIN_USER:-}"
ORIG_ARGS=("$@")
while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo) ARG_REPO="${2:?}"; shift 2 ;;
    --branch) ARG_BRANCH="${2:?}"; shift 2 ;;
    --ref) ARG_REF="${2:?}"; shift 2 ;;
    --token) PAYROLL_GITHUB_TOKEN="${2:?}"; shift 2 ;;
    --deploy-key) ARG_DEPLOY_KEY=1; shift ;;
    --port) ARG_PORT="${2:?}"; shift 2 ;;
    --lan) ARG_LAN=1; shift ;;
    --admin-user) ARG_ADMIN_USER="${2:?}"; shift 2 ;;
    --tunnel-token) CF_TUNNEL_TOKEN="${2:?}"; export CF_TUNNEL_TOKEN; shift 2 ;;
    --no-tunnel) ARG_NO_TUNNEL=1; shift ;;
    --no-auto-update) ARG_NO_AUTO=1; shift ;;
    -y|--yes) export PAYROLL_NONINTERACTIVE=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1 (see --help)" >&2; exit 2 ;;
  esac
done
PAYROLL_GITHUB_TOKEN="${PAYROLL_GITHUB_TOKEN:-}"

# ── Bootstrap: running without the repository (curl | bash) ──────────────────
if [[ ! -f "$SCRIPT_DIR/lib/common.sh" ]]; then
  [[ $EUID -eq 0 ]] || { echo "Please run as root (sudo)." >&2; exit 1; }
  echo "==> Fetching the Payroll installer…"
  export DEBIAN_FRONTEND=noninteractive
  command -v git >/dev/null || { apt-get update -qq && apt-get install -y -qq git ca-certificates >/dev/null; }
  repo="${ARG_REPO:-https://github.com/ThanapatLucksanapirak/Payroll-Staff1Beta.git}"
  tmp="$(mktemp -d)"
  if [[ -n "$PAYROLL_GITHUB_TOKEN" ]]; then
    b64="$(printf 'x-access-token:%s' "$PAYROLL_GITHUB_TOKEN" | base64 -w0)"
    GIT_TERMINAL_PROMPT=0 GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0="http.https://github.com/.extraheader" \
      GIT_CONFIG_VALUE_0="Authorization: Basic $b64" git clone -q --depth 1 ${ARG_BRANCH:+--branch "$ARG_BRANCH"} "$repo" "$tmp/src" \
      || { echo "Could not download $repo with that token. Check it has read access to the repository." >&2; exit 1; }
  else
    GIT_TERMINAL_PROMPT=0 git clone -q --depth 1 ${ARG_BRANCH:+--branch "$ARG_BRANCH"} "$repo" "$tmp/src" \
      || { echo "Could not download $repo. If the repository is private, add --token <github token>." >&2; exit 1; }
  fi
  export PAYROLL_GITHUB_TOKEN
  [[ -n "$ARG_REPO" ]] || ORIG_ARGS+=(--repo "$repo")
  exec bash "$tmp/src/deploy/install.sh" "${ORIG_ARGS[@]}"
fi

# shellcheck source=deploy/lib/common.sh
. "$SCRIPT_DIR/lib/common.sh"
if [[ -f "$SCRIPT_DIR/lib/tunnel.sh" ]]; then
  # shellcheck source=deploy/lib/tunnel.sh
  . "$SCRIPT_DIR/lib/tunnel.sh"
fi
SRC_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"


banner() {
  printf '\n%s  Payroll%s  %sinstaller%s\n' "$C_BOLD" "$C_RESET" "$C_DIM" "$C_RESET"
  printf '  %s──────────────────────────────────%s\n' "$C_DIM" "$C_RESET"
}

# ── 1. Checks ─────────────────────────────────────────────────────────────────
preflight() {
  step "Checking this computer"
  require_root
  detect_os
  ok "$OS_PRETTY ($(uname -m))"
  has_systemd || die "systemd is not running. Install on a normal Debian/Ubuntu server or VM (not a bare container)."
  local free_mb mem_mb
  free_mb="$(df -Pm /opt | awk 'NR==2{print $4}')"
  (( free_mb >= 2048 )) || die "Need at least 2 GB free in /opt (found ${free_mb} MB)."
  ok "Disk space: $((free_mb / 1024)) GB free"
  mem_mb="$(awk '/MemTotal/{print int($2/1024)}' /proc/meminfo)"
  if (( mem_mb < 900 )); then
    warn "Only ${mem_mb} MB of memory. Building may be slow; adding swap is recommended."
  else ok "Memory: ${mem_mb} MB"; fi
  INSTALLED=0
  [[ -L "$PAYROLL_CURRENT" && -f "$PAYROLL_ENV_FILE" ]] && INSTALLED=1
  [[ $INSTALLED == 1 ]] && info "Existing install found; it will be repaired or upgraded and your data kept."
  return 0
}

# ── 2. System packages ────────────────────────────────────────────────────────
install_packages() {
  step "Installing system packages"
  export DEBIAN_FRONTEND=noninteractive
  local pkgs=(ca-certificates curl git sqlite3 tar xz-utils gnupg openssh-client build-essential python3 util-linux)
  local missing=() p
  for p in "${pkgs[@]}"; do dpkg-query -W -f='${Status}' "$p" 2>/dev/null | grep -q "ok installed" || missing+=("$p"); done
  if (( ${#missing[@]} )); then
    info "Adding: ${missing[*]}"
    apt-get update -qq
    apt-get install -y -qq --no-install-recommends "${missing[@]}" >"$PAYROLL_LOGS/apt.log" 2>&1 \
      || { tail -n 20 "$PAYROLL_LOGS/apt.log" >&2; die "Installing system packages failed."; }
  fi
  ok "System packages ready"
}

# ── 3. Node.js runtime (private copy, does not touch the system) ──────────────
install_node() {
  step "Installing Node.js $PAYROLL_NODE_MAJOR"
  if [[ -x "$(node_bin)" ]] && "$(node_bin)" -v 2>/dev/null | grep -q "^v${PAYROLL_NODE_MAJOR}\."; then
    ok "Node.js $("$(node_bin)" -v) already installed"; return 0
  fi
  local base="https://nodejs.org/dist/latest-v${PAYROLL_NODE_MAJOR}.x" tmp file sums ver
  tmp="$(mktemp -d)"
  sums="$(curl -fsSL --retry 3 "$base/SHASUMS256.txt")" || die "Could not reach nodejs.org to download Node.js."
  file="$(awk -v a="linux-${NODE_ARCH}.tar.xz" '$2 ~ a"$" {print $2}' <<<"$sums" | head -n1)"
  [[ -n "$file" ]] || die "No Node.js build found for linux-${NODE_ARCH}."
  info "Downloading $file"
  curl -fsSL --retry 3 -o "$tmp/$file" "$base/$file"
  (cd "$tmp" && grep " $file\$" <<<"$sums" | sha256sum -c --quiet -) || die "Node.js download failed its checksum. Try again."
  ver="${file%.tar.xz}"
  mkdir -p "$PAYROLL_ROOT/runtime"
  rm -rf "$PAYROLL_ROOT/runtime/$ver"
  tar -xJf "$tmp/$file" -C "$PAYROLL_ROOT/runtime"
  ln -sfn "$PAYROLL_ROOT/runtime/$ver" "$PAYROLL_NODE_DIR"
  rm -rf "$tmp"
  ok "Node.js $("$(node_bin)" -v) installed"
}

# ── 4. Service account and folders ────────────────────────────────────────────
setup_user_dirs() {
  step "Creating the service account and folders"
  if ! id "$PAYROLL_USER" >/dev/null 2>&1; then
    useradd --system --home-dir "$PAYROLL_DATA" --shell /usr/sbin/nologin --user-group "$PAYROLL_USER"
  fi
  install -d -m 755 "$PAYROLL_ROOT" "$PAYROLL_RELEASES"
  install -d -m 750 -o "$PAYROLL_USER" -g "$PAYROLL_USER" "$PAYROLL_DATA"
  install -d -m 750 -o root -g "$PAYROLL_USER" "$PAYROLL_ETC"
  install -d -m 700 "$PAYROLL_BACKUPS"
  install -d -m 750 "$PAYROLL_LOGS"
  ok "User '$PAYROLL_USER', data in $PAYROLL_DATA"
}

# ── 5. Source code access ─────────────────────────────────────────────────────
choose_repo() {
  REPO_URL="$(env_get REPO_URL)"
  [[ -n "$ARG_REPO" ]] && REPO_URL="$ARG_REPO"
  if [[ -z "$REPO_URL" ]]; then
    REPO_URL="$(git -c safe.directory='*' -C "$SRC_DIR" remote get-url origin 2>/dev/null || true)"
    # Strip any credentials embedded in the URL.
    REPO_URL="$(sed -E 's#(https?://)[^/@]+@#\1#' <<<"$REPO_URL")"
  fi
  REPO_URL="${REPO_URL:-$PAYROLL_DEFAULT_REPO}"
  BRANCH="${ARG_BRANCH:-$(env_get BRANCH)}"; BRANCH="${BRANCH:-main}"
}

can_reach_repo() { git_anywhere ls-remote --exit-code -h "$REPO_URL" "$BRANCH" >/dev/null 2>&1; }

https_to_ssh() {
  # Only GitHub https URLs are converted; anything else is returned unchanged.
  if [[ "$1" =~ ^https://github\.com/([^/]+)/([^/]+)/*$ ]]; then
    local repo="${BASH_REMATCH[2]%.git}"
    echo "git@github.com:${BASH_REMATCH[1]}/$repo.git"
  else
    echo "$1"
  fi
}

setup_repo_access() {
  step "Connecting to the app's source code"
  info "$REPO_URL ($BRANCH)"
  if [[ -n "$PAYROLL_GITHUB_TOKEN" ]]; then
    umask 077; printf '%s\n' "$PAYROLL_GITHUB_TOKEN" >"$PAYROLL_ETC/github-token"; umask 022
    chmod 600 "$PAYROLL_ETC/github-token"
  fi
  if [[ $ARG_DEPLOY_KEY == 1 && "$REPO_URL" == https://github.com/* ]]; then REPO_URL="$(https_to_ssh "$REPO_URL")"; fi
  if can_reach_repo; then ok "Repository reachable"; return 0; fi

  # Private repository: offer a token or a deploy key.
  warn "The repository is private, so this server needs read-only access to it."
  local how=""
  if [[ $ARG_DEPLOY_KEY == 1 ]]; then how=2; else
    info "1) Paste a GitHub token (fine-grained, read-only 'Contents' on this repository)"
    info "2) Create a deploy key here and add it on GitHub (no token needed)"
    ask how "Choose 1 or 2" "1"
  fi
  if [[ "$how" == 2 ]]; then
    if [[ ! -s "$PAYROLL_ETC/deploy_key" ]]; then
      ssh-keygen -q -t ed25519 -N "" -C "payroll@$(hostname)" -f "$PAYROLL_ETC/deploy_key"
    fi
    REPO_URL="$(https_to_ssh "$REPO_URL")"
    local slug; slug="$(sed -E 's#^git@github.com:(.+)\.git$#\1#' <<<"$REPO_URL")"
    printf '\n    Add this key at %shttps://github.com/%s/settings/keys/new%s\n' "$C_BOLD" "$slug" "$C_RESET"
    printf '    (title: payroll server, leave "Allow write access" unticked)\n\n    %s\n\n' "$(cat "$PAYROLL_ETC/deploy_key.pub")"
    local i
    for i in 1 2 3 4 5; do
      local _go=""; ask _go "Press Enter once the key is added" ""
      can_reach_repo && { ok "Repository reachable with the deploy key"; return 0; }
      [[ "${PAYROLL_NONINTERACTIVE:-0}" == 1 ]] && break
      warn "Still no access (attempt $i). Check the key was saved on the right repository."
    done
    die "Could not reach the repository with the deploy key."
  else
    local tok=""
    ask_secret tok "GitHub token"
    [[ -n "$tok" ]] || die "No token given. Create one at https://github.com/settings/personal-access-tokens/new and run the installer again with --token."
    umask 077; printf '%s\n' "$tok" >"$PAYROLL_ETC/github-token"; umask 022
    can_reach_repo || die "That token cannot read $REPO_URL. Give it 'Contents: Read-only' on this repository."
    ok "Repository reachable with the token"
  fi
}

sync_repo() {
  if [[ ! -d "$PAYROLL_REPO_DIR/.git" ]]; then
    info "Downloading the source code…"
    # Seed from the local checkout when we have one (fast, works offline), then point at the real origin.
    if [[ -d "$SRC_DIR/.git" ]]; then
      git -c safe.directory='*' clone -q --no-hardlinks "$SRC_DIR" "$PAYROLL_REPO_DIR"
      git -C "$PAYROLL_REPO_DIR" remote set-url origin "$REPO_URL"
    else
      git_anywhere clone -q "$REPO_URL" "$PAYROLL_REPO_DIR"
    fi
  else
    git_repo remote set-url origin "$REPO_URL"
  fi
  git_repo fetch -q --prune origin "+refs/heads/$BRANCH:refs/remotes/origin/$BRANCH" \
    || die "Could not download updates from $REPO_URL."
  ok "Source code up to date ($(git_repo rev-parse --short "origin/$BRANCH"))"
}

# ── 6. Settings ───────────────────────────────────────────────────────────────
write_env() {
  step "Writing settings"
  local port host
  port="${ARG_PORT:-$(env_get PORT)}"; port="${port:-5000}"
  [[ "$port" =~ ^[0-9]+$ ]] || die "Port must be a number."
  if [[ $INSTALLED == 0 ]] && ss -ltn "( sport = :$port )" 2>/dev/null | grep -q LISTEN; then
    die "Port $port is already in use. Pick another with --port."
  fi
  host="$(env_get HOST)"
  if [[ $ARG_LAN == 1 ]]; then host=0.0.0.0; fi
  host="${host:-127.0.0.1}"
  env_set NODE_ENV production
  env_set HOST "$host"
  env_set PORT "$port"
  env_set DATA_DIR "$PAYROLL_DATA"
  env_set PAYROLL_MANAGED 1
  [[ -n "$(env_get TRUST_PROXY)" ]] || env_set TRUST_PROXY loopback
  env_set REPO_URL "$REPO_URL"
  env_set BRANCH "$BRANCH"
  [[ -n "$(env_get AUTO_UPDATE)" ]] || env_set AUTO_UPDATE 1
  [[ $ARG_NO_AUTO == 1 ]] && env_set AUTO_UPDATE 0
  # Pre-set the one-time setup code so only someone on this machine can create the first admin.
  if [[ ! -s "$PAYROLL_DATA/setup-code.txt" && -z "$(env_get SETUP_CODE)" ]]; then
    env_set SETUP_CODE "$(head -c 18 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 12)"
  fi
  chmod 640 "$PAYROLL_ENV_FILE"; chgrp "$PAYROLL_USER" "$PAYROLL_ENV_FILE"
  if [[ "$host" == 0.0.0.0 ]]; then ok "App listens on port $port (local network allowed)"
  else ok "App listens on 127.0.0.1:$port (private; reach it from outside through the tunnel)"; fi
}

# ── 7. Build and start ────────────────────────────────────────────────────────
build_and_start() {
  local target cur_sha want dir
  target="${ARG_REF:-origin/$BRANCH}"
  want="$(git_repo rev-parse --verify "$target^{commit}")" || die "Unknown version: $target"
  cur_sha="$(release_sha "$(current_release)")"
  if [[ "$cur_sha" == "$want" && -f "$(current_release)/dist/index.cjs" ]]; then
    step "App is already at ${want:0:7}"
    install_deploy_tools "$(current_release)"
  else
    step "Building the app (${want:0:7})"
    if [[ $INSTALLED == 1 ]]; then
      snap="$(snapshot_data pre-install | tail -n1)" && [[ -n "$snap" ]] || die "Could not back up the current data, so nothing was changed."
      info "Saved a backup first: $snap"
    fi
    dir="$(build_release "$want" | tail -n1)"
    activate_release "$dir"
    ok "Built $(basename "$dir")"
  fi
  # Versions from before the installer existed have no deploy/ folder: use this installer's copy.
  [[ -d "$PAYROLL_CURRENT/deploy" ]] || install_deploy_tools "$SRC_DIR"
  # The CLI and units from the release we just activated.
  install_units
  systemctl enable -q payroll.service
  systemctl reset-failed payroll.service 2>/dev/null || true
  systemctl restart payroll.service
  info "Starting…"
  if ! wait_healthy 90; then
    show_start_error
    if [[ -L "$PAYROLL_PREVIOUS" ]]; then
      warn "The new version did not start. Going back to the previous one."
      activate_release "$(readlink -f "$PAYROLL_PREVIOUS")"
      # The crashing version used up systemd's start limit; clear it first.
      systemctl reset-failed payroll.service 2>/dev/null || true
      systemctl restart payroll.service
      wait_healthy 60 && die "Rolled back to the previous version, which is running. The newest version will be tried again when a fix is published."
    elif try_older_versions "$want"; then
      return 0
    fi
    die "The app did not start. The reason is shown above (full log: sudo payroll logs)."
  fi
  ok "App is running"
  prune_releases
}

# Nothing to roll back to (first install, or reinstall after uninstall) and the
# newest commit doesn't start: try the few commits before it instead.
try_older_versions() {
  local bad="$1" c dir
  for c in $(git_repo rev-list --first-parent --skip=1 --max-count=3 "$bad" 2>/dev/null); do
    warn "Trying the version before it (${c:0:7})…"
    if ! dir="$(build_release "$c" | tail -n1)" || [[ ! -f "$dir/dist/index.cjs" ]]; then continue; fi
    activate_release "$dir"
    systemctl reset-failed payroll.service 2>/dev/null || true
    systemctl restart payroll.service
    if wait_healthy 90; then
      echo "$bad" >"$PAYROLL_ROOT/.update-skip"   # automatic updates skip the broken one
      warn "Installed ${c:0:7} instead, because the newest version (${bad:0:7}) did not start. Automatic updates will move to a newer version once one is published."
      ok "App is running"
      prune_releases
      return 0
    fi
  done
  return 1
}

# ── 8. First administrator (done here, on this machine, before going online) ──
setup_required() {
  curl -fsS --max-time 5 "http://127.0.0.1:$(app_port)/api/auth/status" 2>/dev/null | grep -q '"setupRequired":true'
}

setup_code() {
  if [[ -s "$PAYROLL_DATA/setup-code.txt" ]]; then tr -d '\r\n' <"$PAYROLL_DATA/setup-code.txt"; else env_get SETUP_CODE; fi
}

create_admin() {
  setup_required || { step "Administrator account"; ok "Already set up"; return 0; }
  step "Creating your administrator account"
  local user pw pw2 json code status
  user="${ARG_ADMIN_USER:-}"; ask user "Username" "admin"
  pw="${PAYROLL_ADMIN_PASSWORD:-}"
  while [[ -z "$pw" ]]; do
    if [[ "${PAYROLL_NONINTERACTIVE:-0}" == 1 ]] || ! { : </dev/tty; } 2>/dev/null; then
      warn "No password given (set PAYROLL_ADMIN_PASSWORD to do this unattended)."
      info "Finish setup in a browser on this machine with the one-time code: $(setup_code)"
      return 0
    fi
    ask_secret pw "Password (at least 8 characters)"
    ask_secret pw2 "Repeat password"
    if [[ ${#pw} -lt 8 ]]; then warn "Too short."; pw=""; continue; fi
    if [[ "$pw" != "$pw2" ]]; then warn "Passwords did not match."; pw=""; fi
  done

  # Preferred: the app's own CLI (multi-user builds). Fallback: the one-time-code setup API.
  if grep -q -- "--password-stdin" "$PAYROLL_CURRENT/dist/index.cjs" 2>/dev/null; then
    # shellcheck disable=SC1090
    if (set -a; . "$PAYROLL_ENV_FILE"; set +a; cd "$PAYROLL_CURRENT" \
          && printf '%s\n' "$pw" | as_payroll timeout 60 "$(node_bin)" dist/index.cjs admin create --username "$user" --password-stdin) \
          >>"$PAYROLL_LOGS/install.log" 2>&1; then
      env_unset SETUP_CODE
      # The running app caches its user list; restart so it sees the new account.
      systemctl restart payroll.service; wait_healthy 60 || true
      ok "Administrator '$user' created"; return 0
    fi
  fi
  code="$(setup_code)"
  json="$(P="$pw" U="$user" C="$code" "$(node_bin)" -e 'process.stdout.write(JSON.stringify({username:process.env.U,displayName:process.env.U,password:process.env.P,setupCode:process.env.C}))')"
  status="$(curl -sS -o /tmp/payroll-setup.$$ -w '%{http_code}' --max-time 15 -H 'Content-Type: application/json' -H 'X-Requested-With: payroll' \
    --data-binary @- "http://127.0.0.1:$(app_port)/api/auth/setup" <<<"$json" || true)"
  if [[ "$status" =~ ^2 ]]; then
    ok "Administrator account created"
    env_unset SETUP_CODE
  else
    warn "Could not create the administrator automatically (HTTP $status): $(head -c 300 /tmp/payroll-setup.$$ 2>/dev/null)"
    info "Open the app on this machine and use the one-time setup code: $code"
  fi
  rm -f /tmp/payroll-setup.$$
}

# ── 9. Automatic updates and the in-app "Update now" button ───────────────────
setup_updates() {
  step "Updates"
  local f
  for f in payroll-update.path payroll-update.timer; do
    [[ -f "/etc/systemd/system/$f" ]] || { warn "$f is missing from this version; skipping."; return 0; }
  done
  systemctl enable -q --now payroll-update.path
  if [[ "$(env_get AUTO_UPDATE)" == 1 && $INSTALLED == 0 && $ARG_NO_AUTO == 0 ]]; then
    confirm "Install new versions automatically (checked every 10 minutes, with automatic rollback)?" y || env_set AUTO_UPDATE 0
  fi
  if [[ "$(env_get AUTO_UPDATE)" == 1 ]]; then
    systemctl enable -q --now payroll-update.timer; ok "Automatic updates on (turn off: sudo payroll auto-update off)"
  else
    systemctl disable -q --now payroll-update.timer 2>/dev/null || true; ok "Automatic updates off (update any time: sudo payroll update)"
  fi
}

# ── 10. Cloudflare Tunnel ─────────────────────────────────────────────────────
setup_tunnel() {
  [[ $ARG_NO_TUNNEL == 1 ]] && return 0
  declare -F cf_setup_interactive >/dev/null || { warn "Tunnel helper missing in this version; skipping."; return 0; }
  if [[ -n "$(env_get TUNNEL_MODE)" && -z "${CF_TUNNEL_TOKEN:-}" ]]; then
    step "Cloudflare Tunnel"; ok "Already configured ($(env_get TUNNEL_MODE) mode)"; return 0
  fi
  if setup_required; then
    warn "Skipping the tunnel: create the administrator account first, then run: sudo payroll tunnel setup"
    return 0
  fi
  step "Cloudflare Tunnel (reach Payroll from anywhere)"
  cf_setup_interactive || warn "Tunnel setup did not finish. Try again with: sudo payroll tunnel setup"
  # The app reads APP_HOST / KIOSK_HOST at start-up.
  systemctl restart payroll.service; wait_healthy 60 || true
}

summary() {
  local port app_host kiosk_host lan
  port="$(app_port)"; app_host="$(env_get APP_HOST)"; kiosk_host="$(env_get KIOSK_HOST)"
  printf '\n%s  ✓ Payroll is installed%s\n\n' "$C_GREEN$C_BOLD" "$C_RESET"
  [[ -n "$app_host" ]] && printf '    Admin      https://%s\n' "$app_host"
  [[ -n "$kiosk_host" ]] && printf '    Kiosk      https://%s\n' "$kiosk_host"
  printf '    On this machine   http://127.0.0.1:%s   (kiosk: /kiosk)\n' "$port"
  if [[ "$(env_get HOST)" == 0.0.0.0 ]]; then
    lan="$(hostname -I 2>/dev/null | awk '{print $1}')"
    [[ -n "$lan" ]] && printf '    On your network   http://%s:%s\n' "$lan" "$port"
  fi
  if setup_required; then printf '\n    One-time setup code: %s%s%s\n' "$C_BOLD" "$(setup_code)" "$C_RESET"; fi
  cat <<EOF

    Useful commands
      payroll status          how everything is doing
      sudo payroll update     install the newest version now
      sudo payroll backup     save a backup of your data
      sudo payroll tunnel setup   connect a Cloudflare Tunnel
      payroll help            everything else

EOF
}

main() {
  trap 'die "Installation stopped (line $LINENO). Fix the problem above and run the installer again; it picks up where it left off."' ERR
  banner
  preflight
  install_packages
  install_node
  setup_user_dirs
  choose_repo
  setup_repo_access
  sync_repo
  write_env
  build_and_start
  create_admin
  setup_updates
  setup_tunnel
  summary
}

mkdir -p "$PAYROLL_LOGS" 2>/dev/null || true
main 2>&1 | tee -a "$PAYROLL_LOGS/install.log"
exit "${PIPESTATUS[0]}"

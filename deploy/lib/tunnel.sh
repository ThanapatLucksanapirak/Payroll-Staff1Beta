#!/usr/bin/env bash
# Cloudflare Tunnel setup for the Payroll installer and the `payroll tunnel` CLI.
# Sourced, never executed. Requires deploy/lib/common.sh to be sourced first.
#
# Public functions:
#   cf_install_cloudflared   install cloudflared from Cloudflare's apt repo (idempotent)
#   cf_setup_interactive     friendly wizard (token mode or locally-managed mode)
#   cf_status                compact human summary
#   cf_remove                stop/uninstall the tunnel service and forget settings
#
# Non-interactive: CF_TUNNEL_TOKEN (token or pasted install command), CF_APP_HOST, CF_KIOSK_HOST.
# The tunnel only ever points at 127.0.0.1:<PORT>; this file never opens firewall ports.
# shellcheck source=common.sh
# shellcheck disable=SC1091

CF_ETC="${CF_ETC:-/etc/cloudflared}"
CF_CONFIG="$CF_ETC/config.yml"
CF_KEYRING="/usr/share/keyrings/cloudflare-main.gpg"
CF_APT_LIST="/etc/apt/sources.list.d/cloudflared.list"
CF_MARKER="$CF_ETC/.created-by-payroll"

# ── Small helpers ─────────────────────────────────────────────────────────────
cf_have() { command -v cloudflared >/dev/null 2>&1; }

cf_unit_exists() {
  [[ -f /etc/systemd/system/cloudflared.service ]] \
    || systemctl list-unit-files cloudflared.service --no-legend 2>/dev/null | grep -q cloudflared
}

cf_service_state() {
  if ! has_systemd; then echo "no-systemd"; return 0; fi
  systemctl is-active cloudflared 2>/dev/null || true
}

# cf_extract_token "<pasted text>" -> prints the token (or nothing).
# Accepts a bare token or a whole pasted command such as
#   sudo cloudflared service install eyJhIjoi...
#   cloudflared tunnel run --token eyJhIjoi...
cf_extract_token() {
  local s="$1"
  s="${s//$'\r'/}"; s="${s//$'\n'/ }"
  s="${s//\"/ }"; s="${s//\'/ }"
  printf '%s\n' "$s" | grep -oE 'eyJ[A-Za-z0-9+/_=-]{20,}' | tail -n1 || true
}

# cf_token_json <token> -> prints the decoded JSON (empty on failure).
cf_token_json() {
  local t="$1" pad
  t="${t//-/+}"; t="${t//_//}"
  pad=$(( (4 - ${#t} % 4) % 4 ))
  if (( pad == 3 )); then return 0; fi
  (( pad > 0 )) && t="$t$(printf '%*s' "$pad" '' | tr ' ' '=')"
  printf '%s' "$t" | base64 -d 2>/dev/null || true
}

# cf_token_valid <token> -> 0 if it looks like a Cloudflare tunnel token
# (base64 JSON with "a" account tag, "t" tunnel id, "s" secret).
cf_token_valid() {
  local j
  [[ "$1" =~ ^eyJ[A-Za-z0-9+/_=-]{20,}$ ]] || return 1
  j="$(cf_token_json "$1")"
  [[ "$j" == \{*\} ]] || return 1
  grep -qE '"a"[[:space:]]*:[[:space:]]*"[^"]+"' <<<"$j" \
    && grep -qE '"t"[[:space:]]*:[[:space:]]*"[0-9a-fA-F-]{36}"' <<<"$j" \
    && grep -qE '"s"[[:space:]]*:[[:space:]]*"[^"]+"' <<<"$j"
}

# cf_token_tunnel_id <token> -> tunnel UUID from the token.
cf_token_tunnel_id() {
  cf_token_json "$1" | grep -oE '"t"[[:space:]]*:[[:space:]]*"[^"]+"' | sed -E 's/.*"([^"]+)"$/\1/'
}

# cf_clean_host "<input>" -> lowercase hostname without scheme/path, or empty.
cf_clean_host() {
  local h="${1,,}"
  h="${h#http://}"; h="${h#https://}"; h="${h%%/*}"; h="${h%%:*}"
  h="${h//[[:space:]]/}"
  if [[ -z "$h" ]]; then return 0; fi
  if [[ "$h" =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$ ]]; then
    printf '%s\n' "$h"
  else
    warn "\"$1\" does not look like a hostname (example: payroll.example.com); ignoring it."
  fi
}

cf_interactive() {
  [[ "${PAYROLL_NONINTERACTIVE:-0}" != 1 ]] && { : </dev/tty; } 2>/dev/null
}

# ── Install ───────────────────────────────────────────────────────────────────
cf_install_cloudflared() {
  if cf_have; then
    ok "cloudflared is already installed ($(cloudflared --version 2>/dev/null | head -n1))."
    return 0
  fi
  step "Installing cloudflared (Cloudflare Tunnel connector)"
  export DEBIAN_FRONTEND=noninteractive
  if ! command -v curl >/dev/null || [[ ! -s /etc/ssl/certs/ca-certificates.crt ]]; then
    apt-get update -qq || die "apt-get update failed."
    apt-get install -y -qq ca-certificates curl >/dev/null || die "Could not install curl."
  fi
  install -d -m 0755 /usr/share/keyrings
  local tmp; tmp="$(mktemp)"
  if ! curl -fsSL --retry 3 https://pkg.cloudflare.com/cloudflare-main.gpg -o "$tmp"; then
    rm -f "$tmp"; die "Could not download Cloudflare's signing key (https://pkg.cloudflare.com). Check internet access."
  fi
  # The key is published in binary form; dearmor if it ever comes ASCII-armored.
  if grep -q 'BEGIN PGP' "$tmp"; then
    command -v gpg >/dev/null || apt-get install -y -qq gnupg >/dev/null || die "Could not install gnupg."
    gpg --dearmor <"$tmp" >"$tmp.bin" && mv -f "$tmp.bin" "$tmp"
  fi
  install -m 0644 "$tmp" "$CF_KEYRING"; rm -f "$tmp"
  printf 'deb [signed-by=%s] https://pkg.cloudflare.com/cloudflared any main\n' "$CF_KEYRING" >"$CF_APT_LIST.tmp"
  chmod 644 "$CF_APT_LIST.tmp"; mv -f "$CF_APT_LIST.tmp" "$CF_APT_LIST"
  apt-get update -qq || die "apt-get update failed after adding the Cloudflare repository."
  apt-get install -y -qq cloudflared >/dev/null || die "Installing cloudflared failed."
  ok "Installed $(cloudflared --version 2>/dev/null | head -n1)."
}

# ── Service helpers ───────────────────────────────────────────────────────────
# Remove an existing cloudflared system service so `service install` can run again.
cf_uninstall_service() {
  if cf_have && cf_unit_exists; then
    cloudflared service uninstall >/dev/null 2>&1 || true
  fi
  if has_systemd && [[ -f /etc/systemd/system/cloudflared.service ]]; then
    systemctl disable --now cloudflared.service >/dev/null 2>&1 || true
    rm -f /etc/systemd/system/cloudflared.service
    systemctl daemon-reload
  fi
}

cf_start_service() {
  has_systemd || { warn "systemd is not running; start cloudflared manually."; return 0; }
  systemctl daemon-reload
  systemctl enable cloudflared.service >/dev/null 2>&1 || true
  systemctl restart cloudflared.service || warn "cloudflared did not start. See: journalctl -u cloudflared -n 50"
}

# ── Token mode ────────────────────────────────────────────────────────────────
cf_print_token_help() {
  local port; port="$(app_port)"
  cat <<EOF

    ${C_BOLD}Get a tunnel token from Cloudflare${C_RESET} (on any computer with a web browser):
      1. Log in at https://dash.cloudflare.com (your domain must already be on Cloudflare).
      2. Open the tunnels page. Depending on your dashboard version it is
         Zero Trust > Networks > Tunnels (or Connectors > Cloudflare Tunnels),
         or Networking > Tunnels in the main dashboard.
      3. Click "Create a tunnel", choose "Cloudflared", give it a name (e.g. payroll), save.
      4. On the install page pick "Debian" and copy the command shown
         (it looks like: sudo cloudflared service install eyJhIjoi...).
         You can paste the whole command here; we only keep the token.
      5. Then, in the tunnel's "Public Hostname" tab (newer dashboards: "Routes" >
         "Add route" > "Published application"), add:
           payroll.example.com  ->  HTTP  ->  localhost:${port}
           kiosk.example.com    ->  HTTP  ->  localhost:${port}   (optional, for the time clock)
         Use your own domain instead of example.com.

EOF
}

# cf_setup_token <token>
cf_setup_token() {
  local token="$1" tid
  cf_token_valid "$token" || die "That does not look like a Cloudflare tunnel token."
  tid="$(cf_token_tunnel_id "$token")"
  cf_install_cloudflared
  step "Connecting this server to your Cloudflare tunnel"
  info "Tunnel id: $tid"
  cf_uninstall_service
  # `cloudflared service install` only accepts the token as an argument. This runs as
  # root for a moment; cloudflared then stores it in its systemd unit (root-owned).
  if ! cloudflared service install "$token" >/dev/null 2>&1; then
    die "cloudflared could not install the service. Check the token and try: sudo payroll tunnel setup"
  fi
  cf_start_service
  env_set TUNNEL_MODE token
  ok "Tunnel service installed (token mode)."
}

# ── Locally-managed (config file) mode ────────────────────────────────────────
# cf_setup_config <admin-host> [kiosk-host]
cf_setup_config() {
  local app_host="$1" kiosk_host="${2:-}" name tid cred port
  port="$(app_port)"
  [[ -n "$app_host" ]] || die "An admin hostname is required in this mode."
  cf_install_cloudflared
  name="payroll-$(hostname -s 2>/dev/null || hostname)"

  step "Logging in to Cloudflare"
  if [[ -s /root/.cloudflared/cert.pem ]]; then
    ok "Already logged in (found /root/.cloudflared/cert.pem)."
  else
    info "cloudflared will print a link. Open it on ANY computer, log in, and pick your domain."
    info "This window continues by itself once you have authorized it."
    cloudflared tunnel login </dev/null || die "Cloudflare login did not complete. Run: sudo payroll tunnel setup"
  fi

  step "Creating tunnel \"$name\""
  tid="$(cf_tunnel_id_by_name "$name")"
  if [[ -n "$tid" ]]; then
    ok "Reusing existing tunnel $tid."
  else
    cloudflared tunnel create "$name" >/dev/null || die "Could not create the tunnel."
    tid="$(cf_tunnel_id_by_name "$name")"
    [[ -n "$tid" ]] || die "Tunnel was created but its id could not be read (cloudflared tunnel list)."
    ok "Created tunnel $tid."
  fi

  mkdir -p "$CF_ETC"; chmod 755 "$CF_ETC"
  cred="$CF_ETC/$tid.json"
  if [[ -s "/root/.cloudflared/$tid.json" ]]; then
    install -m 600 "/root/.cloudflared/$tid.json" "$cred"
  elif [[ ! -s "$cred" ]]; then
    # Tunnel exists but this machine lost the credentials file: fetch it again.
    cloudflared tunnel token --cred-file "$cred" "$tid" >/dev/null \
      || die "Credentials for tunnel $tid are missing and could not be fetched."
    chmod 600 "$cred"
  fi

  step "Pointing DNS at the tunnel"
  local h
  for h in "$app_host" ${kiosk_host:+"$kiosk_host"}; do
    if cloudflared tunnel route dns --overwrite-dns "$tid" "$h" >/dev/null 2>&1 \
       || cloudflared tunnel route dns "$tid" "$h" >/dev/null 2>&1; then
      ok "$h -> tunnel"
    else
      warn "Could not create the DNS record for $h. Add a CNAME $h -> $tid.cfargotunnel.com in Cloudflare DNS."
    fi
  done

  step "Writing $CF_CONFIG"
  {
    echo "# Written by the Payroll installer. Re-run: sudo payroll tunnel setup"
    echo "tunnel: $tid"
    echo "credentials-file: $cred"
    echo "ingress:"
    echo "  - hostname: $app_host"
    echo "    service: http://127.0.0.1:$port"
    if [[ -n "$kiosk_host" ]]; then
      echo "  - hostname: $kiosk_host"
      echo "    service: http://127.0.0.1:$port"
    fi
    echo "  - service: http_status:404"
  } >"$CF_CONFIG.tmp"
  chmod 644 "$CF_CONFIG.tmp"; mv -f "$CF_CONFIG.tmp" "$CF_CONFIG"
  cloudflared tunnel --config "$CF_CONFIG" ingress validate >/dev/null 2>&1 \
    || warn "cloudflared reports a problem with $CF_CONFIG (cloudflared tunnel --config $CF_CONFIG ingress validate)."
  touch "$CF_MARKER"

  step "Installing the tunnel service"
  cf_uninstall_service
  cloudflared --config "$CF_CONFIG" service install >/dev/null 2>&1 \
    || die "cloudflared could not install the service."
  cf_start_service
  env_set TUNNEL_MODE config
  ok "Tunnel service installed (locally-managed mode)."
}

# cf_tunnel_id_by_name <name> -> UUID or empty. Parses JSON without jq.
cf_tunnel_id_by_name() {
  cloudflared tunnel list --name "$1" -o json 2>/dev/null \
    | tr -d '\n ' | grep -oE '"id":"[0-9a-fA-F-]{36}"' | head -n1 | cut -d'"' -f4 || true
}

# ── Verify ────────────────────────────────────────────────────────────────────
cf_verify() {
  local host state code i
  step "Checking the tunnel"
  state="$(cf_service_state)"
  if [[ "$state" == active ]]; then ok "cloudflared service is running."
  elif [[ "$state" == no-systemd ]]; then warn "systemd is not running; cannot check the service."
  else warn "cloudflared service is $state. See: journalctl -u cloudflared -n 50"; fi

  host="$(env_get APP_HOST)"
  [[ -n "$host" ]] || { info "No admin hostname recorded; skipping the public check."; return 0; }
  info "Trying https://$host/api/health (new DNS can take a minute)…"
  for i in 1 2 3 4 5 6; do
    code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 8 "https://$host/api/health" 2>/dev/null || true)"
    [[ "$code" == 200 ]] && { ok "https://$host is reachable."; return 0; }
    (( i < 6 )) && sleep 10
  done
  case "$code" in
    502|504) warn "Cloudflare reached the tunnel but not the app (HTTP $code). Is it running? Try: payroll status" ;;
    530|1033) warn "Cloudflare cannot reach the tunnel (HTTP $code). Try: payroll tunnel status" ;;
    404) warn "The tunnel answered 404: the hostname is not routed to localhost:$(app_port) in the tunnel settings." ;;
    302|303|401|403) ok "https://$host answered HTTP $code (probably a Cloudflare Access login page). Looks connected." ;;
    000|"") warn "https://$host is not reachable yet (DNS may still be propagating). Check again later: payroll tunnel status" ;;
    *) warn "https://$host answered HTTP $code. Check again later: payroll tunnel status" ;;
  esac
  return 0
}

# ── Wizard ────────────────────────────────────────────────────────────────────
# cf_setup_interactive [--yes]
#   --yes  skip the "Set up a tunnel now?" question (caller already asked, e.g. `payroll tunnel setup`).
# Returns non-zero (never exits the caller) when setup fails; skipping returns 0.
cf_setup_interactive() {
  local raw="${CF_TUNNEL_TOKEN:-}" token="" mode="" app_host kiosk_host ans="" assume_yes=0
  [[ "${1:-}" == --yes || "${1:-}" == -y ]] && assume_yes=1
  app_host="$(cf_clean_host "${CF_APP_HOST:-}")"
  kiosk_host="$(cf_clean_host "${CF_KIOSK_HOST:-}")"

  # Non-interactive token mode.
  if [[ -n "$raw" ]]; then
    token="$(cf_extract_token "$raw")"
    if ! cf_token_valid "$token"; then
      warn "CF_TUNNEL_TOKEN does not contain a valid Cloudflare tunnel token; skipping the tunnel."
      return 1
    fi
    ( cf_setup_token "$token" ) || return 1
    cf_record_hosts "$app_host" "$kiosk_host"
    cf_verify
    return 0
  fi

  step "Internet access with Cloudflare Tunnel (optional)"
  info "A Cloudflare Tunnel lets staff reach Payroll at an address like https://payroll.example.com"
  info "without opening any ports on your router or firewall. This server makes an outgoing,"
  info "encrypted connection to Cloudflare, and Cloudflare forwards visitors through it."
  info "You need a free Cloudflare account and a domain managed by Cloudflare."

  if ! cf_interactive; then
    info "No terminal available; skipping. Set it up later with: sudo payroll tunnel setup"
    return 0
  fi
  if (( ! assume_yes )) && ! confirm "Set up a Cloudflare Tunnel now?" n; then
    info "Skipped. You can do this any time with: ${C_BOLD}sudo payroll tunnel setup${C_RESET}"
    return 0
  fi

  echo
  info "How do you want to connect?"
  info "  1) Paste a token from the Cloudflare dashboard (recommended; works on servers without a browser)"
  info "  2) Log in from this server with a link (cloudflared tunnel login); this server manages the hostnames"
  ans=""; ask ans "Choose 1 or 2" "1"
  case "$ans" in 2) mode=config ;; *) mode=token ;; esac

  if [[ "$mode" == token ]]; then
    cf_print_token_help
    local tries=0
    while :; do
      raw=""
      ask_secret raw "Paste the token (or the whole install command); input is hidden"
      token="$(cf_extract_token "$raw")"
      cf_token_valid "$token" && break
      tries=$((tries + 1))
      if [[ -z "$raw" ]] || (( tries >= 3 )); then
        warn "No valid token entered. Set it up later with: sudo payroll tunnel setup"
        return 0
      fi
      warn "That does not look like a tunnel token (it should start with eyJ…). Please try again."
    done
    ok "Token looks valid."
    info "Optional: tell Payroll which hostnames you added in Cloudflare (press Enter to skip)."
    [[ -n "$app_host" ]] || { ans=""; ask ans "Admin hostname (e.g. payroll.example.com)" ""; app_host="$(cf_clean_host "$ans")"; }
    [[ -n "$kiosk_host" ]] || { ans=""; ask ans "Kiosk hostname (e.g. kiosk.example.com)" ""; kiosk_host="$(cf_clean_host "$ans")"; }
    ( cf_setup_token "$token" ) || return 1
  else
    local htries=0
    while [[ -z "$app_host" ]]; do
      ans=""; ask ans "Admin hostname (e.g. payroll.example.com)" ""
      htries=$((htries + 1))
      if [[ -z "$ans" ]] || (( htries > 3 )); then
        warn "No admin hostname given. Set it up later with: sudo payroll tunnel setup"; return 0
      fi
      app_host="$(cf_clean_host "$ans")"
    done
    if [[ -z "$kiosk_host" ]]; then
      ans=""; ask ans "Kiosk hostname, optional (e.g. kiosk.example.com)" ""
      kiosk_host="$(cf_clean_host "$ans")"
    fi
    if [[ -n "$kiosk_host" && "$kiosk_host" == "$app_host" ]]; then
      warn "The kiosk hostname must differ from the admin hostname; ignoring it."; kiosk_host=""
    fi
    ( cf_setup_config "$app_host" "$kiosk_host" ) || return 1
  fi

  cf_record_hosts "$app_host" "$kiosk_host"
  cf_verify
  if [[ "$mode" == token && -n "$app_host$kiosk_host" ]]; then
    info "Reminder: these hostnames must also be added in the tunnel's Public Hostname / Routes settings"
    info "in Cloudflare, each pointing to HTTP localhost:$(app_port)."
  fi
  return 0
}

# Record hostnames; restart the app if KIOSK_HOST/APP_HOST changed so it picks them up.
cf_record_hosts() {
  local app_host="$1" kiosk_host="$2" changed=0
  if [[ -n "$app_host" && "$(env_get APP_HOST)" != "$app_host" ]]; then env_set APP_HOST "$app_host"; changed=1; fi
  if [[ -n "$kiosk_host" && "$(env_get KIOSK_HOST)" != "$kiosk_host" ]]; then env_set KIOSK_HOST "$kiosk_host"; changed=1; fi
  if (( changed )) && has_systemd && systemctl is-active --quiet payroll.service 2>/dev/null; then
    systemctl restart payroll.service || true
  fi
  return 0
}

# ── Status ────────────────────────────────────────────────────────────────────
cf_status() {
  local mode app kiosk state errs
  mode="$(env_get TUNNEL_MODE)"; app="$(env_get APP_HOST)"; kiosk="$(env_get KIOSK_HOST)"
  step "Cloudflare Tunnel"
  if cf_have; then ok "cloudflared installed: $(cloudflared --version 2>/dev/null | head -n1)"
  else info "cloudflared: not installed  (set up with: sudo payroll tunnel setup)"; fi
  state="$(cf_service_state)"
  case "$state" in
    active) ok "Service: running" ;;
    no-systemd) info "Service: unknown (systemd not running)" ;;
    *) if cf_unit_exists; then warn "Service: ${state:-unknown}"; else info "Service: not installed"; fi ;;
  esac
  info "Mode:     ${mode:-not configured}"
  info "Admin:    ${app:+https://$app}$([[ -n "$app" ]] || echo '(not set)')"
  info "Kiosk:    ${kiosk:+https://$kiosk}$([[ -n "$kiosk" ]] || echo '(not set)')"
  if [[ "$mode" == config && -f "$CF_CONFIG" ]]; then info "Config:   $CF_CONFIG"; fi
  if has_systemd && command -v journalctl >/dev/null; then
    errs="$(journalctl -u cloudflared -n 20 --no-pager 2>/dev/null | grep -E '\bERR\b' || true)"
    if [[ -n "$errs" ]]; then
      warn "Recent errors:"
      printf '%s\n' "$errs" | tail -n 5 | cut -c1-200 | sed 's/^/      /' >&2
    fi
  fi
  return 0
}

# ── Remove ────────────────────────────────────────────────────────────────────
cf_remove() {
  step "Removing the Cloudflare Tunnel from this server"
  cf_uninstall_service
  ok "Tunnel service stopped and removed."
  if [[ -d "$CF_ETC" ]] && { [[ -f "$CF_MARKER" ]] || [[ -f "$CF_CONFIG" ]]; }; then
    if confirm "Delete $CF_ETC (tunnel config and credentials)?" n; then
      rm -rf "$CF_ETC"; ok "Deleted $CF_ETC."
    else
      info "Kept $CF_ETC."
    fi
  fi
  env_unset TUNNEL_MODE
  env_unset APP_HOST
  env_unset KIOSK_HOST
  ok "Forgot TUNNEL_MODE, APP_HOST and KIOSK_HOST."
  if has_systemd && systemctl is-active --quiet payroll.service 2>/dev/null; then
    systemctl restart payroll.service || true
  fi
  info "The tunnel itself still exists in your Cloudflare account; delete it there if you no longer need it."
  info "cloudflared stays installed (remove with: apt-get remove cloudflared)."
}

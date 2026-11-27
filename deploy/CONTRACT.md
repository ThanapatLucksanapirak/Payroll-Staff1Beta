# Deploy layout contract (internal, shared by all deploy/ scripts)

Target: Debian 12+ / Ubuntu 22.04+ (amd64, arm64), systemd, run as root.

| Path | Purpose |
|---|---|
| /opt/payroll/node/ | Node.js 22 runtime (official tarball, symlink to /opt/payroll/runtime/node-vX) |
| /opt/payroll/repo/ | git clone of the app repo (fetch source for updates) |
| /opt/payroll/releases/<YYYYmmddHHMMSS>-<sha7>/ | built copy of the app (git worktree export + node_modules + dist) |
| releases/<…>/.release-sha, .release-history | installed commit, and `git log --first-parent` of it (shown in Settings → About) |
| /opt/payroll/current -> releases/... | active release (symlink, swapped atomically) |
| /opt/payroll/previous -> releases/... | last good release (for rollback) |
| /opt/payroll/deploy/ | copy of deploy/ from the active release (CLI + libs live here) |
| /usr/local/bin/payroll -> /opt/payroll/deploy/payroll | admin CLI |
| /etc/payroll/payroll.env | EnvironmentFile (mode 640 root:payroll) |
| /etc/payroll/github-token | optional read-only token for a private repo (mode 600) |
| /var/lib/payroll/ | DATA_DIR (owned by payroll:payroll, mode 750) |
| /var/lib/payroll/update-request | touching this asks root to run `payroll update` (payroll-update.path) |
| /var/lib/payroll/update-status.json | {"state":"idle|checking|updating|ok|failed|rolled_back","from":"sha","to":"sha","at":"ISO","message":"..."} |
| /var/backups/payroll/ | pre-update snapshots of DATA_DIR (tar.gz, keep 10) |
| /var/log/payroll/ | installer/update logs |

System user: `payroll` (no login shell, home /var/lib/payroll).

Services (deploy/systemd/):
- payroll.service — `node dist/index.cjs` in /opt/payroll/current, EnvironmentFile=/etc/payroll/payroll.env
- payroll-update.service (oneshot, `payroll update --auto`), payroll-update.timer (every 10 min, if AUTO_UPDATE=1), payroll-update.path (watches update-request)
- cloudflared.service — installed by `cloudflared service install <token>` (token mode) or our own unit for config mode

payroll.env keys: NODE_ENV=production, HOST=127.0.0.1 (0.0.0.0 if LAN access chosen), PORT=5000, DATA_DIR=/var/lib/payroll,
TRUST_PROXY=loopback, KIOSK_HOST=, APP_HOST=, REPO_URL=, BRANCH=main, AUTO_UPDATE=1, SETUP_CODE=(only during install),
ANDROID_CERT_SHA256=, ANDROID_APP_PACKAGE= (optional; `payroll android`)

App interfaces:
- GET http://127.0.0.1:$PORT/api/health -> 200 {"ok":true,...}
- The build writes dist/SHA256SUMS (every dist file and its sha256). An update is only switched to when
  dist/index.cjs, dist/public/index.html (and dist/faceWorker.cjs where the version has one) are there and every
  listed file matches; then it must answer /api/health for UPDATE_STABLE_SECONDS (15) in a row, or it's rolled back.
- First admin: preferred `node dist/index.cjs admin create --username X --password-stdin` (DATA_DIR env); fallback
  POST /api/auth/setup {password(min 8), setupCode} with code from $DATA_DIR/setup-code.txt or SETUP_CODE env.
- Kiosk: /kiosk on the same port; host KIOSK_HOST redirects / -> /kiosk.

All scripts: `set -Eeuo pipefail`, source deploy/lib/common.sh, shellcheck-clean, idempotent (safe to re-run).

Update bookkeeping: /opt/payroll/.update-skip lists commit shas that failed to update; `payroll update --auto`
skips them (a manual update retries). `payroll rollback` adds the version it left. `auto-update on` clears it.

# Installing Payroll on Debian or Ubuntu

One command sets up everything: the app, its own copy of Node.js, a system service that restarts itself, automatic updates with rollback, backups, your first administrator account and (optionally) a Cloudflare Tunnel so you can reach Payroll from anywhere.

**Works on:** Debian 12 or newer, Ubuntu 22.04 or newer (64-bit Intel/AMD or ARM, e.g. a Raspberry Pi 4/5). You need `sudo`, an internet connection, 2 GB of free disk and ideally 1 GB of memory or more.

## Install

### Option A: from a copy of the repository (recommended)

```bash
git clone https://github.com/ThanapatLucksanapirak/Payroll-Staff1Beta.git
cd Payroll-Staff1Beta
sudo ./deploy/install.sh
```

### Option B: one line, nothing to download first

The repository is private, so create a GitHub token first: [github.com/settings/personal-access-tokens/new](https://github.com/settings/personal-access-tokens/new), choose *Only select repositories* → this repository, and give it **Contents: Read-only**. Then on the server:

```bash
curl -fsSL -H "Authorization: Bearer YOUR_TOKEN" \
  https://raw.githubusercontent.com/ThanapatLucksanapirak/Payroll-Staff1Beta/main/deploy/install.sh \
  | sudo bash -s -- --token YOUR_TOKEN
```

The token is stored on the server (readable only by root) so automatic updates keep working. Prefer no tokens? Run with `--deploy-key` and the installer creates a key for you to paste into the repository's *Settings → Deploy keys*.

### What the installer asks

1. **Administrator username and password.** The first account is created right there on the server, before anything is reachable from the internet, so nobody else can claim it.
2. **Automatic updates?** Yes is recommended. New versions are checked every 10 minutes; each update is built while the current version keeps running, then swapped in. If the new version does not start, the previous one is put back automatically.
3. **Cloudflare Tunnel?** Paste the token from your Cloudflare dashboard and you get `https://payroll.yourdomain.com` (admin) and, optionally, `https://kiosk.yourdomain.com` (the employee kiosk). Step-by-step: [docs/cloudflare-tunnel.md](docs/cloudflare-tunnel.md).

Running the installer again is safe: it repairs or upgrades the install and keeps your data.

## Everyday use: the `payroll` command

| Command | What it does |
|---|---|
| `payroll status` | Is it running, which version, addresses, last backup, tunnel |
| `sudo payroll update` | Install the newest version now (with automatic rollback) |
| `sudo payroll rollback` | Go back to the previous version |
| `sudo payroll backup` / `backups` / `restore FILE` | Save, list and restore data backups |
| `sudo payroll auto-update on\|off` | Turn automatic updates on or off |
| `sudo payroll tunnel setup\|status\|remove` | Manage the Cloudflare Tunnel |
| `sudo payroll admin reset-password` | Reset an administrator's password |
| `sudo payroll admin disable-2fa` | Turn off two-factor sign-in for an account (lost phone) |
| `payroll logs -f` | Follow the app's log |
| `sudo payroll doctor` | Check for common problems and how to fix them |
| `sudo payroll uninstall` | Remove the app (keeps your data unless `--purge`) |

The app can also ask for an update itself (an **Update now** button): it writes `/var/lib/payroll/update-request`, which the `payroll-update.path` service picks up and runs `payroll update` as root. Progress is reported in `/var/lib/payroll/update-status.json`.

## Where things live

| Path | Contents |
|---|---|
| `/var/lib/payroll` | **Your data** (database, settings, the app's own daily backups) |
| `/var/backups/payroll` | Snapshots taken before every update and restore (last 10) |
| `/etc/payroll/payroll.env` | Settings: port, listen address, tunnel hostnames, auto-update |
| `/opt/payroll` | The app (`current` and `previous` versions), Node.js, the source clone |
| `/var/log/payroll` | Install, build and update logs (the app logs to `journalctl -u payroll`) |

By default the app only listens on `127.0.0.1`, so the only way in from outside is the Cloudflare Tunnel. To use it from other computers on your network as well, run the installer with `--lan` (or set `HOST=0.0.0.0` in `/etc/payroll/payroll.env` and `sudo payroll restart`).

## Unattended install

```bash
sudo PAYROLL_ADMIN_PASSWORD='a-strong-password' ./deploy/install.sh --yes \
  --admin-user admin --tunnel-token 'eyJ…' --port 5000
```

All options: `./deploy/install.sh --help`.

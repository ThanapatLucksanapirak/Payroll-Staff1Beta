# Reaching Payroll from the internet with Cloudflare Tunnel

A Cloudflare Tunnel gives Payroll a normal web address, such as
`https://payroll.example.com`, without opening any ports on your router or firewall.
The Payroll server makes an outgoing, encrypted connection to Cloudflare, and
Cloudflare sends visitors to it through that connection. HTTPS certificates are
handled by Cloudflare for you.

You need:

- a free Cloudflare account, and
- a domain (for example `example.com`) that uses Cloudflare for its DNS.

The installer offers to set this up for you. You can also do it any time later:

```
sudo payroll tunnel setup
```

> Cloudflare changes its dashboard wording from time to time. If a button below
> has a slightly different name, look for the closest match.

## Step 1: Create the tunnel in Cloudflare

Do this on any computer with a web browser.

1. Log in at <https://dash.cloudflare.com>.
2. Open the tunnels page. Depending on your dashboard it is one of:
   - **Zero Trust** > **Networks** > **Tunnels** (or **Networks** > **Connectors** > **Cloudflare Tunnels**)
   - **Networking** > **Tunnels** in the main dashboard
3. Click **Create a tunnel**. If asked for a type, choose **Cloudflared**.
4. Give it a name, for example `payroll`, and save.
5. Cloudflare now shows install commands. Choose **Debian** and copy the command.
   It looks like this (much longer in reality):

   ```
   sudo cloudflared service install eyJhIjoiNjk...
   ```

## Step 2: Paste it into the Payroll installer

When the installer (or `sudo payroll tunnel setup`) asks:

1. Choose option **1** (paste a token).
2. Paste the whole command you copied. Payroll keeps only the token part.
   The text is hidden while you paste; press Enter once.
3. Optionally type the addresses you will use, for example `payroll.example.com`
   and `kiosk.example.com`. This lets Payroll know which address is the kiosk.

Payroll then installs the Cloudflare connector and starts it. Back in the
Cloudflare dashboard the tunnel should show as **Healthy** within a minute.

## Step 3: Give the tunnel its web addresses

In the Cloudflare dashboard, open your tunnel and find the **Public Hostname** tab
(newer dashboards: **Routes** > **Add route** > **Published application**).
Add one entry for the main Payroll site:

| Field | What to enter |
|---|---|
| Subdomain | `payroll` |
| Domain | `example.com` (pick yours from the list) |
| Service type | `HTTP` |
| URL | `localhost:5000` |

`5000` is Payroll's port. If you changed it, run `payroll status` to see the right one.

### Adding the kiosk (time clock) address

Add a second entry exactly the same way, but with subdomain `kiosk`
(so `kiosk.example.com` -> `HTTP` -> `localhost:5000`). Then make sure Payroll
knows about it. If you did not type it during setup, run `sudo payroll tunnel setup`
again and enter it. Visitors to the kiosk address go straight to the clock-in screen.

Open `https://payroll.example.com` in a browser. It can take a minute or two the
first time.

## Optional: add an extra login in front of the admin site

Cloudflare Access can ask for an email code *before* anyone even sees the Payroll
login page. This is a good extra layer for the admin address. Do **not** add it to
the kiosk address, or the time clock will stop working.

1. In the Cloudflare dashboard go to **Zero Trust** > **Access** > **Applications**
   (newer dashboards: **Access controls** > **Applications**).
2. Click **Add an application** (or **Create new application**) and choose **Self-hosted**.
3. Enter the admin address, for example `payroll.example.com`.
4. Add a policy with action **Allow** and a rule such as **Emails** -> your managers'
   email addresses (or **Emails ending in** `@yourcompany.com`).
5. For the login method, use **One-time PIN**. Cloudflare emails a code to the
   address the person types; only allowed addresses receive one.
   (If One-time PIN is not listed, add it under **Settings** > **Authentication** >
   **Login methods**.)
6. Save. Visit the admin address in a private browser window to check it asks for an email.

## Checking and fixing problems

Quick checks on the server:

```
payroll status            # is the Payroll app running?
payroll tunnel status     # is the tunnel connected? shows recent errors
```

| What you see | What it means | What to do |
|---|---|---|
| **Error 502** or **Bad gateway** | The tunnel works, but the Payroll app is not answering. | Run `payroll status`. Also check the hostname points to `HTTP` and `localhost:5000` (not HTTPS). |
| **Error 1033** or "Argo Tunnel error" | Cloudflare cannot reach your server's tunnel. | Run `payroll tunnel status`. Make sure the server is on and has internet. `sudo systemctl restart cloudflared` often helps. |
| **This site can't be reached** / DNS error | The address does not exist yet. | Check the Public Hostname / route was saved. New addresses can take a few minutes. |
| **404 Not Found** from Cloudflare | The address reaches the tunnel, but the tunnel has no route for it. | Add the address in the tunnel's Public Hostname / Routes tab. |
| Kiosk address shows the admin login | Payroll does not know the kiosk address. | Run `sudo payroll tunnel setup` and enter the kiosk hostname. |

To disconnect this server from Cloudflare:

```
sudo payroll tunnel remove
```

This stops the connector on the server. The tunnel itself stays in your Cloudflare
account; delete it there if you no longer need it.

## Advanced: let the server manage the addresses itself

Setup option **2** uses `cloudflared tunnel login` instead of a token. It prints a
link you open on any computer to approve access to your domain. Payroll then creates
a tunnel named `payroll-<server name>`, creates the DNS records for the admin and
kiosk addresses, and writes `/etc/cloudflared/config.yml`. In this mode you change
addresses by running `sudo payroll tunnel setup` again, not in the dashboard.
Most people should use option 1.

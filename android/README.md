# Shijiri Time Clock for Android (Google Play)

A small Android app that opens **only the kiosk page**,
`https://kioskpayroll.shijirigroup.com/kiosk`, full screen with no browser bar.
It is a *Trusted Web Activity* (TWA): Chrome draws the page, the app adds the
icon, the splash screen and full-screen mode. There is no native code, so every
change to the kiosk reaches the tablets from the server, not through Play
updates. You only upload a new version to Play to change the app's name, icon,
address or Android settings.

* **One app, kiosk only.** The admin app (`payroll.shijirigroup.com`) stays a
  website; it holds payroll data and owners sign in from any browser, so there's
  no reason to put it on Play. The app can only open the kiosk hostname, and
  that hostname only serves the kiosk (`KIOSK_HOST`), so the app can never show
  admin pages.
* **No zoom.** The kiosk page sets `user-scalable=no` and `touch-action:
  manipulation`, and Chrome honours that in the app. (The one exception is
  Android's own accessibility setting *Force enable zoom*, which overrides every
  page. Leave it off on kiosk tablets.)
* **Full screen.** Sticky immersive mode hides the status and navigation bars.
  Swiping from an edge shows them for a moment.
* **Chrome required.** Every normal Android tablet has it. Without a browser that
  supports TWAs, the page opens in a Chrome Custom Tab instead.
* The camera (punch photos) works as it does in Chrome: Chrome asks once per
  tablet.

| Setting | Where | Default |
|---|---|---|
| Kiosk address | `kioskHost` in `android/gradle.properties` | `kioskpayroll.shijirigroup.com` |
| Package name (permanent once on Play) | `appId` | `com.shijirigroup.timeclock` |
| Name under the icon | `appName` | `Time Clock` |
| Version | `versionCode` / `versionName` (or the workflow's inputs) | `1` / `1.0.0` |

---

## What you need to do

### 1. Make an upload key (once, on your own computer)

You need Java installed (`keytool` comes with it). Pick a strong password and
keep the file **and** the password somewhere safe, like a password manager. If
you lose them, Google can reset the upload key, but it takes a few days.

```bash
keytool -genkeypair -v -keystore timeclock-upload.jks -alias upload \
  -keyalg RSA -keysize 2048 -validity 10000 \
  -dname "CN=Shijiri Group, O=Shijiri Group, C=MN"
```

Change `C=MN` to your country's two-letter code if you like; it is not shown to anyone.

Never commit the `.jks` file. `android/.gitignore` blocks it.

### 2. Give the key to GitHub so it can build the app

On GitHub: **Settings → Secrets and variables → Actions → New repository
secret**, and add:

| Secret | Value |
|---|---|
| `ANDROID_KEYSTORE_BASE64` | output of `base64 -w0 timeclock-upload.jks` (macOS: `base64 -i timeclock-upload.jks`) |
| `ANDROID_KEYSTORE_PASSWORD` | the password from step 1 |
| `ANDROID_KEY_ALIAS` | `upload` |
| `ANDROID_KEY_PASSWORD` | the same password (unless you chose a different key password) |

### 3. Build the signed bundle

**Actions → "Android app (Time Clock)" → Run workflow**. Enter version code `1`
and version name `1.0.0` the first time, and a higher version code each later
time. When it finishes, download the `time-clock-release` artifact. It
contains `app-release.aab`, which you upload to Play. The run's summary also
shows the upload key's SHA-256 fingerprint.

(You can also build on a computer with Android Studio: open the `android`
folder, then **Build → Generate Signed App Bundle**.)

### 4. Google Play Console

1. Sign up at <https://play.google.com/console>. There's a one-time US$25 fee
   and an identity check. **Register as an organization** (Shijiri Group) if you
   can. It needs a D-U-N-S number, but new *personal* accounts must run a
   closed test with at least 12 testers for 14 days before they can publish to
   everyone. Organization accounts skip that.
2. **Create app**: name "Shijiri Time Clock", App, Free. (The label under
   the icon on the tablet is the short name, "Time Clock".)
3. **Test and release → Testing → Internal testing → Create new release**.
   Accept **Play App Signing** (Google keeps the real signing key; yours is only
   the upload key). Upload `app-release.aab`, add yourself as a tester, roll
   it out.
4. **Test and release → App integrity → App signing**. Copy the **SHA-256
   certificate fingerprint** of the *App signing key*.
5. Fill in **App content**. This is what Play reviews:
   * **Privacy policy URL** (required because the kiosk can take punch photos
     with the camera). A short page on your website that says what the time
     clock collects (name, PIN, clock times and, if turned on, a photo at
     each punch), why, and who to contact.
   * **App access**: the app needs a paired tablet. Choose "All or some
     functionality is restricted" and explain: "This is a staff time clock for
     Shijiri Group's own tablets. A manager pairs the tablet from the admin
     app." If Play asks for a way in, give them a test pairing code.
   * **Ads**: no. **Content rating** questionnaire: business/utility, no
     objectionable content. **Target audience**: 18+.
   * **Data safety**: collects *Name* and *Photos* (if punch photos are on),
     for *App functionality*. Data is encrypted in transit and is not shared with third
     parties.
6. **Store listing**: short and full description, the icon
   `android/store/play-icon-512.png`, a 1024×500 feature graphic, and at least
   2 screenshots of the kiosk from a tablet.
7. When you're ready for everyone (or just your own tablets), promote the
   release to **Production**. If only your own tablets need it, you can keep it
   on Internal testing and add the tablets' Google accounts as testers. Or make
   it a *private app* for your organization through Managed Google Play.

### 5. Tell the server about the key

The app only opens full screen (no address bar) when the kiosk address
publishes the key's fingerprint. On the server:

```bash
sudo payroll android fingerprint <App-signing SHA-256 from step 4.4>,<upload key SHA-256 from step 3>
```

Then check that `https://kioskpayroll.shijirigroup.com/.well-known/assetlinks.json`
shows both. (`payroll android status` prints the link. Without the installer,
set `ANDROID_CERT_SHA256` in the environment and restart the app.) The upload
key's fingerprint is only needed for copies you install directly from the
GitHub build; Play installs use Google's key.

If the address bar still shows: force-stop the app, clear Chrome's data or
reinstall, and check the file with
<https://developers.google.com/digital-asset-links/tools/generator>.

### 6. On each tablet

Install from Play (or the internal-testing link), open **Time Clock**, and pair
it as usual. Pairing is stored by Chrome for that address, so a tablet already
paired in Chrome stays paired in the app. For a locked-down tablet, use Android's
**Screen pinning** (Settings → Security → App pinning) to keep people in the
app.

# StreamBeam for Android (APK)

The Android app shows the hosted StreamBeam full screen and adds what a web
page can't do: it **searches your Wi-Fi for screens** and casts to them.

- **Google Cast**: Chromecast, Google TV, Android TVs and head units with Cast
  built in (found with Android's media router, played with the Cast SDK's
  default receiver). Needs Google Play services.
- **DLNA / UPnP renderers**: most smart TVs (Samsung, LG, Sony…), many car head
  units, Kodi, set-top boxes. Found with an SSDP search on every Wi-Fi and
  hotspot interface, controlled with UPnP AVTransport (play, pause, seek,
  volume).
- **Mirror to car screen (DLNA)**: the phone screen is captured (Android's
  screen-recording permission, with a notification while it runs), encoded to
  H.264 1280×720 by the hardware encoder, packed as live MPEG-TS and served by
  the app; the screen is told to play it like any video. Expect 1–4 s delay;
  sound stays on the phone or Bluetooth; apps that block screen recording show
  black. For Chromecast or Miracast TVs, Mirror also opens Android's own cast.

The phone and the screen must be on the same network. For a car screen, join
the car's Wi-Fi or connect the car to the phone's hotspot. YouTube can't be
cast this way (YouTube only casts from its own app), and files on the phone
play on the phone.

The web page talks to Android through a message channel that only
`https://elrity.github.io` can open (`WebViewCompat.addWebMessageListener`).

## Two editions

The app has two product flavors, built from the same code and the same web app:

| Flavor | App | Application id |
| --- | --- | --- |
| `streambeam` | StreamBeam | `app.streambeam.caster` |
| `iptv` | Rity IPTV (IPTV only) | `app.rity.iptv` |

`src/iptv/` holds what differs for Rity IPTV: its name, icon and logo, its
home-screen shortcuts (written by `configure.mjs`) and a manifest that leaves
out the mirroring service and its permissions. The app adds `SBEdition/iptv`
to the web page's user agent, and the web app then shows only IPTV.
`node configure.mjs <address> [streambeam id] [version] [iptv id]` sets the ids.
Build one with `./gradlew assembleStreambeamRelease` or
`./gradlew assembleIptvRelease`; in Android Studio pick the variant in
Build → Select Build Variant.

## Build it in Android Studio (Mac, Windows or Linux)

1. Install [Android Studio](https://developer.android.com/studio) and
   [Node.js](https://nodejs.org) (for the one-line setup step).
2. Get the project and point it at your hosted StreamBeam:
   ```sh
   git clone https://github.com/elrity/streambeam
   cd streambeam/android
   node configure.mjs https://elrity.github.io/streambeam/
   ```
   Run `configure.mjs` again whenever the address changes.
3. Android Studio → **Open** → choose the `streambeam/android` folder. The
   first sync downloads Gradle and the Android SDK parts it needs (a few
   minutes). If it offers to upgrade the Android Gradle plugin, that's fine.
4. **Try it on your phone**: on the phone, Settings → About phone → tap
   *Build number* 7 times, then Settings → Developer options → turn on
   *USB debugging*. Plug it into the Mac, accept the prompt on the phone, pick
   it in the device list at the top of Android Studio and press **Run ▶**.
5. **Make the APK to keep and share**: Build → **Generate Signed App Bundle or
   APK** → *APK* → *Create new…* keystore (save it somewhere safe, e.g.
   `~/streambeam.jks`, alias `streambeam`) → *release* → Create. The APK is
   in `android/app/<flavor>/release/`; send it to the phone (Google
   Drive, email, USB) and open it there.
6. **Hide the browser bar**: get the key's fingerprint and set it on the
   server as `ANDROID_CERT_SHA256` (Render → Environment):
   ```sh
   keytool -list -v -keystore ~/streambeam.jks -alias streambeam | grep SHA256
   ```

Use the same keystore for every build so updates install over the old app.
To let GitHub Actions sign with it too, add it as the secrets described in
*Keep one signing key* below.

## Build the APK (GitHub Actions)

1. The app is hosted at `https://elrity.github.io/streambeam/` (GitHub
   Pages), and every change to `android/` builds a new APK for that address
   automatically.
2. To build for another address (your own server, Render, a fork): **Actions
   → Android APK → Run workflow** and paste it, or set the repository
   variable `APP_URL`.
3. When it finishes (about 5 minutes), open **Releases** and download
   `StreamBeam-1.N.apk` on your phone. Open it and allow installing from your
   browser when Android asks.

## Open links in the app

The app has no address bar. Links to the app's site open in the app once
Android confirms the app owns the site. It checks
`/.well-known/assetlinks.json` at the root of the domain; each APK release
includes that file, made for its signing key.

- **GitHub Pages** (`elrity.github.io/streambeam/`): the domain root is
  `elrity.github.io`, served by a repository named `elrity.github.io`.
  Create it (public), add the release's `assetlinks.json` as
  `.well-known/assetlinks.json` plus an empty `.nojekyll` file at its root,
  and turn on Pages for it (Settings → Pages → Deploy from branch → main).
- **StreamBeam server** (Render, your own computer): set
  `ANDROID_CERT_SHA256` to the fingerprint in the release notes and restart.

Reopen the app a minute later. Use a permanent signing key first (below),
otherwise the fingerprint changes with every build.

## Keep one signing key (recommended)

Without a key the workflow signs with a temporary debug key, so a new build
won't install over the old one: uninstall first. To sign every build with
your own key, create it once:

```sh
keytool -genkeypair -v -keystore streambeam.jks -alias streambeam \
  -keyalg RSA -keysize 2048 -validity 10000
base64 -w0 streambeam.jks   # macOS: base64 -i streambeam.jks
```

Add these repository secrets (Settings → Secrets and variables → Actions):
`ANDROID_KEYSTORE_BASE64` (the base64 output) and `ANDROID_KEYSTORE_PASSWORD`.
Add `ANDROID_KEY_ALIAS` only if the alias isn't `streambeam`, and
`ANDROID_KEY_PASSWORD` only if the key password differs.
Keep `streambeam.jks` safe: losing it means users must reinstall. Then update
`ANDROID_CERT_SHA256` on the server with the new fingerprint.

## Build locally

Needs JDK 17+ and the Android SDK (`ANDROID_HOME`); the Gradle wrapper fetches Gradle:

```sh
cd android
node configure.mjs https://streambeam-xxxx.onrender.com
./gradlew assembleRelease   # both: app/build/outputs/apk/{streambeam,iptv}/release/
```

## Google Play

Play needs an Android App Bundle: run `./gradlew bundleRelease` (or choose
*Android App Bundle* in Android Studio's Generate Signed wizard) with your own
key, then upload `app/build/outputs/bundle/<flavor>Release/app-<flavor>-release.aab` in Play
Console. Play signs the app with its own key, so add Play's "App signing key"
SHA-256 to `ANDROID_CERT_SHA256` too (comma-separated).

## Activation (one phone per code)

Builds made with the repository variable `REQUIRE_ACTIVATION` set to `true` open only on activated phones.

1. The phone shows its **device code** (like `K7QX2-MRH4D`) and a *Send code* button.
2. The owner runs **Actions → Activate a phone → Run workflow** with that code (or
   `node tools/activate.mjs CODE key.pem` locally). The run's summary has an activation link.
3. The person taps the link on that phone (or pastes it): StreamBeam opens activated.

The code is a signature of that phone's device code made with the owner's private key (secret
`LICENSE_PRIVATE_KEY`); the app holds only the public key (`Activation.java`). It fits that one phone, so
passing on the APK or the code doesn't activate another phone. The device code stays the same after
reinstalling; a factory reset changes it.

## Mirroring sound

With *Phone sound in mirroring* on, the sound goes to the car inside the video. *Mute the phone while
mirroring* mutes the phone's own media volume for the session (restored when mirroring stops); the capture
is unaffected. If a phone ever captures only silence while muted, the app turns the phone's sound back on.

## Mirroring delay

The car's player waits whenever it runs short of data and never skips ahead, so every wait stays as delay.
The stream avoids waits: sound runs without gaps (silence is sent while nothing plays) on the same clock
as the picture, and the encoder hands out each frame at once. If the car still drifts behind, *Catch up*
on the Mirror screen restarts the picture there from the newest frame.

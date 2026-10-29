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
- **Screen mirroring** opens Android's own screen-cast settings.

The phone and the screen must be on the same network. For a car screen, join
the car's Wi-Fi or connect the car to the phone's hotspot. YouTube can't be
cast this way (YouTube only casts from its own app), and files on the phone
play on the phone.

The web page talks to Android through a message channel that only
`https://elrity.github.io` can open (`WebViewCompat.addWebMessageListener`).

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
   in `android/app/release/app-release.apk`; send it to the phone (Google
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
./gradlew assembleRelease   # app/build/outputs/apk/release/app-release.apk
```

## Google Play

Play needs an Android App Bundle: run `./gradlew bundleRelease` (or choose
*Android App Bundle* in Android Studio's Generate Signed wizard) with your own
key, then upload `app/build/outputs/bundle/release/app-release.aab` in Play
Console. Play signs the app with its own key, so add Play's "App signing key"
SHA-256 to `ANDROID_CERT_SHA256` too (comma-separated).

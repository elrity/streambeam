# StreamBeam

Cast web videos, YouTube and IPTV to your TV, mirror your screen, and get
today's news and weather from Gemini. A web app that installs like a native
app, plus an Android APK.

**Open the app:** https://elrity.github.io/streambeam/
**Android APK:** https://github.com/elrity/streambeam/releases/latest

## Install it

**Any phone or computer (iPhone included).** Open the app link, then choose
*Add to Home Screen* (Safari: Share → Add to Home Screen) or *Install* (Chrome,
Edge). Long-press the icon for shortcuts: Today's news, Weather, Ask Gemini,
Mirror screen.

**Android APK.** Needs Android 5+ with Chrome (or Samsung Internet / Edge).

1. Open the APK link on the phone and download `StreamBeam-….apk`.
2. Tap it. When Android asks, allow installing from Chrome (or Files) and tap
   **Install**.
3. If Play Protect warns about an unknown developer, tap **More details →
   Install anyway**. It warns because the app isn't from the Play Store.

The app's features load from the web, so fixes arrive without reinstalling.

## First steps in the app

- **Cast:** the TV and phone must share a Wi-Fi network. Tap the cast button
  at the top and pick **Nearby screen** (Chromecast, Google TV, AirPlay where
  the browser supports it). Demo TVs for trying the app are in Settings.
- **Today (Gemini):** tiles open Gemini with the question ready to paste. For
  answers inside the app, add your own free key from
  [aistudio.google.com/apikey](https://aistudio.google.com/apikey) in
  Settings → Today. It stays on your device.
- **Weather and local news:** type your city on the Today screen or tap
  *Use my location*.

## What's in this repository

| Folder | What it is |
| --- | --- |
| `web/` | The app (`index.html`, one file) and an optional Node server (`server.mjs`) for a shared Gemini key, an app password and casting to VLC. See [web/README.md](web/README.md). |
| `android/` | The Android app: opens the hosted app full screen. See [android/README.md](android/README.md). |
| `.github/workflows/` | Publishes `web/` to GitHub Pages and builds the APK on every change. |
| `render.yaml` | Optional: run the server on Render instead of GitHub Pages. |

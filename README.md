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

**Android APK.** Needs Android 6 or newer. The app is what searches your Wi-Fi
for TVs and car screens (Google Cast and DLNA); a web browser can't.

1. Open the APK link on the phone and download `StreamBeam-….apk`.
2. Tap it. When Android asks, allow installing from Chrome (or Files) and tap
   **Install**.
3. If Play Protect warns about an unknown developer, tap **More details →
   Install anyway**. It warns because the app isn't from the Play Store.

The app's features load from the web, so fixes arrive without reinstalling.

## First steps in the app

- **Cast:** tap the dial on the home screen. In the Android app it searches
  your Wi-Fi and lists the TVs and car screens it finds (Google Cast and DLNA).
  The phone and screen must share a network; for a car, join the car's Wi-Fi or
  connect the car to your phone's hotspot. In a browser, pick **Nearby
  screen** (Chrome's own casting). Demo screens are in Settings.
- **Today (Gemini):** tiles open Gemini with the question ready to paste. For
  answers inside the app, add your own free key from
  [aistudio.google.com/apikey](https://aistudio.google.com/apikey) in
  Settings → Today. It stays on your device.
- **Weather and local news:** type your city on the Today screen or tap
  *Use my location*.

## Rity IPTV (IPTV-only edition)

A second Android app built from the same code: **Rity IPTV** (`app.rity.iptv`,
its own name and icon). It installs next to StreamBeam. Each release has both
APKs: `StreamBeam-….apk` and `RityIPTV-….apk`.

- Opens straight on the IPTV keypad: Live TV, Movies, Series, Free TV, Search
  and Settings. The other sections, mirroring, the idle screen and the hotspot
  prompt are left out.
- Playlists (Xtream code or M3U link) are added and switched in
  Settings → Playlists.
- Each section has a History list at the bottom, newest first, with how far
  you got; tap one to carry on where you stopped.

The web app knows it's this edition from the app (it adds `SBEdition/iptv` to
the browser's user agent). To try it in a browser, open the app link with
`?edition=iptv` (and `?edition=full` to go back).

## RoomFit (furniture in your room)

A separate web app in [`web/furniture/`](web/furniture/README.md): open the
phone's camera and drag a real-size 3D chair, sofa or dining table into your
room. It finds the floor and the walls, lights the furniture to match the room,
and each piece stays where you put it while you walk around.

**Open it:** https://elrity.github.io/streambeam/furniture/ (camera AR needs
an Android phone with Chrome; any device can use the 3D room preview).

## What's in this repository

| Folder | What it is |
| --- | --- |
| `web/` | The app (`index.html`, one file) and an optional Node server (`server.mjs`) for a shared Gemini key, an app password and casting to VLC. See [web/README.md](web/README.md). |
| `web/furniture/` | RoomFit, the AR furniture app. See [web/furniture/README.md](web/furniture/README.md). |
| `android/` | The Android app: hosts the app and adds real screen search and casting (Google Cast, DLNA). See [android/README.md](android/README.md). |
| `.github/workflows/` | Publishes `web/` to GitHub Pages and builds the APK on every change. |
| `render.yaml` | Optional: run the server on Render instead of GitHub Pages. |

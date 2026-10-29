# StreamBeam Caster

A browser-based video casting app modelled on Web Video Caster, with a Gemini
"Today" screen for everyday news and weather. The app is one file
(`index.html`); `server.mjs` runs it in production (see **Run it in
production** below). It also works from any static host, minus the
server-side Gemini key and the VLC relay.

## Features

- **Today (Gemini quick access)**: one-tap tiles for Top news, Weather,
  Local news, Sports, Markets, Tech, Watch tonight and Commute, plus an
  "Ask Gemini anything" box. Reach it from the **Ask Gemini** button in the
  header, the `G` key, or the home-screen shortcuts. Answers use Gemini with
  Google Search grounding, list their sources, and can be read aloud. They
  come from the server's key (`GEMINI_API_KEY`) or a key saved in Settings on
  that device; with neither, each tile copies a ready-made question and opens
  Gemini. Weather, local news and commute use your city or location.

- **Browser**: open a page or paste a link. The app lists the videos it finds
  (MP4, WebM, HLS `.m3u8`, DASH `.mpd`) with Cast / Queue / Copy link actions.
  Pages that block cross-origin requests (CORS) can't be scanned, so paste the
  direct video link for those.
- **Remote**: TV preview, seek, play/pause, skip back/forward, stop, next,
  volume, mute, playback speed and `.srt` / `.vtt` subtitles.
- **Cast devices**: "Nearby screen" uses the browser's Remote Playback API,
  which does real Chromecast / AirPlay casting in supporting browsers. The
  Chromecast, Roku, Fire TV, DLNA and AirPlay entries are **demo receivers**
  (simulated) and can be hidden in Settings.
- **YouTube**: paste any YouTube link (watch, youtu.be, Shorts, live,
  embed, playlists, mobile and music hosts; `t=` start times are kept) or
  scan a page with embedded YouTube videos. Videos play in the official
  YouTube IFrame Player, which the remote drives (play/pause, seek, skip,
  volume, mute, speed, queue/autoplay, resume from history). YouTube does not
  let other apps pull its video files for casting, so the Remote also offers
  three ways onto a real TV: Open in YouTube (the app's own Cast button),
  Link with TV code, and mirroring the tab. Videos whose owners turned off
  embedding show a clear message. The YouTube player needs the app served
  over http(s), e.g. `npx serve web` or GitHub Pages, not opened as a file.
- **VLC as the player**: three ways, for formats browsers can't decode
  (MKV, AVI, FLV, WMV, TS, DASH, HEVC…) or for VLC's playback in general.
  - *Cast to VLC*: pick **VLC media player** in the cast list and VLC
    becomes the receiver (e.g. on a PC or Raspberry Pi wired to the TV);
    the app's remote drives play/pause, seek, volume, mute, speed, stop and
    queue autoplay. See "VLC setup" below.
  - *Open in VLC*: the VLC button on any video opens it in the VLC app on
    Android/iPhone, or saves an `.m3u` playlist / copies the link for desktop
    VLC (Media → Open Network Stream). The Queue can be saved as a playlist.
  - *Automatic suggestion*: when a video's format needs VLC or the browser
    fails to decode it, the Remote offers Open in VLC / Cast to VLC
    (Settings → Suggest VLC for unsupported videos).
- **Screen mirroring**: share the entire screen, a window or a browser tab
  (`getDisplayMedia`) at 720p/1080p/1440p and 15/30/60 fps, with optional
  sound, live stats and a Stop control in the bottom bar. A web page can't
  push a captured screen to a real TV by itself, so the Mirror screen also
  lists the built-in mirroring steps for Chrome, Edge, Windows (Miracast),
  Mac/iPhone/iPad (AirPlay), Android, Roku and Fire TV, with the viewer's
  own platform marked first. Screen capture needs a desktop browser; phones
  and embedded frames that block it fall back to those steps.
- **Queue** with reorder and autoplay-next, **Local files** (drag and drop),
  **IPTV** M3U playlists with groups and search, **Bookmarks**, **History**
  with resume, and **Settings**.
- Light and dark themes; works at phone width with bottom tabs.

Queue, history, bookmarks, playlist and settings are kept in `localStorage`.
HLS playback in non-Safari browsers uses hls.js from jsDelivr.

## Next steps toward native-level casting

- Google Cast Web Sender SDK for direct Chromecast sessions.
- A small local helper (Node/Electron) for SSDP discovery so real DLNA, Roku
  (ECP) and Fire TV devices can be found and controlled.

## VLC setup (Cast to VLC)

1. In VLC: Tools → Preferences → Show settings: **All** → Interface → Main
   interfaces → tick **Web**; under Main interfaces → Lua set a password;
   restart VLC. Or run `vlc --extraintf http --http-password <password>`.
2. Start the server (Node 18+, no dependencies) on the same computer:
   `VLC_PASSWORD=<password> node web/server.mjs`
3. Open `http://localhost:8090`, choose **VLC media player** in the cast list.

To use a phone as the remote, start the server with `BIND=0.0.0.0` and open
`http://<computer-ip>:8090` on the phone. Other options: `PORT`, `VLC_HOST`,
`VLC_PORT`, `ALLOW_ORIGIN` (to call the server from the app hosted elsewhere).

The relay exists because browsers can't send VLC's password and VLC sends no
CORS headers. It only relays the remote-control commands the app uses, only
lets VLC open network links (never local files), and refuses requests whose
Host header isn't an IP address or localhost.

## Host it on Render (optional)

GitHub Pages already hosts the app for free (see the main README). Render runs
the full server instead, which adds a shared Gemini key and an app password.
Render may ask for a payment card even on its free plan.

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/elrity/streambeam)

The repository has a Render Blueprint (`render.yaml` at the root):

1. In Render: **New → Blueprint**, connect GitHub and choose `elrity/streambeam`.
2. Fill in the two secrets Render asks for:
   - `APP_PASSWORD`: the password the browser will ask for. Set one: the app
     is on the public internet and otherwise anyone could use your Gemini key.
   - `GEMINI_API_KEY`: from aistudio.google.com/apikey (optional).
3. **Apply**. After the first build, open `https://streambeam-<…>.onrender.com`
   and choose *Install* / *Add to Home Screen*. HTTPS is automatic, so
   installing, shortcuts and screen mirroring all work.

Notes: the free plan sleeps after 15 minutes without visits, so the first
visit after that takes up to a minute. Pushes that change `web/`
redeploy automatically. Cast to VLC needs VLC on the same network as the
server, so use a home computer for that, not Render.

## Run it in production

Needs Node 18+ (no packages) or Docker.

```sh
cd web
GEMINI_API_KEY=<key from aistudio.google.com/apikey> node server.mjs
# open http://localhost:8090
```

To use it from your phone and TV on the same Wi-Fi, listen on the network and
set a password (the browser asks for it once):

```sh
GEMINI_API_KEY=... BIND=0.0.0.0 APP_PASSWORD=<password> node server.mjs
# open http://<computer-ip>:8090
```

Docker:

```sh
docker build -t streambeam web
docker run -d --restart unless-stopped -p 8090:8090 \
  -e GEMINI_API_KEY=... -e APP_PASSWORD=... streambeam
```

| Setting | Default | What it does |
| --- | --- | --- |
| `PORT` / `BIND` | `8090` / `127.0.0.1` | Where the server listens (`0.0.0.0` for other devices) |
| `APP_PASSWORD` | – | Password prompt for the whole app (recommended whenever `BIND` isn't local) |
| `GEMINI_API_KEY` | – | Turns on in-app answers for everyone using this server; the key never reaches browsers |
| `GEMINI_MODEL` | `gemini-2.5-flash` | Any Gemini model with Google Search grounding |
| `GEMINI_LIMIT` | `40` | Questions per address per 10 minutes |
| `GEMINI_API_BASE` | Google's endpoint | For an API proxy or gateway |
| `VLC_PASSWORD`, `VLC_HOST`, `VLC_PORT` | relay off | Turns on Cast to VLC |
| `ALLOW_ORIGIN` | – | Lets the app hosted elsewhere call `/vlc` |
| `TRUST_PROXY` | off | Behind a hosting proxy (Render, Fly, Nginx): limit Gemini per visitor, not per proxy |
| `ANDROID_CERT_SHA256`, `ANDROID_PACKAGE` | – | Publishes `/.well-known/assetlinks.json` for the Android app (see `android/README.md`) |

**Install it as an app**: open the server's address in Chrome, Edge or
Safari and choose *Install* / *Add to Home Screen*. Long-press the icon for
shortcuts: **Today's news**, **Weather**, **Ask Gemini**, **Mirror screen**.
The app shell works offline; live answers, casting and video need a network.
Installing (and screen mirroring) requires `localhost` or HTTPS; to use it
from other devices, put it behind HTTPS (for example Caddy:
`caddy reverse-proxy --from streambeam.example.com --to localhost:8090`, or a
Cloudflare Tunnel).

`/healthz` answers `ok` for uptime checks.

**Android app (APK)**: `android/` wraps the hosted app as an installable
APK, built by GitHub Actions. See `../android/README.md`.

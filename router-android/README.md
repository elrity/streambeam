# RouterPilot (control your home router)

An Android app that controls the Wi-Fi router on your home network:

| What | How |
| --- | --- |
| See connected devices | Name, IP, MAC, online or offline, Wi-Fi signal. Rename devices (the names stay on your phone). |
| Stop a device's internet | One switch per device. It stays on the network but can't reach the internet. |
| Speed limit per device | Download and upload in Mbps. |
| Priority per device | Low, normal or high. |
| Block websites | For every device, including all subdomains (blocking `youtube.com` also blocks `m.youtube.com`). |
| Turn Wi-Fi off | Every Wi-Fi device disconnects; devices on a cable keep working. **Wi-Fi comes back on when the router restarts**, or tap *Turn Wi-Fi on* from a device on a cable. |
| Restart the router | The app waits and reconnects by itself. |

**Download:** [Releases](https://github.com/elrity/streambeam/releases?q=routerpilot&expanded=true) → `RouterPilot-….apk`.
**Try the demo in a browser:** https://elrity.github.io/streambeam/router/ (a pretend router; a browser
can't control a real one, which is why this is an Android app).

## Which routers

Every router brand has its own private control interface, and most consumer and ISP routers don't
offer one an app may use. RouterPilot works with routers that have an open, documented one:

- **OpenWrt** 22.03 or newer with LuCI (the web interface). Includes GL.iNet, Turris and many
  TP-Link, Netgear, Linksys and Xiaomi models flashed with OpenWrt.
- **MikroTik** with RouterOS 7.
- **Demo**, to see how it works.

If your router is something else, open an issue with its brand and model; *Open the router's own page* on the
Router tab gets you to its settings meanwhile.

## Setup

### OpenWrt

1. Phone on the router's network. Open RouterPilot, pick **OpenWrt**. The address is filled in for
   you (normally `192.168.1.1`). User `root` and your LuCI password.
2. **One time only:** the Router tab shows a few setup commands. Paste them into LuCI → System →
   Custom Commands (or an SSH session) and run them, then tap Refresh. They give the app permission
   to read the device list and change the firewall, DNS and Wi-Fi, and nothing else.

What the app changes on the router:
- `/etc/routerpilot.json`: the app's own list of rules.
- `/etc/nftables.d/90-routerpilot.nft`: firewall rules for stopped devices, speed limits and priority.
- DNS (`dhcp` settings, dnsmasq `address` entries) for blocked websites.

Priority marks the device's traffic (DSCP class CS5 for high, CS1 for low). The router acts on it when
SQM (`luci-app-sqm`, the *cake* queue with *diffserv*) is set up; without SQM it has no effect.
Speed limits drop traffic above the limit, which the device's connections settle to.

### MikroTik

1. Turn on the REST API: IP → Services → enable **www** (or **www-ssl**, then tick *Use HTTPS* in the
   app; self-signed certificates are accepted).
2. Pick **MikroTik** in the app, user `admin` (or any user in the *full* group) and its password.

What the app adds, each with a comment starting with `routerpilot`:
- IP → Firewall → Raw: rules that stop a device's internet.
- Queues → Simple Queues: speed limits and priority. FastTrack skips queues, so the app turns the
  FastTrack rule off the first time you set a limit or priority.
- IP → DNS → Static: blocked websites. Devices must use the router for DNS (the default), and
  IP → DNS → *Allow Remote Requests* must be on.
- System → Scheduler `routerpilot-wifi-back`: when you turn Wi-Fi off, this turns it back on when the
  router restarts, then removes itself.

## Good to know

- Website blocking works through DNS. A device with a VPN or its own "Private DNS" setting can get
  around it.
- Turning Wi-Fi off from a phone that's on that Wi-Fi disconnects the phone too. The app warns first.
- The password is kept on the phone only if you tick *Remember*.

## Build

GitHub Actions builds the APK on every change to `router-android/` or `web/router/`
(`.github/workflows/router-apk.yml`) and publishes a `RouterPilot …` release. It uses the same signing
secrets as StreamBeam (`ANDROID_KEYSTORE_BASE64` and the passwords); without them it's signed with a debug key.

The screens are `web/router/` (`index.html`, `app.js`, and `drivers.js` with one driver per router
kind). The Android app (`router-android/`) bundles them and adds `window.Native`, which makes the
requests to the router (only to local-network addresses). To support another router, add a class
with the same methods to `drivers.js`.

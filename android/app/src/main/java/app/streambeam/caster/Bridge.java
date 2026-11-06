package app.streambeam.caster;

import android.Manifest;
import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.ContentResolver;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.media.projection.MediaProjectionManager;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.ParcelFileDescriptor;
import android.provider.OpenableColumns;
import android.provider.Settings;
import android.view.View;
import android.view.Window;
import android.webkit.WebView;

import androidx.webkit.JavaScriptReplyProxy;
import androidx.webkit.WebMessageCompat;
import androidx.webkit.WebViewCompat;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * The message channel between the web app and Android. The page sends {id, cmd, args};
 * replies are {id, ok, result|error}, and the app pushes {event: devices|status|session}.
 * Device ids are "cast:<route>" (Google Cast) or "dlna:<udn>" (UPnP/DLNA renderers).
 */
class Bridge implements WebViewCompat.WebMessageListener {
    private static final long SCAN_MS = 9000;
    static final int PICK_REQUEST = 43;
    static final int MIRROR_REQUEST = 44;

    private final Activity activity;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final CastHelper cast;
    private final Dlna dlna;
    private JavaScriptReplyProxy reply;
    private boolean scanning;
    private String active;
    private final Runnable endScan;
    private final LocalServer files = new LocalServer();
    private final ExecutorService work = Executors.newSingleThreadExecutor();
    private int pickId = -1;
    private int mirrorId = -1;
    private String mirrorDevice;
    private boolean mirrorStoppedByPage;
    private String relayUrl;
    private boolean mirrorSound;
    private final java.util.concurrent.ExecutorService net = Executors.newCachedThreadPool();

    Bridge(Activity activity) {
        this.activity = activity;
        cast = CastHelper.create(activity, this);
        dlna = new Dlna(activity, this);
        dlna.listen();
        endScan = () -> {
            scanning = false;
            cast.stopActiveScan();
            devicesChanged();
        };
    }

    @Override
    public void onPostMessage(WebView view, WebMessageCompat message, Uri sourceOrigin, boolean isMainFrame, JavaScriptReplyProxy replyProxy) {
        if (!isMainFrame) return;
        reply = replyProxy;
        int id = 0;
        try {
            JSONObject m = new JSONObject(message.getData());
            id = m.optInt("id");
            JSONObject args = m.optJSONObject("args");
            handle(id, m.optString("cmd"), args != null ? args : new JSONObject());
        } catch (Exception e) {
            reply(id, false, e.getMessage());
        }
    }

    private void handle(int id, String cmd, JSONObject a) throws JSONException {
        Done done = callback(id);
        switch (cmd) {
            case "scan":
                startScan();
                done.ok();
                break;
            case "stopScan":
                main.removeCallbacks(endScan);
                endScan.run();
                done.ok();
                break;
            case "connect": {
                String device = a.getString("deviceId");
                if (cast.has(device)) cast.connect(device, wrap(device, done));
                else if (dlna.has(device)) {
                    active = device;
                    done.ok();
                } else done.fail("That screen isn’t available. Search again.");
                break;
            }
            case "play": {
                String device = a.getString("deviceId");
                Media media = new Media(a.getString("url"), a.optString("title", "Video"), a.optString("mime", "video/mp4"), a.optDouble("start", 0), a.optBoolean("live"));
                if (!cast.has(device) && !dlna.has(device)) {
                    done.fail("That screen isn’t available. Search again.");
                } else if (dlna.has(device) && isHls(media)) {
                    // Many car units can't play HLS: relay the channel to them as one continuous MPEG-TS stream.
                    String host = dlna.hostOf(device);
                    work.execute(() -> {
                        try {
                            if (relayUrl != null) files.remove(relayUrl);
                            relayUrl = files.addLive(new HlsRelay(media.url), "channel.ts", "video/mp2t");
                            Media relayed = new Media(files.publicUrl(relayUrl, host), media.title, "video/mp2t", 0, true);
                            main.post(() -> startPlay(device, relayed, done));
                        } catch (IOException e) {
                            main.post(() -> done.fail("Couldn’t start the channel."));
                        }
                    });
                } else if (files.owns(media.url)) {
                    // A file from this phone: give the screen this phone's address on the network that reaches it.
                    String host = cast.has(device) ? cast.hostOf(device) : dlna.hostOf(device);
                    work.execute(() -> {
                        Media shared = media.withUrl(files.publicUrl(media.url, host));
                        main.post(() -> startPlay(device, shared, done));
                    });
                } else startPlay(device, media, done);
                break;
            }
            case "pickFiles":
                pickFiles(id);
                break;
            case "mirrorStart":
                startMirror(id, a.getString("deviceId"), a.optBoolean("sound", true));
                break;
            case "mirrorStop":
                mirrorStoppedByPage = MirrorService.isRunning();
                stopMirror();
                done.ok();
                break;
            case "pause":
            case "resume":
            case "seek":
            case "volume":
            case "rate":
            case "stop": {
                double value = a.optDouble("value", 0);
                if (active == null) done.fail("Nothing is playing on a screen.");
                else if (active.startsWith("cast:")) cast.command(cmd, value, done);
                else dlna.command(cmd, value, done);
                break;
            }
            case "disconnect":
                cast.disconnect();
                dlna.disconnect();
                active = null;
                done.ok();
                break;
            case "http":
                fetch(id, a.getString("url"));
                break;
            case "proxy": {
                String target = a.getString("url");
                work.execute(() -> {
                    try {
                        String local = files.proxyUrl(target);
                        send(new JSONObject().put("id", id).put("ok", true).put("result", new JSONObject().put("url", local)));
                    } catch (Exception e) {
                        reply(id, false, "Couldn’t open the stream.");
                    }
                });
                break;
            }
            case "theme":
                applyTheme(a.optBoolean("dark"), a.optString("top", "#D9DADE"), a.optString("bottom", "#FCFCFD"));
                done.ok();
                break;
            case "openCastSettings":
                openCastSettings();
                done.ok();
                break;
            default:
                done.fail("Unknown command: " + cmd);
        }
    }

    private static boolean isHls(Media m) {
        String path = m.url.split("\\?")[0].toLowerCase(java.util.Locale.US);
        return m.mime.toLowerCase(java.util.Locale.US).contains("mpegurl") || path.endsWith(".m3u8");
    }

    private void startPlay(String device, Media media, Done done) {
        if (cast.has(device)) cast.play(device, media, wrap(device, done));
        else if (dlna.has(device)) dlna.play(device, media, wrap(device, done));
        else done.fail("That screen isn’t available. Search again.");
    }

    /* ---------- Mirror to a DLNA screen: the phone screen as a live MPEG-TS video ---------- */

    private void startMirror(int id, String device, boolean sound) {
        if (!dlna.has(device)) {
            reply(id, false, cast.has(device) ? "For Chromecast and Google TV, use Android’s Cast option." : "That screen isn’t available. Search again.");
            return;
        }
        if (MirrorService.isRunning()) MirrorService.stop(activity);
        mirrorId = id;
        mirrorDevice = device;
        mirrorSound = sound && Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q;
        List<String> ask = new ArrayList<>();
        if (Build.VERSION.SDK_INT >= 33 && activity.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            ask.add(Manifest.permission.POST_NOTIFICATIONS); // for the Stop notification
        }
        if (mirrorSound && activity.checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            ask.add(Manifest.permission.RECORD_AUDIO); // to send the phone's sound with the picture
        }
        if (!ask.isEmpty()) activity.requestPermissions(ask.toArray(new String[0]), 45);
        MediaProjectionManager mpm = (MediaProjectionManager) activity.getSystemService(Activity.MEDIA_PROJECTION_SERVICE);
        activity.startActivityForResult(mpm.createScreenCaptureIntent(), MIRROR_REQUEST);
    }

    /** Called by the activity with Android's screen-sharing consent. */
    void onMirrorPermission(int resultCode, Intent data) {
        int id = mirrorId;
        mirrorId = -1;
        String device = mirrorDevice;
        if (id < 0) return;
        if (resultCode != Activity.RESULT_OK || data == null) {
            reply(id, false, "Screen sharing wasn’t allowed.");
            return;
        }
        final boolean[] answered = {false};
        MirrorService.server = files;
        MirrorService.listener = new MirrorService.Listener() {
            @Override
            public void onLive(String localUrl) {
                String host = dlna.hostOf(device);
                work.execute(() -> {
                    Media screen = new Media(files.publicUrl(localUrl, host), "Phone screen", "video/mp2t", 0, true);
                    main.post(() -> dlna.play(device, screen, new Done() {
                        @Override
                        public void ok() {
                            active = device;
                            answered[0] = true;
                            reply(id, true, null);
                            mirrorEvent("live", null);
                        }

                        @Override
                        public void fail(String error) {
                            answered[0] = true;
                            reply(id, false, error);
                            main.post(() -> MirrorService.stop(activity));
                        }
                    }));
                });
            }

            @Override
            public void onStopped(String error) {
                if (!answered[0]) {
                    answered[0] = true;
                    reply(id, false, error != null ? error : "Screen sharing stopped.");
                }
                // Stopped from the notification or by Android: stop the screen too. When the page stopped it,
                // the page decides (it may be about to play a video there).
                if (!mirrorStoppedByPage && device != null && device.equals(active)) dlna.command("stop", 0, quiet());
                mirrorStoppedByPage = false;
                mirrorEvent("stopped", error);
            }
        };
        Intent service = new Intent(activity, MirrorService.class)
                .putExtra(MirrorService.EXTRA_CODE, resultCode)
                .putExtra(MirrorService.EXTRA_DATA, data)
                .putExtra(MirrorService.EXTRA_SOUND, mirrorSound);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) activity.startForegroundService(service);
        else activity.startService(service);
    }

    private void stopMirror() {
        if (MirrorService.isRunning()) MirrorService.stop(activity);
    }

    private void mirrorEvent(String state, String error) {
        try {
            JSONObject o = new JSONObject().put("event", "mirror").put("state", state).put("deviceId", mirrorDevice);
            if (error != null) o.put("error", error);
            send(o);
        } catch (JSONException ignored) {
        }
    }

    private static Done quiet() {
        return new Done() {
            @Override
            public void ok() {
            }

            @Override
            public void fail(String error) {
            }
        };
    }

    /* ---------- Files from this phone ---------- */

    private void pickFiles(int id) {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType("*/*");
        intent.putExtra(Intent.EXTRA_MIME_TYPES, new String[]{"video/*", "audio/*"});
        intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
        pickId = id;
        try {
            activity.startActivityForResult(intent, PICK_REQUEST);
        } catch (ActivityNotFoundException e) {
            pickId = -1;
            reply(id, false, "No file picker on this phone.");
        }
    }

    /** Called by the activity with the picker's result. */
    void onFilesPicked(int resultCode, Intent data) {
        int id = pickId;
        pickId = -1;
        if (id < 0) return;
        List<Uri> uris = new ArrayList<>();
        if (resultCode == Activity.RESULT_OK && data != null) {
            ClipData clip = data.getClipData();
            if (clip != null) for (int i = 0; i < clip.getItemCount(); i++) uris.add(clip.getItemAt(i).getUri());
            else if (data.getData() != null) uris.add(data.getData());
        }
        work.execute(() -> {
            JSONArray list = new JSONArray();
            for (Uri uri : uris) {
                try {
                    list.put(register(uri));
                } catch (Exception ignored) {
                }
            }
            try {
                send(new JSONObject().put("id", id).put("ok", true).put("result", new JSONObject().put("files", list)));
            } catch (JSONException ignored) {
            }
        });
    }

    private JSONObject register(Uri uri) throws IOException, JSONException {
        ContentResolver resolver = activity.getContentResolver();
        String name = "Video";
        long size = -1;
        try (Cursor c = resolver.query(uri, new String[]{OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE}, null, null, null)) {
            if (c != null && c.moveToFirst()) {
                if (!c.isNull(0)) name = c.getString(0);
                if (!c.isNull(1)) size = c.getLong(1);
            }
        }
        String mime = resolver.getType(uri);
        if (mime == null) mime = "video/mp4";
        final long length = size;
        LocalServer.Source source = new LocalServer.Source() {
            @Override
            public long size() {
                return length;
            }

            @Override
            public InputStream open(long offset) throws IOException {
                ParcelFileDescriptor pfd = resolver.openFileDescriptor(uri, "r");
                if (pfd == null) throw new IOException("Can’t open the file.");
                FileInputStream in = new ParcelFileDescriptor.AutoCloseInputStream(pfd);
                try {
                    in.getChannel().position(offset);
                } catch (IOException e) {
                    long skipped = 0;
                    while (skipped < offset) {
                        long n = in.skip(offset - skipped);
                        if (n <= 0) break;
                        skipped += n;
                    }
                }
                return in;
            }
        };
        String url = files.add(source, name, mime);
        return new JSONObject().put("url", url).put("name", name).put("size", size).put("mime", mime);
    }

    /** Remembers which screen is in use once a command to it succeeds. */
    private Done wrap(String device, Done done) {
        return new Done() {
            @Override
            public void ok() {
                active = device;
                done.ok();
            }

            @Override
            public void fail(String error) {
                done.fail(error);
            }
        };
    }

    private Done callback(int id) {
        return new Done() {
            @Override
            public void ok() {
                reply(id, true, null);
            }

            @Override
            public void fail(String error) {
                reply(id, false, error);
            }
        };
    }

    private void startScan() {
        scanning = true;
        cast.startActiveScan();
        dlna.discover();
        main.removeCallbacks(endScan);
        main.postDelayed(endScan, SCAN_MS);
        devicesChanged();
    }

    /** Status and navigation bars take the colours at the top and bottom of the page, with matching icons. */
    @SuppressWarnings("deprecation")
    private void applyTheme(boolean dark, String top, String bottom) {
        Window w = activity.getWindow();
        try {
            w.setStatusBarColor(Color.parseColor(top));
            w.setNavigationBarColor(Color.parseColor(bottom));
        } catch (IllegalArgumentException ignored) {
        }
        View decor = w.getDecorView();
        int flags = decor.getSystemUiVisibility();
        flags = dark ? flags & ~View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR : flags | View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            flags = dark ? flags & ~View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR : flags | View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
        }
        decor.setSystemUiVisibility(flags);
    }

    private void openCastSettings() {
        try {
            activity.startActivity(new Intent(Settings.ACTION_CAST_SETTINGS));
        } catch (ActivityNotFoundException e) {
            activity.startActivity(new Intent(Settings.ACTION_WIRELESS_SETTINGS));
        }
    }

    /** Sends the full list of screens found so far. Safe to call from any thread. */
    void devicesChanged() {
        main.post(() -> {
            try {
                JSONArray list = new JSONArray();
                for (JSONObject d : cast.devices()) list.put(d);
                for (JSONObject d : dlna.devices()) list.put(d);
                send(new JSONObject().put("event", "devices").put("scanning", scanning).put("devices", list));
            } catch (JSONException ignored) {
            }
        });
    }

    void status(String device, String state, double position, double duration) {
        // The car stopped playing the mirror (its receiver closed or was switched away): stop capturing too.
        if ("ended".equals(state) && MirrorService.isRunning() && device != null && device.equals(mirrorDevice)) {
            main.post(() -> MirrorService.stop(activity));
        }
        try {
            send(new JSONObject().put("event", "status").put("deviceId", device).put("state", state)
                    .put("position", position).put("duration", duration));
        } catch (JSONException ignored) {
        }
    }

    void session(String device, String state, String error) {
        if ("ended".equals(state) && device != null && device.equals(active)) active = null;
        if ("ended".equals(state) && MirrorService.isRunning() && device != null && device.equals(mirrorDevice)) {
            main.post(() -> MirrorService.stop(activity));
        }
        try {
            JSONObject o = new JSONObject().put("event", "session").put("deviceId", device).put("state", state);
            if (error != null) o.put("error", error);
            send(o);
        } catch (JSONException ignored) {
        }
    }

    /**
     * GET for the page (IPTV provider APIs and playlists, which don't allow cross-site requests from a web page).
     * Text only, at most 40 MB; redirects between http and https are followed.
     */
    private void fetch(int id, String url) {
        if (!url.matches("(?i)^https?://.+")) {
            reply(id, false, "Only web addresses can be opened.");
            return;
        }
        net.execute(() -> {
            try {
                String target = url;
                for (int hop = 0; hop < 6; hop++) {
                    java.net.HttpURLConnection c = (java.net.HttpURLConnection) new java.net.URL(target).openConnection();
                    c.setConnectTimeout(10000);
                    c.setReadTimeout(30000);
                    c.setInstanceFollowRedirects(false);
                    c.setRequestProperty("User-Agent", "Mozilla/5.0 (Linux; Android) StreamBeam");
                    int code = c.getResponseCode();
                    String loc = c.getHeaderField("Location");
                    if (code >= 300 && code < 400 && loc != null) {
                        target = new java.net.URL(new java.net.URL(target), loc).toString();
                        c.disconnect();
                        continue;
                    }
                    InputStream in = code >= 400 ? c.getErrorStream() : c.getInputStream();
                    java.io.ByteArrayOutputStream body = new java.io.ByteArrayOutputStream();
                    if (in != null) {
                        try (InputStream s = in) {
                            byte[] b = new byte[64 * 1024];
                            int n;
                            while ((n = s.read(b)) > 0) {
                                body.write(b, 0, n);
                                if (body.size() > 40 << 20) throw new IOException("The list is too large.");
                            }
                        }
                    }
                    c.disconnect();
                    send(new JSONObject().put("id", id).put("ok", true).put("result",
                            new JSONObject().put("status", code).put("text", new String(body.toByteArray(), java.nio.charset.StandardCharsets.UTF_8))));
                    return;
                }
                reply(id, false, "Too many redirects.");
            } catch (Exception e) {
                reply(id, false, "Couldn’t reach the server. Check the address and your connection.");
            }
        });
    }

    private void reply(int id, boolean ok, String error) {
        try {
            JSONObject o = new JSONObject().put("id", id).put("ok", ok);
            if (!ok) o.put("error", error != null ? error : "Something went wrong.");
            send(o);
        } catch (JSONException ignored) {
        }
    }

    /** Posts a message to the page. The reply proxy must be used on the main thread. */
    private void send(JSONObject message) {
        String text = message.toString();
        main.post(() -> {
            if (reply != null) reply.postMessage(text);
        });
    }

    void release() {
        stopMirror();
        main.removeCallbacksAndMessages(null);
        files.release();
        work.shutdownNow();
        net.shutdownNow();
        cast.release();
        dlna.release();
    }

    /** A video to play on a screen. */
    static final class Media {
        final String url, title, mime;
        final double start;
        final boolean live;

        Media(String url, String title, String mime, double start, boolean live) {
            this.url = url;
            this.title = title;
            this.mime = mime;
            this.start = start;
            this.live = live;
        }

        Media withUrl(String newUrl) {
            return new Media(newUrl, title, mime, start, live);
        }
    }
}

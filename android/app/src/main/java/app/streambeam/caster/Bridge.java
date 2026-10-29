package app.streambeam.caster;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.webkit.WebView;

import androidx.webkit.JavaScriptReplyProxy;
import androidx.webkit.WebMessageCompat;
import androidx.webkit.WebViewCompat;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * The message channel between the web app and Android. The page sends {id, cmd, args};
 * replies are {id, ok, result|error}, and the app pushes {event: devices|status|session}.
 * Device ids are "cast:<route>" (Google Cast) or "dlna:<udn>" (UPnP/DLNA renderers).
 */
class Bridge implements WebViewCompat.WebMessageListener {
    private static final long SCAN_MS = 9000;

    private final Activity activity;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final CastHelper cast;
    private final Dlna dlna;
    private JavaScriptReplyProxy reply;
    private boolean scanning;
    private String active;
    private final Runnable endScan = () -> {
        this.scanning = false;
        this.cast.stopActiveScan();
        this.devicesChanged();
    };

    Bridge(Activity activity) {
        this.activity = activity;
        cast = CastHelper.create(activity, this);
        dlna = new Dlna(activity, this);
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
                if (cast.has(device)) cast.play(device, media, wrap(device, done));
                else if (dlna.has(device)) dlna.play(device, media, wrap(device, done));
                else done.fail("That screen isn’t available. Search again.");
                break;
            }
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
            case "openCastSettings":
                openCastSettings();
                done.ok();
                break;
            default:
                done.fail("Unknown command: " + cmd);
        }
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
        try {
            send(new JSONObject().put("event", "status").put("deviceId", device).put("state", state)
                    .put("position", position).put("duration", duration));
        } catch (JSONException ignored) {
        }
    }

    void session(String device, String state, String error) {
        if ("ended".equals(state) && device != null && device.equals(active)) active = null;
        try {
            JSONObject o = new JSONObject().put("event", "session").put("deviceId", device).put("state", state);
            if (error != null) o.put("error", error);
            send(o);
        } catch (JSONException ignored) {
        }
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
        main.removeCallbacksAndMessages(null);
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
    }
}

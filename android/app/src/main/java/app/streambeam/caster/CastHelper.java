package app.streambeam.caster;

import android.content.Context;

import androidx.mediarouter.media.MediaRouteSelector;
import androidx.mediarouter.media.MediaRouter;

import com.google.android.gms.cast.CastMediaControlIntent;
import com.google.android.gms.cast.MediaInfo;
import com.google.android.gms.cast.MediaLoadRequestData;
import com.google.android.gms.cast.MediaMetadata;
import com.google.android.gms.cast.MediaSeekOptions;
import com.google.android.gms.cast.MediaStatus;
import com.google.android.gms.cast.framework.CastContext;
import com.google.android.gms.cast.framework.CastSession;
import com.google.android.gms.cast.framework.SessionManager;
import com.google.android.gms.cast.framework.SessionManagerListener;
import com.google.android.gms.cast.framework.media.RemoteMediaClient;

import org.json.JSONException;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

/**
 * Google Cast screens (Chromecast, Google TV, Cast-enabled TVs and head units), found with Android's
 * media router and played on with the Cast SDK's default media receiver. All calls run on the main thread.
 * If Google Play services is missing, Cast is off and only DLNA screens are offered.
 */
class CastHelper {
    private final Bridge bridge;
    private final MediaRouter router;
    private final MediaRouteSelector selector;
    private final SessionManager sessions;
    private String sessionDevice, pendingDevice, lastState = "";
    private Done pendingConnect;
    private RemoteMediaClient client;

    private final MediaRouter.Callback routes = new MediaRouter.Callback() {
        @Override
        public void onRouteAdded(MediaRouter r, MediaRouter.RouteInfo route) {
            bridge.devicesChanged();
        }

        @Override
        public void onRouteRemoved(MediaRouter r, MediaRouter.RouteInfo route) {
            bridge.devicesChanged();
        }

        @Override
        public void onRouteChanged(MediaRouter r, MediaRouter.RouteInfo route) {
            bridge.devicesChanged();
        }
    };

    private final RemoteMediaClient.Callback statusCallback = new RemoteMediaClient.Callback() {
        @Override
        public void onStatusUpdated() {
            reportStatus();
        }
    };

    private final RemoteMediaClient.ProgressListener progress = (positionMs, durationMs) -> reportStatus();

    private final SessionManagerListener<CastSession> sessionListener = new SessionManagerListener<CastSession>() {
        @Override
        public void onSessionStarting(CastSession session) {
        }

        @Override
        public void onSessionStarted(CastSession session, String sessionId) {
            connected(session);
        }

        @Override
        public void onSessionStartFailed(CastSession session, int error) {
            failed("Couldn’t connect to the screen (error " + error + ").");
        }

        @Override
        public void onSessionEnding(CastSession session) {
        }

        @Override
        public void onSessionEnded(CastSession session, int error) {
            detachClient();
            String ended = sessionDevice;
            sessionDevice = null;
            if (ended != null) bridge.session(ended, "ended", null);
        }

        @Override
        public void onSessionResuming(CastSession session, String sessionId) {
        }

        @Override
        public void onSessionResumed(CastSession session, boolean wasSuspended) {
            connected(session);
        }

        @Override
        public void onSessionResumeFailed(CastSession session, int error) {
            failed("Couldn’t reconnect to the screen (error " + error + ").");
        }

        @Override
        public void onSessionSuspended(CastSession session, int reason) {
        }
    };

    static CastHelper create(Context context, Bridge bridge) {
        try {
            return new CastHelper(context, bridge);
        } catch (Throwable t) {
            return new CastHelper(bridge);
        }
    }

    @SuppressWarnings("deprecation")
    private CastHelper(Context context, Bridge bridge) {
        this.bridge = bridge;
        CastContext cast = CastContext.getSharedInstance(context);
        sessions = cast.getSessionManager();
        router = MediaRouter.getInstance(context);
        selector = new MediaRouteSelector.Builder()
                .addControlCategory(CastMediaControlIntent.categoryForCast(CastMediaControlIntent.DEFAULT_MEDIA_RECEIVER_APPLICATION_ID))
                .build();
        router.addCallback(selector, routes, 0);
        sessions.addSessionManagerListener(sessionListener, CastSession.class);
    }

    /** Cast unavailable (no Google Play services). */
    private CastHelper(Bridge bridge) {
        this.bridge = bridge;
        router = null;
        selector = null;
        sessions = null;
    }

    void startActiveScan() {
        if (router != null) router.addCallback(selector, routes, MediaRouter.CALLBACK_FLAG_PERFORM_ACTIVE_SCAN);
    }

    void stopActiveScan() {
        if (router != null) router.addCallback(selector, routes, 0);
    }

    private List<MediaRouter.RouteInfo> castRoutes() {
        List<MediaRouter.RouteInfo> list = new ArrayList<>();
        if (router == null) return list;
        for (MediaRouter.RouteInfo r : router.getRoutes()) {
            if (!r.isDefault() && r.isEnabled() && r.matchesSelector(selector)) list.add(r);
        }
        return list;
    }

    private MediaRouter.RouteInfo find(String device) {
        for (MediaRouter.RouteInfo r : castRoutes()) if (("cast:" + r.getId()).equals(device)) return r;
        return null;
    }

    boolean has(String device) {
        return device.startsWith("cast:") && (find(device) != null || device.equals(sessionDevice));
    }

    List<JSONObject> devices() {
        List<JSONObject> list = new ArrayList<>();
        for (MediaRouter.RouteInfo r : castRoutes()) {
            try {
                list.add(new JSONObject().put("id", "cast:" + r.getId()).put("name", r.getName()).put("type", "cast")
                        .put("model", r.getDescription() != null ? r.getDescription() : "").put("host", ""));
            } catch (JSONException ignored) {
            }
        }
        return list;
    }

    private CastSession current() {
        return sessions != null ? sessions.getCurrentCastSession() : null;
    }

    void connect(String device, Done done) {
        CastSession session = current();
        if (session != null && session.isConnected() && device.equals(sessionDevice)) {
            done.ok();
            return;
        }
        MediaRouter.RouteInfo route = find(device);
        if (route == null) {
            done.fail("That screen isn’t available. Search again.");
            return;
        }
        if (pendingConnect != null) pendingConnect.fail("Connecting to another screen instead.");
        pendingConnect = done;
        pendingDevice = device;
        router.selectRoute(route);
    }

    private void connected(CastSession session) {
        if (pendingDevice != null) sessionDevice = pendingDevice;
        pendingDevice = null;
        attachClient(session);
        if (sessionDevice != null) bridge.session(sessionDevice, "connected", null);
        Done done = pendingConnect;
        pendingConnect = null;
        if (done != null) done.ok();
    }

    private void failed(String error) {
        Done done = pendingConnect;
        String device = pendingDevice;
        pendingConnect = null;
        pendingDevice = null;
        if (done != null) done.fail(error);
        else if (device != null) bridge.session(device, "failed", error);
    }

    void play(String device, Bridge.Media media, Done done) {
        connect(device, new Done() {
            @Override
            public void ok() {
                load(media, done);
            }

            @Override
            public void fail(String error) {
                done.fail(error);
            }
        });
    }

    private void load(Bridge.Media media, Done done) {
        CastSession session = current();
        RemoteMediaClient c = session != null ? session.getRemoteMediaClient() : null;
        if (c == null) {
            done.fail("The screen isn’t ready. Try again.");
            return;
        }
        MediaMetadata meta = new MediaMetadata(media.mime.startsWith("audio") ? MediaMetadata.MEDIA_TYPE_MUSIC_TRACK : MediaMetadata.MEDIA_TYPE_MOVIE);
        meta.putString(MediaMetadata.KEY_TITLE, media.title);
        MediaInfo info = new MediaInfo.Builder(media.url)
                .setContentType(media.mime)
                .setStreamType(media.live ? MediaInfo.STREAM_TYPE_LIVE : MediaInfo.STREAM_TYPE_BUFFERED)
                .setMetadata(meta)
                .build();
        MediaLoadRequestData request = new MediaLoadRequestData.Builder()
                .setMediaInfo(info)
                .setAutoplay(true)
                .setCurrentTime((long) (media.start * 1000))
                .build();
        lastState = "";
        c.load(request).setResultCallback(result -> {
            if (result.getStatus().isSuccess()) done.ok();
            else done.fail("The screen couldn’t play this video (" + result.getStatus().getStatusCode() + ").");
        });
    }

    void command(String cmd, double value, Done done) {
        RemoteMediaClient c = client;
        if (c == null) {
            done.fail("Nothing is playing on a screen.");
            return;
        }
        switch (cmd) {
            case "pause":
                c.pause();
                break;
            case "resume":
                c.play();
                break;
            case "seek":
                c.seek(new MediaSeekOptions.Builder().setPosition((long) (value * 1000)).build());
                break;
            case "volume":
                c.setStreamVolume(value);
                break;
            case "rate":
                c.setPlaybackRate(value);
                break;
            case "stop":
                c.stop();
                break;
            default:
                done.fail("Unknown command.");
                return;
        }
        done.ok();
    }

    private void attachClient(CastSession session) {
        detachClient();
        client = session.getRemoteMediaClient();
        if (client != null) {
            client.registerCallback(statusCallback);
            client.addProgressListener(progress, 1000);
        }
    }

    private void detachClient() {
        if (client != null) {
            client.unregisterCallback(statusCallback);
            client.removeProgressListener(progress);
        }
        client = null;
    }

    private void reportStatus() {
        RemoteMediaClient c = client;
        if (c == null || sessionDevice == null || c.getMediaStatus() == null) return;
        String state;
        switch (c.getPlayerState()) {
            case MediaStatus.PLAYER_STATE_PLAYING:
                state = "playing";
                break;
            case MediaStatus.PLAYER_STATE_PAUSED:
                state = "paused";
                break;
            case MediaStatus.PLAYER_STATE_BUFFERING:
                state = "buffering";
                break;
            default:
                state = c.getIdleReason() == MediaStatus.IDLE_REASON_FINISHED ? "ended" : "idle";
        }
        if ("ended".equals(state) && "ended".equals(lastState)) return;
        lastState = state;
        bridge.status(sessionDevice, state, c.getApproximateStreamPosition() / 1000.0, Math.max(0, c.getStreamDuration()) / 1000.0);
    }

    void disconnect() {
        if (sessions != null) sessions.endCurrentSession(true);
    }

    void release() {
        detachClient();
        if (router != null) router.removeCallback(routes);
        if (sessions != null) sessions.removeSessionManagerListener(sessionListener, CastSession.class);
    }
}

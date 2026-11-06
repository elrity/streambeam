package app.streambeam.caster;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.media.projection.MediaProjection;
import android.media.projection.MediaProjectionManager;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;

/**
 * Keeps screen capture running (Android requires a foreground service with a visible notification)
 * and owns the encoder and the live stream for one mirroring session.
 */
public class MirrorService extends Service {
    /** What the bridge hears about the session. Called on the main thread. */
    interface Listener {
        void onLive(String localUrl);

        void onStopped(String error);
    }

    static final String EXTRA_CODE = "code", EXTRA_DATA = "data", ACTION_STOP = "app.streambeam.caster.STOP_MIRROR";
    private static final String CHANNEL = "mirror";

    static LocalServer server;
    static Listener listener;
    private static MirrorService running;

    private final Handler main = new Handler(Looper.getMainLooper());
    private MediaProjection projection;
    private ScreenEncoder encoder;
    private LiveStream stream;
    private String url;
    private boolean stopping;

    static boolean isRunning() {
        return running != null;
    }

    static void stop(Context context) {
        if (running != null) running.finish(null);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent == null || ACTION_STOP.equals(intent.getAction())) {
            finish(null);
            return START_NOT_STICKY;
        }
        startForegroundNotice();
        running = this;
        try {
            MediaProjectionManager mpm = (MediaProjectionManager) getSystemService(MEDIA_PROJECTION_SERVICE);
            @SuppressWarnings("deprecation")
            Intent data = intent.getParcelableExtra(EXTRA_DATA);
            projection = mpm.getMediaProjection(intent.getIntExtra(EXTRA_CODE, 0), data);
            if (projection == null) throw new IllegalStateException("Screen sharing wasn’t allowed.");
            projection.registerCallback(new MediaProjection.Callback() {
                @Override
                public void onStop() {
                    finish(null);
                }
            }, main);
            stream = new LiveStream(() -> {
                ScreenEncoder e = encoder;
                if (e != null) e.requestKeyFrame();
            });
            encoder = new ScreenEncoder(projection, getResources().getDisplayMetrics().densityDpi, stream);
            encoder.start();
            url = server.addLive(stream, "phone-screen.ts", "video/mp2t");
            if (listener != null) listener.onLive(url);
        } catch (Exception e) {
            finish(e.getMessage() != null ? e.getMessage() : "Couldn’t start screen sharing.");
        }
        return START_NOT_STICKY;
    }

    private void startForegroundNotice() {
        NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        Notification.Builder b;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            nm.createNotificationChannel(new NotificationChannel(CHANNEL, "Screen mirroring", NotificationManager.IMPORTANCE_LOW));
            b = new Notification.Builder(this, CHANNEL);
        } else {
            b = new Notification.Builder(this);
        }
        PendingIntent stop = PendingIntent.getService(this, 1, new Intent(this, MirrorService.class).setAction(ACTION_STOP),
                PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        PendingIntent open = PendingIntent.getActivity(this, 2, new Intent(this, MainActivity.class),
                PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        Notification n = b.setSmallIcon(R.drawable.ic_stat_mirror)
                .setContentTitle("Mirroring your screen")
                .setContentText("StreamBeam is sending your screen to the car screen.")
                .setContentIntent(open)
                .setOngoing(true)
                .addAction(new Notification.Action.Builder(null, "Stop", stop).build())
                .build();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) startForeground(7, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION);
        else startForeground(7, n);
    }

    private void finish(String error) {
        if (stopping) return;
        stopping = true;
        if (stream != null) stream.close();
        if (encoder != null) encoder.stop();
        if (url != null && server != null) server.remove(url);
        if (projection != null) {
            try {
                projection.stop();
            } catch (Exception ignored) {
            }
        }
        running = null;
        if (listener != null) listener.onStopped(error);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) stopForeground(STOP_FOREGROUND_REMOVE);
        else stopForeground(true);
        stopSelf();
    }

    @Override
    public void onDestroy() {
        finish(null);
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}

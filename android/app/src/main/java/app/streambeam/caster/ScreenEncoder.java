package app.streambeam.caster;

import android.hardware.display.DisplayManager;
import android.hardware.display.VirtualDisplay;
import android.media.MediaCodec;
import android.media.MediaCodecInfo;
import android.media.MediaFormat;
import android.media.projection.MediaProjection;
import android.os.Build;
import android.os.Bundle;
import android.view.Surface;

import java.io.IOException;
import java.nio.ByteBuffer;

/**
 * Captures the phone screen into the hardware H.264 encoder and publishes each frame as MPEG-TS.
 * 1280×720 at 30 fps: a size car screens and TVs decode; a portrait phone screen appears centred.
 */
class ScreenEncoder {
    static final int WIDTH = 1280, HEIGHT = 720;

    private final MediaProjection projection;
    private final int dpi;
    private final LiveStream stream;
    private final TsMuxer mux;
    private MediaCodec codec;
    private Surface input;
    private VirtualDisplay display;
    private Thread drain;
    private volatile boolean running;

    ScreenEncoder(MediaProjection projection, int dpi, LiveStream stream, TsMuxer mux) {
        this.mux = mux;
        this.projection = projection;
        this.dpi = dpi;
        this.stream = stream;
    }

    void start() throws IOException {
        codec = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_VIDEO_AVC);
        try {
            codec.configure(format(true), null, null, MediaCodec.CONFIGURE_FLAG_ENCODE);
        } catch (Exception baselineRefused) {
            codec.reset();
            codec.configure(format(false), null, null, MediaCodec.CONFIGURE_FLAG_ENCODE);
        }
        input = codec.createInputSurface();
        codec.start();
        display = projection.createVirtualDisplay("StreamBeam mirror", WIDTH, HEIGHT, dpi,
                DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR, input, null, null);
        running = true;
        drain = new Thread(this::drain, "StreamBeam encoder");
        drain.start();
    }

    private static MediaFormat format(boolean baseline) {
        MediaFormat f = MediaFormat.createVideoFormat(MediaFormat.MIMETYPE_VIDEO_AVC, WIDTH, HEIGHT);
        f.setInteger(MediaFormat.KEY_COLOR_FORMAT, MediaCodecInfo.CodecCapabilities.COLOR_FormatSurface);
        f.setInteger(MediaFormat.KEY_BIT_RATE, 4_000_000);
        f.setInteger(MediaFormat.KEY_FRAME_RATE, 30);
        f.setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, 1);
        // Keep sending frames while the screen is still, so the screen's player never starves.
        f.setLong(MediaFormat.KEY_REPEAT_PREVIOUS_FRAME_AFTER, 100_000);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) f.setInteger(MediaFormat.KEY_MAX_B_FRAMES, 0);
        f.setInteger("priority", 0); // real-time: encode each frame as soon as it is drawn
        f.setInteger("latency", 1); // hand out every frame at once instead of holding a few back
        if (baseline) {
            // Baseline profile: the most widely supported H.264 on car units and TVs.
            f.setInteger(MediaFormat.KEY_PROFILE, MediaCodecInfo.CodecProfileLevel.AVCProfileBaseline);
            f.setInteger(MediaFormat.KEY_LEVEL, MediaCodecInfo.CodecProfileLevel.AVCLevel31);
        }
        return f;
    }

    private void drain() {
        MediaCodec.BufferInfo info = new MediaCodec.BufferInfo();
        while (running) {
            int index;
            try {
                index = codec.dequeueOutputBuffer(info, 20_000);
            } catch (IllegalStateException e) {
                break;
            }
            if (index < 0) continue;
            ByteBuffer buf = codec.getOutputBuffer(index);
            if (buf != null && info.size > 0) {
                byte[] data = new byte[info.size];
                buf.position(info.offset);
                buf.get(data, 0, info.size);
                if ((info.flags & MediaCodec.BUFFER_FLAG_CODEC_CONFIG) != 0) mux.setConfig(data);
                else {
                    boolean key = (info.flags & MediaCodec.BUFFER_FLAG_KEY_FRAME) != 0;
                    stream.publish(mux.frame(data, info.presentationTimeUs, key), key);
                }
            }
            codec.releaseOutputBuffer(index, false);
        }
    }

    /** Asks for a key frame now, so a screen that just connected can start at once. */
    void requestKeyFrame() {
        MediaCodec c = codec;
        if (c == null || !running) return;
        try {
            Bundle b = new Bundle();
            b.putInt(MediaCodec.PARAMETER_KEY_REQUEST_SYNC_FRAME, 0);
            c.setParameters(b);
        } catch (IllegalStateException ignored) {
        }
    }

    void stop() {
        running = false;
        try {
            if (drain != null) drain.join(500);
        } catch (InterruptedException ignored) {
        }
        if (display != null) display.release();
        if (codec != null) {
            try {
                codec.stop();
            } catch (IllegalStateException ignored) {
            }
            codec.release();
        }
        if (input != null) input.release();
        codec = null;
    }
}

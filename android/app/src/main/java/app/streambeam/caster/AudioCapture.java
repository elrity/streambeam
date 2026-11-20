package app.streambeam.caster;

import android.media.AudioAttributes;
import android.media.AudioFormat;
import android.media.AudioPlaybackCaptureConfiguration;
import android.media.AudioRecord;
import android.media.MediaCodec;
import android.media.MediaCodecInfo;
import android.media.MediaFormat;
import android.media.projection.MediaProjection;
import android.os.Build;

import androidx.annotation.RequiresApi;

import java.nio.ByteBuffer;

/**
 * Sends the phone's sound with the mirrored picture (Android 10+): captures what apps are playing
 * (media, games; apps that forbid capture stay silent) and encodes it as AAC into the same MPEG-TS stream,
 * so the car plays sound and picture together.
 */
@RequiresApi(Build.VERSION_CODES.Q)
class AudioCapture {
    static final int RATE = 48000, CHANNELS = 2;

    private final TsMuxer mux;
    private final LiveStream stream;
    private AudioRecord record;
    private MediaCodec codec;
    private Thread thread;
    private volatile boolean running;
    private volatile long lastSound;

    AudioCapture(TsMuxer mux, LiveStream stream) {
        this.mux = mux;
        this.stream = stream;
    }

    /** Sets up capture; false if it isn't possible (no permission, unsupported). Throws nothing. */
    boolean prepare(MediaProjection projection) {
        try {
            AudioPlaybackCaptureConfiguration config = new AudioPlaybackCaptureConfiguration.Builder(projection)
                    .addMatchingUsage(AudioAttributes.USAGE_MEDIA)
                    .addMatchingUsage(AudioAttributes.USAGE_GAME)
                    .addMatchingUsage(AudioAttributes.USAGE_UNKNOWN)
                    .build();
            AudioFormat format = new AudioFormat.Builder().setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                    .setSampleRate(RATE).setChannelMask(AudioFormat.CHANNEL_IN_STEREO).build();
            int min = AudioRecord.getMinBufferSize(RATE, AudioFormat.CHANNEL_IN_STEREO, AudioFormat.ENCODING_PCM_16BIT);
            record = new AudioRecord.Builder().setAudioFormat(format).setBufferSizeInBytes(Math.max(min, 8192) * 2)
                    .setAudioPlaybackCaptureConfig(config).build();
            if (record.getState() != AudioRecord.STATE_INITIALIZED) throw new IllegalStateException();
            MediaFormat f = MediaFormat.createAudioFormat(MediaFormat.MIMETYPE_AUDIO_AAC, RATE, CHANNELS);
            f.setInteger(MediaFormat.KEY_AAC_PROFILE, MediaCodecInfo.CodecProfileLevel.AACObjectLC);
            f.setInteger(MediaFormat.KEY_BIT_RATE, 128_000);
            f.setInteger(MediaFormat.KEY_MAX_INPUT_SIZE, 16384);
            codec = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_AUDIO_AAC);
            codec.configure(f, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE);
            return true;
        } catch (Exception | Error e) { // SecurityException without the permission, or no capture support
            release();
            return false;
        }
    }

    void start() {
        codec.start();
        record.startRecording();
        running = true;
        thread = new Thread(this::loop, "StreamBeam audio");
        thread.start();
    }

    /*
     * Audio runs on the real-time clock, without gaps. Android only delivers captured sound while an app is
     * playing; if the stream simply paused, the car would wait for sound and keep buffering picture
     * meanwhile, and that wait would stay as delay for the rest of the session. So any gap is filled with
     * silence, and timestamps follow the wall clock (the same one the screen frames use).
     */
    private void loop() {
        MediaCodec.BufferInfo info = new MediaCodec.BufferInfo();
        final int frameBytes = 2 * CHANNELS, chunk = 1920 * frameBytes; // 40 ms per buffer at most
        long baseUs = System.nanoTime() / 1000, samples = 0;
        int in = -1;
        while (running) {
            try {
                if (in < 0) in = codec.dequeueInputBuffer(5_000);
                if (in >= 0) {
                    ByteBuffer buf = codec.getInputBuffer(in);
                    int room = buf != null ? Math.min(buf.capacity(), chunk) : 0;
                    int n = room > 0 ? record.read(buf, room, AudioRecord.READ_NON_BLOCKING) : 0;
                    long nowUs = System.nanoTime() / 1000;
                    if (n > 0) {
                        n -= n % frameBytes;
                        if (!silent(buf, n)) lastSound = System.currentTimeMillis();
                        // Keep the sample clock on the wall clock: if sound fell more than 150 ms behind, move it
                        // forward (never back, so timestamps only grow).
                        long expected = baseUs + samples * 1_000_000 / RATE, real = nowUs - (n / frameBytes) * 1_000_000L / RATE;
                        if (real - expected > 150_000) baseUs = real - samples * 1_000_000 / RATE;
                        codec.queueInputBuffer(in, 0, n, baseUs + samples * 1_000_000 / RATE, 0);
                        samples += n / frameBytes;
                        in = -1;
                    } else {
                        long behindUs = nowUs - (baseUs + samples * 1_000_000 / RATE);
                        if (behindUs > 60_000 && room > 0) { // nothing captured for a while: send silence up to now
                            int fill = (int) Math.min(room / frameBytes, behindUs * RATE / 1_000_000) * frameBytes;
                            int at = buf.position();
                            for (int i = 0; i < fill; i++) buf.put(at + i, (byte) 0);
                            codec.queueInputBuffer(in, 0, fill, baseUs + samples * 1_000_000 / RATE, 0);
                            samples += fill / frameBytes;
                            in = -1;
                        }
                    }
                }
                int out;
                while ((out = codec.dequeueOutputBuffer(info, 0)) >= 0) {
                    ByteBuffer buf = codec.getOutputBuffer(out);
                    if (buf != null && info.size > 0 && (info.flags & MediaCodec.BUFFER_FLAG_CODEC_CONFIG) == 0) {
                        byte[] aac = new byte[info.size];
                        buf.position(info.offset);
                        buf.get(aac, 0, info.size);
                        stream.publish(mux.audio(aac, info.presentationTimeUs), false);
                    }
                    codec.releaseOutputBuffer(out, false);
                }
                if (in >= 0) Thread.sleep(5); // waiting for sound or for the clock
            } catch (IllegalStateException e) {
                break;
            } catch (InterruptedException e) {
                break;
            }
        }
    }

    /** When captured sound was last not pure silence (0 if never). */
    long lastSound() {
        return lastSound;
    }

    private static boolean silent(ByteBuffer buf, int n) {
        int start = buf.position();
        for (int i = start; i + 1 < start + n; i += 32) if (buf.get(i) != 0 || buf.get(i + 1) != 0) return false;
        return true;
    }

    void stop() {
        running = false;
        try {
            if (thread != null) thread.join(500);
        } catch (InterruptedException ignored) {
        }
        release();
    }

    private void release() {
        if (record != null) {
            try {
                record.stop();
            } catch (IllegalStateException ignored) {
            }
            record.release();
            record = null;
        }
        if (codec != null) {
            try {
                codec.stop();
            } catch (IllegalStateException ignored) {
            }
            codec.release();
            codec = null;
        }
    }
}

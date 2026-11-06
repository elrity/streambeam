package app.streambeam.caster;

import java.io.ByteArrayOutputStream;

/**
 * Packs H.264 frames (Annex-B, as MediaCodec produces them) and, optionally, AAC audio into an MPEG transport
 * stream: one program, video on PID 0x100 (which carries the clock) and audio on PID 0x101. Each frame becomes a
 * run of 188-byte packets; every key frame is preceded by the PAT/PMT tables and the stream's SPS/PPS, so a screen
 * that joins late can start at the next key frame. Video and audio come from different threads, so it's synchronized.
 */
class TsMuxer {
    private static final int PID_PMT = 0x1000, PID_VIDEO = 0x100, PID_AUDIO = 0x101;
    private static final byte[] AUD = {0, 0, 0, 1, 9, (byte) 0xF0};
    private static final int[] RATES = {96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000};

    private byte[] config = new byte[0];
    private long firstUs = -1;
    private int ccPat, ccPmt, ccVideo, ccAudio;
    private boolean audio;
    private int rateIndex = 3, channels = 2;

    /** Adds an AAC-LC track (call before the first frame). */
    synchronized void enableAudio(int sampleRate, int channelCount) {
        audio = true;
        channels = channelCount;
        for (int i = 0; i < RATES.length; i++) if (RATES[i] == sampleRate) rateIndex = i;
    }

    /** SPS/PPS from the encoder's codec-config buffer. */
    synchronized void setConfig(byte[] spsPps) {
        config = spsPps;
    }

    private long pts90(long us) {
        if (firstUs < 0) firstUs = us;
        return Math.max(0, (us - firstUs) * 90 / 1000 + 90000); // 90 kHz, starting 1 s in
    }

    /** TS packets for one encoded video frame (a multiple of 188 bytes). */
    synchronized byte[] frame(byte[] data, long ptsUs, boolean key) {
        long pts = pts90(ptsUs);
        ByteArrayOutputStream out = new ByteArrayOutputStream(data.length + 1024);
        if (key) {
            psi(out, 0, ccPat++, pat());
            psi(out, PID_PMT, ccPmt++, pmt());
        }
        boolean addConfig = key && config.length > 0 && !hasSps(data);
        ByteArrayOutputStream pes = new ByteArrayOutputStream(data.length + config.length + 32);
        pes.write(new byte[]{0, 0, 1, (byte) 0xE0, 0, 0, (byte) 0x80, (byte) 0x80, 5}, 0, 9); // video PES, unbounded, PTS only
        writePts(pes, pts);
        pes.write(AUD, 0, AUD.length);
        if (addConfig) pes.write(config, 0, config.length);
        pes.write(data, 0, data.length);
        ccVideo = packetize(out, PID_VIDEO, ccVideo, pes.toByteArray(), pts - 9000, key); // clock 100 ms ahead
        return out.toByteArray();
    }

    /** TS packets for one raw AAC frame (as MediaCodec produces it); an ADTS header is added. */
    synchronized byte[] audio(byte[] aac, long ptsUs) {
        long pts = pts90(ptsUs);
        int frameLen = aac.length + 7;
        byte[] adts = {(byte) 0xFF, (byte) 0xF1, (byte) ((1 << 6) | (rateIndex << 2) | (channels >> 2)),
                (byte) (((channels & 3) << 6) | (frameLen >> 11)), (byte) ((frameLen >> 3) & 0xFF), (byte) (((frameLen & 7) << 5) | 0x1F), (byte) 0xFC};
        int pesLen = 3 + 5 + frameLen;
        ByteArrayOutputStream pes = new ByteArrayOutputStream(pesLen + 6);
        pes.write(new byte[]{0, 0, 1, (byte) 0xC0, (byte) (pesLen >> 8), (byte) pesLen, (byte) 0x80, (byte) 0x80, 5}, 0, 9);
        writePts(pes, pts);
        pes.write(adts, 0, 7);
        pes.write(aac, 0, aac.length);
        ByteArrayOutputStream out = new ByteArrayOutputStream(pesLen + 376);
        ccAudio = packetize(out, PID_AUDIO, ccAudio, pes.toByteArray(), -1, false);
        return out.toByteArray();
    }

    private static void writePts(ByteArrayOutputStream pes, long pts) {
        pes.write((int) (0x20 | ((pts >> 29) & 0x0E) | 1));
        pes.write((int) ((pts >> 22) & 0xFF));
        pes.write((int) (((pts >> 14) & 0xFE) | 1));
        pes.write((int) ((pts >> 7) & 0xFF));
        pes.write((int) (((pts << 1) & 0xFE) | 1));
    }

    /** Splits a PES into packets; a PCR goes in the first packet when {@code pcr >= 0}. Returns the next counter. */
    private static int packetize(ByteArrayOutputStream out, int pid, int cc, byte[] pes, long pcr, boolean key) {
        int pos = 0;
        boolean first = true;
        while (pos < pes.length) {
            byte[] p = new byte[188];
            p[0] = 0x47;
            p[1] = (byte) ((first ? 0x40 : 0) | (pid >> 8));
            p[2] = (byte) pid;
            int i = 4;
            boolean withPcr = first && pcr >= 0;
            int af = withPcr ? 8 : 0; // adaptation field: length byte + flags + 6-byte PCR
            int remaining = pes.length - pos;
            int room = 184 - af;
            int stuffing = remaining < room ? room - remaining : 0;
            if (af == 0 && stuffing > 0) af = stuffing;
            else af += stuffing;
            if (af > 0) {
                p[3] = (byte) (0x30 | (cc & 0x0F)); // adaptation field + payload
                p[i++] = (byte) (af - 1);
                if (af > 1) {
                    if (withPcr) {
                        p[i++] = (byte) (0x10 | (key ? 0x40 : 0)); // PCR, random access on key frames
                        p[i++] = (byte) (pcr >> 25);
                        p[i++] = (byte) (pcr >> 17);
                        p[i++] = (byte) (pcr >> 9);
                        p[i++] = (byte) (pcr >> 1);
                        p[i++] = (byte) (((pcr & 1) << 7) | 0x7E);
                        p[i++] = 0;
                    } else p[i++] = 0;
                    while (i < 4 + af) p[i++] = (byte) 0xFF;
                }
            } else p[3] = (byte) (0x10 | (cc & 0x0F)); // payload only
            cc++;
            int n = 188 - i;
            System.arraycopy(pes, pos, p, i, n);
            pos += n;
            out.write(p, 0, 188);
            first = false;
        }
        return cc;
    }

    private static boolean hasSps(byte[] d) {
        for (int i = 0; i + 4 < d.length && i < 64; i++) {
            if (d[i] == 0 && d[i + 1] == 0 && d[i + 2] == 1 && (d[i + 3] & 0x1F) == 7) return true;
        }
        return false;
    }

    private static byte[] pat() {
        return new byte[]{0x00, (byte) 0xB0, 0x0D, 0x00, 0x01, (byte) 0xC1, 0x00, 0x00,
                0x00, 0x01, (byte) (0xE0 | (PID_PMT >> 8)), (byte) PID_PMT};
    }

    private byte[] pmt() {
        byte[] video = {0x1B, (byte) (0xE0 | (PID_VIDEO >> 8)), (byte) PID_VIDEO, (byte) 0xF0, 0x00};
        byte[] head = {0x02, (byte) 0xB0, (byte) (audio ? 0x17 : 0x12), 0x00, 0x01, (byte) 0xC1, 0x00, 0x00,
                (byte) (0xE0 | (PID_VIDEO >> 8)), (byte) PID_VIDEO, (byte) 0xF0, 0x00};
        ByteArrayOutputStream s = new ByteArrayOutputStream(32);
        s.write(head, 0, head.length);
        s.write(video, 0, video.length);
        if (audio) s.write(new byte[]{0x0F, (byte) (0xE0 | (PID_AUDIO >> 8)), (byte) PID_AUDIO, (byte) 0xF0, 0x00}, 0, 5); // AAC (ADTS)
        return s.toByteArray();
    }

    /** One table (PAT or PMT) in a single packet, with its CRC and padding. */
    private static void psi(ByteArrayOutputStream out, int pid, int cc, byte[] section) {
        byte[] p = new byte[188];
        java.util.Arrays.fill(p, (byte) 0xFF);
        p[0] = 0x47;
        p[1] = (byte) (0x40 | (pid >> 8));
        p[2] = (byte) pid;
        p[3] = (byte) (0x10 | (cc & 0x0F));
        p[4] = 0; // pointer field
        System.arraycopy(section, 0, p, 5, section.length);
        int crc = crc32(section);
        int at = 5 + section.length;
        p[at] = (byte) (crc >> 24);
        p[at + 1] = (byte) (crc >> 16);
        p[at + 2] = (byte) (crc >> 8);
        p[at + 3] = (byte) crc;
        out.write(p, 0, 188);
    }

    /** CRC-32/MPEG-2. */
    static int crc32(byte[] data) {
        int crc = 0xFFFFFFFF;
        for (byte b : data) {
            crc ^= (b & 0xFF) << 24;
            for (int k = 0; k < 8; k++) crc = (crc & 0x80000000) != 0 ? (crc << 1) ^ 0x04C11DB7 : crc << 1;
        }
        return crc;
    }
}

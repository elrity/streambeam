package app.streambeam.caster;

import java.io.ByteArrayOutputStream;

/**
 * Packs H.264 frames (Annex-B, as MediaCodec produces them) into an MPEG transport stream: one program,
 * one video stream. Each frame becomes a run of 188-byte packets; every key frame is preceded by the
 * PAT/PMT tables and the stream's SPS/PPS, so a screen that joins late can start at the next key frame.
 */
class TsMuxer {
    private static final int PID_PMT = 0x1000, PID_VIDEO = 0x100;
    private static final byte[] AUD = {0, 0, 0, 1, 9, (byte) 0xF0};

    private byte[] config = new byte[0];
    private long firstUs = -1;
    private int ccPat, ccPmt, ccVideo;

    /** SPS/PPS from the encoder's codec-config buffer. */
    void setConfig(byte[] spsPps) {
        config = spsPps;
    }

    /** Returns the TS packets for one encoded frame (a multiple of 188 bytes). */
    byte[] frame(byte[] data, long ptsUs, boolean key) {
        if (firstUs < 0) firstUs = ptsUs;
        long pts = (ptsUs - firstUs) * 90 / 1000 + 90000; // 90 kHz, starting 1 s in
        long pcr = pts - 9000; // clock 100 ms ahead of display time
        ByteArrayOutputStream out = new ByteArrayOutputStream(data.length + 1024);
        if (key) {
            psi(out, 0, ccPat++, pat());
            psi(out, PID_PMT, ccPmt++, pmt());
        }
        boolean addConfig = key && config.length > 0 && !hasSps(data);
        ByteArrayOutputStream pes = new ByteArrayOutputStream(data.length + config.length + 32);
        pes.write(new byte[]{0, 0, 1, (byte) 0xE0, 0, 0, (byte) 0x80, (byte) 0x80, 5}, 0, 9); // video PES, unbounded length, PTS only
        pes.write((int) (0x20 | ((pts >> 29) & 0x0E) | 1));
        pes.write((int) ((pts >> 22) & 0xFF));
        pes.write((int) (((pts >> 14) & 0xFE) | 1));
        pes.write((int) ((pts >> 7) & 0xFF));
        pes.write((int) (((pts << 1) & 0xFE) | 1));
        pes.write(AUD, 0, AUD.length);
        if (addConfig) pes.write(config, 0, config.length);
        pes.write(data, 0, data.length);
        packetize(out, pes.toByteArray(), pcr, key);
        return out.toByteArray();
    }

    private void packetize(ByteArrayOutputStream out, byte[] pes, long pcr, boolean key) {
        int pos = 0;
        boolean first = true;
        while (pos < pes.length) {
            byte[] p = new byte[188];
            p[0] = 0x47;
            p[1] = (byte) ((first ? 0x40 : 0) | (PID_VIDEO >> 8));
            p[2] = (byte) PID_VIDEO;
            int i = 4;
            int af = first ? 8 : 0; // adaptation field: length byte + flags + 6-byte PCR
            int remaining = pes.length - pos;
            int room = 184 - af;
            int stuffing = remaining < room ? room - remaining : 0;
            if (af == 0 && stuffing > 0) af = stuffing;
            else af += stuffing;
            if (af > 0) {
                p[3] = (byte) (0x30 | (ccVideo & 0x0F)); // adaptation field + payload
                p[i++] = (byte) (af - 1);
                if (af > 1) {
                    if (first) {
                        p[i++] = (byte) (0x10 | (key ? 0x40 : 0)); // PCR, random access on key frames
                        long base = Math.max(0, pcr);
                        p[i++] = (byte) (base >> 25);
                        p[i++] = (byte) (base >> 17);
                        p[i++] = (byte) (base >> 9);
                        p[i++] = (byte) (base >> 1);
                        p[i++] = (byte) (((base & 1) << 7) | 0x7E);
                        p[i++] = 0;
                    } else p[i++] = 0;
                    while (i < 4 + af) p[i++] = (byte) 0xFF;
                }
            } else p[3] = (byte) (0x10 | (ccVideo & 0x0F)); // payload only
            ccVideo++;
            int n = 188 - i;
            System.arraycopy(pes, pos, p, i, n);
            pos += n;
            out.write(p, 0, 188);
            first = false;
        }
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

    private static byte[] pmt() {
        return new byte[]{0x02, (byte) 0xB0, 0x12, 0x00, 0x01, (byte) 0xC1, 0x00, 0x00,
                (byte) (0xE0 | (PID_VIDEO >> 8)), (byte) PID_VIDEO, (byte) 0xF0, 0x00,
                0x1B, (byte) (0xE0 | (PID_VIDEO >> 8)), (byte) PID_VIDEO, (byte) 0xF0, 0x00};
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

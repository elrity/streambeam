package app.streambeam.caster;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

/**
 * Turns an HLS stream (most IPTV channels) into one continuous MPEG-TS stream for screens that can't play
 * HLS themselves, such as many car units. HLS is a playlist of short MPEG-TS pieces; this picks a variant
 * of at most about 4 Mbit/s, follows the playlist as it grows and writes the pieces back to back.
 * Encrypted channels and fMP4-based HLS aren't supported.
 */
class HlsRelay implements LocalServer.Live {
    private static final long MAX_BANDWIDTH = 4_000_000;
    private final String source;

    HlsRelay(String source) {
        this.source = source;
    }

    static final class Playlist {
        final List<String> segments = new ArrayList<>();
        long firstSeq;
        double target = 6;
        boolean ended, encrypted, fmp4;
    }

    @Override
    public void stream(OutputStream out) throws IOException {
        String media = pickVariant(source);
        long next = -1;
        byte[] buf = new byte[64 * 1024];
        while (!Thread.currentThread().isInterrupted()) {
            Playlist p = parse(media, fetchText(media));
            if (p.encrypted) throw new IOException("This channel is encrypted.");
            if (p.fmp4) throw new IOException("This channel uses a format the relay can't pass on.");
            long last = p.firstSeq + p.segments.size() - 1;
            if (next < 0) next = p.ended ? p.firstSeq : Math.max(p.firstSeq, last - 2); // live: start near the edge
            if (next < p.firstSeq) next = p.firstSeq; // fell behind the playlist window
            boolean wrote = false;
            for (long seq = next; seq <= last; seq++) {
                try (InputStream in = open(p.segments.get((int) (seq - p.firstSeq)))) {
                    int n;
                    while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
                }
                out.flush();
                next = seq + 1;
                wrote = true;
            }
            if (p.ended && next > last) return;
            if (!wrote) {
                try {
                    Thread.sleep((long) Math.max(1000, p.target * 500));
                } catch (InterruptedException e) {
                    return;
                }
            }
        }
    }

    /** For a master playlist, the best variant at or under the bandwidth cap (else the smallest). */
    static String pickVariant(String url) throws IOException {
        String text = fetchText(url);
        if (!text.contains("#EXT-X-STREAM-INF")) return url;
        String best = null, smallest = null;
        long bestBw = -1, smallestBw = Long.MAX_VALUE, bw = 0;
        boolean expect = false;
        for (String raw : text.split("\r?\n")) {
            String line = raw.trim();
            if (line.startsWith("#EXT-X-STREAM-INF")) {
                bw = attrLong(line, "BANDWIDTH");
                expect = true;
            } else if (expect && !line.isEmpty() && !line.startsWith("#")) {
                String u = new URL(new URL(url), line).toString();
                if (bw <= MAX_BANDWIDTH && bw > bestBw) {
                    bestBw = bw;
                    best = u;
                }
                if (bw < smallestBw) {
                    smallestBw = bw;
                    smallest = u;
                }
                expect = false;
            }
        }
        return best != null ? best : smallest != null ? smallest : url;
    }

    static Playlist parse(String url, String text) throws IOException {
        Playlist p = new Playlist();
        boolean expect = false;
        URL base = new URL(url);
        for (String raw : text.split("\r?\n")) {
            String line = raw.trim();
            if (line.startsWith("#EXT-X-MEDIA-SEQUENCE:")) p.firstSeq = Long.parseLong(line.substring(22).trim());
            else if (line.startsWith("#EXT-X-TARGETDURATION:")) p.target = Double.parseDouble(line.substring(22).trim());
            else if (line.startsWith("#EXT-X-ENDLIST")) p.ended = true;
            else if (line.startsWith("#EXT-X-MAP")) p.fmp4 = true;
            else if (line.startsWith("#EXT-X-KEY") && !line.contains("METHOD=NONE")) p.encrypted = true;
            else if (line.startsWith("#EXTINF")) expect = true;
            else if (expect && !line.isEmpty() && !line.startsWith("#")) {
                p.segments.add(new URL(base, line).toString());
                expect = false;
            }
        }
        return p;
    }

    private static long attrLong(String line, String name) {
        int i = line.indexOf(name + "=");
        if (i < 0) return 0;
        int s = i + name.length() + 1, e = s;
        while (e < line.length() && Character.isDigit(line.charAt(e))) e++;
        try {
            return Long.parseLong(line.substring(s, e));
        } catch (NumberFormatException x) {
            return 0;
        }
    }

    /** GET with redirects followed, including between http and https. */
    private static InputStream open(String url) throws IOException {
        for (int hop = 0; hop < 6; hop++) {
            HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
            c.setConnectTimeout(8000);
            c.setReadTimeout(15000);
            c.setInstanceFollowRedirects(false);
            c.setRequestProperty("User-Agent", "Mozilla/5.0 (Linux; Android) StreamBeam");
            int code = c.getResponseCode();
            if (code >= 300 && code < 400 && c.getHeaderField("Location") != null) {
                url = new URL(new URL(url), c.getHeaderField("Location")).toString();
                c.disconnect();
                continue;
            }
            if (code >= 400) {
                c.disconnect();
                throw new IOException("The channel answered " + code + ".");
            }
            return c.getInputStream();
        }
        throw new IOException("Too many redirects.");
    }

    private static String fetchText(String url) throws IOException {
        try (InputStream in = open(url)) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[16 * 1024];
            int n;
            while ((n = in.read(buf)) > 0 && out.size() < (2 << 20)) out.write(buf, 0, n);
            return new String(out.toByteArray(), StandardCharsets.UTF_8);
        }
    }
}

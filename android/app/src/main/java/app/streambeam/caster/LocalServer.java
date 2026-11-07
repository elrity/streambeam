package app.streambeam.caster;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.DatagramSocket;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.NetworkInterface;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.util.Collections;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Serves files picked on the phone so a TV or car screen can stream them over the local network
 * (screens fetch a link; they can't read the phone's storage). Only files registered here are served,
 * each under a random 128-bit token. Supports HEAD and byte ranges (screens seek with them) and
 * sends the DLNA streaming headers that many renderers expect.
 */
class LocalServer {
    /** Something that can be read from a byte offset (a picked file). */
    interface Source {
        long size();

        InputStream open(long offset) throws IOException;
    }

    /** A never-ending stream (the phone screen) written to one screen's connection until it closes. */
    interface Live {
        void stream(OutputStream out) throws IOException;
    }

    static final class Entry {
        final Source source;
        final Live live;
        final String name, mime;

        Entry(Source source, Live live, String name, String mime) {
            this.source = source;
            this.live = live;
            this.name = name;
            this.mime = mime;
        }
    }

    private static final Pattern RANGE = Pattern.compile("bytes=(\\d*)-(\\d*)");
    private final Map<String, Entry> files = new ConcurrentHashMap<>();
    private final ExecutorService pool = Executors.newCachedThreadPool();
    private final SecureRandom random = new SecureRandom();
    private ServerSocket server;
    private String proxyToken;
    private static final Pattern URI_ATTR = Pattern.compile("URI=\"([^\"]+)\"");

    /** Starts on first use; returns the port. */
    synchronized int port() throws IOException {
        if (server == null) {
            server = new ServerSocket();
            server.setReuseAddress(true);
            server.bind(new InetSocketAddress(0));
            ServerSocket s = server;
            pool.execute(() -> {
                while (!s.isClosed()) {
                    try {
                        Socket client = s.accept();
                        pool.execute(() -> handle(client));
                    } catch (IOException ignored) {
                    }
                }
            });
        }
        return server.getLocalPort();
    }

    /** Registers a file and returns its address on this phone (127.0.0.1, for playing here). */
    String add(Source source, String name, String mime) throws IOException {
        return register(new Entry(source, null, name, mime));
    }

    /** Registers a live stream; returns its 127.0.0.1 address. */
    String addLive(Live live, String name, String mime) throws IOException {
        return register(new Entry(null, live, name, mime));
    }

    /**
     * An address on this phone that passes {@code target} through with CORS allowed, for the page's own player
     * (IPTV servers rarely allow web pages). HLS playlists are rewritten so their pieces come through here too.
     * The path carries a random secret, so other devices on the network can't use it as a proxy.
     */
    synchronized String proxyUrl(String target) throws IOException {
        if (proxyToken == null) {
            byte[] b = new byte[16];
            random.nextBytes(b);
            StringBuilder t = new StringBuilder();
            for (byte x : b) t.append(String.format(Locale.US, "%02x", x));
            proxyToken = t.toString();
        }
        StringBuilder hex = new StringBuilder();
        for (byte x : target.getBytes(StandardCharsets.UTF_8)) hex.append(String.format(Locale.US, "%02x", x));
        return "http://127.0.0.1:" + port() + "/p/" + proxyToken + "/" + hex;
    }

    private void proxy(String hexTarget, String range, boolean head, OutputStream out) throws IOException {
        byte[] raw = new byte[hexTarget.length() / 2];
        for (int i = 0; i < raw.length; i++) raw[i] = (byte) Integer.parseInt(hexTarget.substring(2 * i, 2 * i + 2), 16);
        String target = new String(raw, StandardCharsets.UTF_8);
        if (!target.matches("(?i)^https?://.+")) {
            status(out, "400 Bad Request");
            return;
        }
        java.net.HttpURLConnection c = null;
        for (int hop = 0; hop < 6; hop++) {
            c = (java.net.HttpURLConnection) new java.net.URL(target).openConnection();
            c.setConnectTimeout(10000);
            c.setReadTimeout(30000);
            c.setInstanceFollowRedirects(false);
            c.setRequestProperty("User-Agent", "Mozilla/5.0 (Linux; Android) StreamBeam");
            if (range != null) c.setRequestProperty("Range", range);
            int code = c.getResponseCode();
            String loc = c.getHeaderField("Location");
            if (code >= 300 && code < 400 && loc != null) {
                target = new java.net.URL(new java.net.URL(target), loc).toString();
                c.disconnect();
                continue;
            }
            break;
        }
        int code = c.getResponseCode();
        String type = c.getContentType() != null ? c.getContentType() : "application/octet-stream";
        // IPTV servers often say "octet-stream"; TVs (Samsung especially) only play a video type they recognise.
        if (!type.toLowerCase(Locale.US).startsWith("video/") && !type.toLowerCase(Locale.US).startsWith("audio/")) {
            String guess = videoType(target);
            if (guess != null) type = guess;
        }
        boolean playlist = type.toLowerCase(Locale.US).contains("mpegurl") || target.split("\\?")[0].toLowerCase(Locale.US).endsWith(".m3u8");
        InputStream in = code >= 400 ? c.getErrorStream() : c.getInputStream();
        StringBuilder h = new StringBuilder("HTTP/1.1 ").append(code).append(code == 206 ? " Partial Content" : code >= 400 ? " Error" : " OK").append("\r\n")
                .append("Content-Type: ").append(playlist ? "application/vnd.apple.mpegurl" : type).append("\r\n")
                .append("Access-Control-Allow-Origin: *\r\nCache-Control: no-cache\r\nConnection: close\r\n");
        try {
            if (playlist && in != null) {
                byte[] body = rewrite(target, new String(readAll(in), StandardCharsets.UTF_8)).getBytes(StandardCharsets.UTF_8);
                out.write(h.append("Content-Length: ").append(body.length).append("\r\n\r\n").toString().getBytes(StandardCharsets.ISO_8859_1));
                if (!head) out.write(body);
                return;
            }
            if (c.getHeaderField("Content-Length") != null) h.append("Content-Length: ").append(c.getHeaderField("Content-Length")).append("\r\n");
            if (c.getHeaderField("Content-Range") != null) h.append("Content-Range: ").append(c.getHeaderField("Content-Range")).append("\r\n");
            if (c.getHeaderField("Accept-Ranges") != null) h.append("Accept-Ranges: ").append(c.getHeaderField("Accept-Ranges")).append("\r\n");
            // What DLNA TVs (Samsung, LG) ask for before they play: streamed, seekable by byte range.
            h.append("transferMode.dlna.org: Streaming\r\ncontentFeatures.dlna.org: DLNA.ORG_OP=01;DLNA.ORG_CI=0;DLNA.ORG_FLAGS=01700000000000000000000000000000\r\n");
            out.write(h.append("\r\n").toString().getBytes(StandardCharsets.ISO_8859_1));
            if (head || in == null) return;
            byte[] buf = new byte[64 * 1024];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
        } finally {
            if (in != null) in.close();
            c.disconnect();
        }
    }

    static String videoType(String url) {
        String p = url.split("\\?")[0].toLowerCase(Locale.US);
        if (p.endsWith(".mkv")) return "video/x-matroska";
        if (p.endsWith(".mp4") || p.endsWith(".m4v")) return "video/mp4";
        if (p.endsWith(".ts")) return "video/mp2t";
        if (p.endsWith(".avi")) return "video/x-msvideo";
        if (p.endsWith(".webm")) return "video/webm";
        if (p.endsWith(".mov")) return "video/quicktime";
        return null;
    }

    /** Points every piece, variant and key of a playlist back through this proxy. */
    private String rewrite(String base, String playlist) throws IOException {
        StringBuilder out = new StringBuilder();
        for (String line : playlist.split("\r?\n")) {
            String t = line.trim();
            if (!t.isEmpty() && !t.startsWith("#")) out.append(proxyUrl(new java.net.URL(new java.net.URL(base), t).toString()));
            else if (t.startsWith("#") && t.contains("URI=\"")) {
                Matcher m = URI_ATTR.matcher(line);
                StringBuffer sb = new StringBuffer();
                while (m.find()) m.appendReplacement(sb, Matcher.quoteReplacement("URI=\"" + proxyUrl(new java.net.URL(new java.net.URL(base), m.group(1)).toString()) + "\""));
                m.appendTail(sb);
                out.append(sb);
            } else out.append(line);
            out.append('\n');
        }
        return out.toString();
    }

    private static byte[] readAll(InputStream in) throws IOException {
        java.io.ByteArrayOutputStream b = new java.io.ByteArrayOutputStream();
        byte[] buf = new byte[16 * 1024];
        int n;
        while ((n = in.read(buf)) > 0 && b.size() < (8 << 20)) b.write(buf, 0, n);
        return b.toByteArray();
    }

    /** Stops serving an address handed out earlier. */
    void remove(String url) {
        String[] path = URI.create(url).getPath().split("/");
        if (path.length >= 3) files.remove(path[2]);
    }

    private String register(Entry entry) throws IOException {
        byte[] b = new byte[16];
        random.nextBytes(b);
        StringBuilder token = new StringBuilder();
        for (byte x : b) token.append(String.format(Locale.US, "%02x", x));
        files.put(token.toString(), entry);
        String safe = entry.name.replaceAll("[^A-Za-z0-9._-]", "_");
        return "http://127.0.0.1:" + port() + "/f/" + token + "/" + safe;
    }

    /** True for an address this server handed out. */
    boolean owns(String url) {
        try {
            URI u = URI.create(url);
            return server != null && "127.0.0.1".equals(u.getHost()) && u.getPort() == server.getLocalPort();
        } catch (IllegalArgumentException e) {
            return false;
        }
    }

    /** Rewrites a 127.0.0.1 address to this phone's address on the network that reaches {@code target}. Network call: not on the main thread. */
    String publicUrl(String url, String target) {
        if (!owns(url)) return url;
        String ip = localAddressToward(target);
        return ip == null ? url : url.replace("://127.0.0.1:", "://" + ip + ":");
    }

    static String localAddressToward(String target) {
        if (target != null && !target.isEmpty()) {
            try (DatagramSocket s = new DatagramSocket()) {
                s.connect(InetAddress.getByName(target), 9); // UDP connect only picks a route; nothing is sent
                InetAddress a = s.getLocalAddress();
                if (a instanceof Inet4Address && !a.isAnyLocalAddress() && !a.isLoopbackAddress()) return a.getHostAddress();
            } catch (Exception ignored) {
            }
        }
        // Fallback: Wi-Fi or hotspot interface first, then any private IPv4 address.
        String any = null;
        try {
            for (NetworkInterface ni : Collections.list(NetworkInterface.getNetworkInterfaces())) {
                if (!ni.isUp() || ni.isLoopback()) continue;
                for (InetAddress a : Collections.list(ni.getInetAddresses())) {
                    if (!(a instanceof Inet4Address) || !a.isSiteLocalAddress()) continue;
                    String n = ni.getName();
                    if (n.startsWith("wlan") || n.startsWith("ap") || n.startsWith("swlan")) return a.getHostAddress();
                    if (any == null) any = a.getHostAddress();
                }
            }
        } catch (Exception ignored) {
        }
        return any;
    }

    private void handle(Socket client) {
        try (Socket c = client) {
            c.setSoTimeout(30000);
            BufferedReader in = new BufferedReader(new InputStreamReader(c.getInputStream(), StandardCharsets.ISO_8859_1));
            String request = in.readLine();
            if (request == null) return;
            String range = null, line;
            while ((line = in.readLine()) != null && !line.isEmpty()) {
                int colon = line.indexOf(':');
                if (colon > 0 && line.substring(0, colon).trim().equalsIgnoreCase("range")) range = line.substring(colon + 1).trim();
            }
            String[] parts = request.split(" ");
            OutputStream out = c.getOutputStream();
            if (parts.length < 2 || !(parts[0].equals("GET") || parts[0].equals("HEAD"))) {
                status(out, "405 Method Not Allowed");
                return;
            }
            String[] path = parts[1].split("\\?")[0].split("/");
            if (path.length >= 4 && path[1].equals("p") && proxyToken != null && path[2].equals(proxyToken)) {
                proxy(path[3], range, parts[0].equals("HEAD"), out);
                return;
            }
            Entry e = path.length >= 3 && path[1].equals("f") ? files.get(path[2]) : null;
            if (e == null) {
                status(out, "404 Not Found");
                return;
            }
            if (e.live != null) {
                // Live: no length, no seeking; the body runs until the stream ends or the screen hangs up.
                out.write(("HTTP/1.1 200 OK\r\nContent-Type: " + e.mime + "\r\nAccept-Ranges: none\r\nCache-Control: no-cache\r\n"
                        + "transferMode.dlna.org: Streaming\r\n"
                        + "contentFeatures.dlna.org: DLNA.ORG_OP=00;DLNA.ORG_CI=0;DLNA.ORG_FLAGS=01700000000000000000000000000000\r\n"
                        + "Connection: close\r\n\r\n").getBytes(StandardCharsets.ISO_8859_1));
                out.flush();
                if (parts[0].equals("GET")) {
                    c.setTcpNoDelay(true);
                    e.live.stream(out);
                }
                return;
            }
            long size = e.source.size(), start = 0, end = size - 1;
            boolean partial = false;
            if (range != null && size > 0) {
                Matcher m = RANGE.matcher(range);
                if (m.matches()) {
                    if (m.group(1).isEmpty()) start = Math.max(0, size - Long.parseLong(m.group(2)));
                    else {
                        start = Long.parseLong(m.group(1));
                        if (!m.group(2).isEmpty()) end = Math.min(end, Long.parseLong(m.group(2)));
                    }
                    if (start > end || start >= size) {
                        out.write(("HTTP/1.1 416 Range Not Satisfiable\r\nContent-Range: bytes */" + size + "\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").getBytes(StandardCharsets.ISO_8859_1));
                        return;
                    }
                    partial = true;
                }
            }
            long length = size < 0 ? -1 : end - start + 1;
            StringBuilder h = new StringBuilder(partial ? "HTTP/1.1 206 Partial Content\r\n" : "HTTP/1.1 200 OK\r\n");
            h.append("Content-Type: ").append(e.mime).append("\r\n");
            if (length >= 0) h.append("Content-Length: ").append(length).append("\r\n");
            if (partial) h.append("Content-Range: bytes ").append(start).append('-').append(end).append('/').append(size).append("\r\n");
            h.append("Accept-Ranges: bytes\r\n")
                    .append("transferMode.dlna.org: Streaming\r\n")
                    .append("contentFeatures.dlna.org: DLNA.ORG_OP=01;DLNA.ORG_CI=0;DLNA.ORG_FLAGS=01700000000000000000000000000000\r\n")
                    .append("Connection: close\r\n\r\n");
            out.write(h.toString().getBytes(StandardCharsets.ISO_8859_1));
            if (parts[0].equals("HEAD")) return;
            try (InputStream data = e.source.open(start)) {
                byte[] buf = new byte[64 * 1024];
                long left = length;
                int n;
                while ((left < 0 || left > 0) && (n = data.read(buf, 0, (int) (left < 0 ? buf.length : Math.min(buf.length, left)))) > 0) {
                    out.write(buf, 0, n);
                    if (left > 0) left -= n;
                }
            }
            out.flush();
        } catch (IOException ignored) {
            // The screen closed the connection (normal when it seeks or stops).
        }
    }

    private static void status(OutputStream out, String status) throws IOException {
        out.write(("HTTP/1.1 " + status + "\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").getBytes(StandardCharsets.ISO_8859_1));
    }

    void release() {
        try {
            if (server != null) server.close();
        } catch (IOException ignored) {
        }
        pool.shutdownNow();
        files.clear();
    }
}

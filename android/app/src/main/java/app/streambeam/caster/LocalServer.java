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

    static final class Entry {
        final Source source;
        final String name, mime;

        Entry(Source source, String name, String mime) {
            this.source = source;
            this.name = name;
            this.mime = mime;
        }
    }

    private static final Pattern RANGE = Pattern.compile("bytes=(\\d*)-(\\d*)");
    private final Map<String, Entry> files = new ConcurrentHashMap<>();
    private final ExecutorService pool = Executors.newCachedThreadPool();
    private final SecureRandom random = new SecureRandom();
    private ServerSocket server;

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
        byte[] b = new byte[16];
        random.nextBytes(b);
        StringBuilder token = new StringBuilder();
        for (byte x : b) token.append(String.format(Locale.US, "%02x", x));
        files.put(token.toString(), new Entry(source, name, mime));
        String safe = name.replaceAll("[^A-Za-z0-9._-]", "_");
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
            Entry e = path.length >= 3 && path[1].equals("f") ? files.get(path[2]) : null;
            if (e == null) {
                status(out, "404 Not Found");
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

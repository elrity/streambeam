package app.streambeam.caster;

import android.content.Context;
import android.net.wifi.WifiManager;

import org.json.JSONException;
import org.json.JSONObject;
import org.w3c.dom.Document;
import org.w3c.dom.Element;
import org.w3c.dom.Node;
import org.w3c.dom.NodeList;
import org.xml.sax.InputSource;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.StringReader;
import java.net.DatagramPacket;
import java.net.HttpURLConnection;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.MulticastSocket;
import java.net.NetworkInterface;
import java.net.SocketTimeoutException;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import javax.xml.parsers.DocumentBuilderFactory;

/**
 * UPnP/DLNA media renderers: smart TVs, car head units, Kodi, set-top boxes and other screens that accept
 * "play this link". Found with an SSDP search on every Wi-Fi and hotspot interface, then controlled with
 * AVTransport and RenderingControl SOAP calls. Network work runs off the main thread.
 */
class Dlna {
    private static final String SSDP_HOST = "239.255.255.250";
    private static final int SSDP_PORT = 1900;
    private static final String[] TARGETS = {"urn:schemas-upnp-org:device:MediaRenderer:1", "urn:schemas-upnp-org:service:AVTransport:1"};
    private static final long SEARCH_MS = 7000;

    static final class Device {
        String id, name, model, host, avUrl, avType, rcUrl, rcType;
    }

    private final Bridge bridge;
    private final WifiManager wifi;
    private final Map<String, Device> found = new ConcurrentHashMap<>();
    private final ExecutorService io = Executors.newCachedThreadPool();
    private final ScheduledExecutorService poller = Executors.newSingleThreadScheduledExecutor();
    private volatile boolean searching;
    private ScheduledFuture<?> pollTask;
    private volatile Device active;
    private volatile boolean userStopped, sawPlaying;
    private volatile double pendingSeek;
    private int failures;

    Dlna(Context context, Bridge bridge) {
        this.bridge = bridge;
        this.wifi = (WifiManager) context.getApplicationContext().getSystemService(Context.WIFI_SERVICE);
    }

    boolean has(String device) {
        return found.containsKey(device);
    }

    String hostOf(String device) {
        Device d = found.get(device);
        return d != null ? d.host : null;
    }

    List<JSONObject> devices() {
        List<JSONObject> list = new ArrayList<>();
        for (Device d : found.values()) {
            try {
                list.add(new JSONObject().put("id", d.id).put("name", d.name).put("type", "dlna").put("model", d.model).put("host", d.host));
            } catch (JSONException ignored) {
            }
        }
        return list;
    }

    /* ---------- Discovery ---------- */

    void discover() {
        if (searching) return;
        searching = true;
        io.execute(() -> {
            try {
                search();
            } finally {
                searching = false;
            }
        });
    }

    private void search() {
        WifiManager.MulticastLock lock = wifi != null ? wifi.createMulticastLock("streambeam-ssdp") : null;
        List<MulticastSocket> sockets = new ArrayList<>();
        try {
            if (lock != null) {
                lock.setReferenceCounted(false);
                lock.acquire();
            }
            // One socket per IPv4 interface, so Wi-Fi, a car's Wi-Fi and the phone's own hotspot are all searched.
            for (NetworkInterface ni : Collections.list(NetworkInterface.getNetworkInterfaces())) {
                if (!ni.isUp() || ni.isLoopback() || !ni.supportsMulticast()) continue;
                for (InetAddress address : Collections.list(ni.getInetAddresses())) {
                    if (!(address instanceof Inet4Address)) continue;
                    try {
                        MulticastSocket s = new MulticastSocket(new InetSocketAddress(address, 0));
                        s.setNetworkInterface(ni);
                        s.setTimeToLive(4);
                        s.setSoTimeout(300);
                        sockets.add(s);
                    } catch (IOException ignored) {
                    }
                }
            }
            InetSocketAddress group = new InetSocketAddress(SSDP_HOST, SSDP_PORT);
            Set<String> seen = new HashSet<>();
            long end = System.currentTimeMillis() + SEARCH_MS, nextSend = 0;
            int rounds = 0;
            byte[] buffer = new byte[4096];
            while (System.currentTimeMillis() < end && !sockets.isEmpty()) {
                if (rounds < 3 && System.currentTimeMillis() >= nextSend) {
                    for (MulticastSocket s : sockets) {
                        for (String target : TARGETS) {
                            byte[] msg = ("M-SEARCH * HTTP/1.1\r\nHOST: " + SSDP_HOST + ":" + SSDP_PORT + "\r\nMAN: \"ssdp:discover\"\r\nMX: 2\r\nST: "
                                    + target + "\r\nUSER-AGENT: Android UPnP/1.1 StreamBeam/1.0\r\n\r\n").getBytes(StandardCharsets.UTF_8);
                            try {
                                s.send(new DatagramPacket(msg, msg.length, group));
                            } catch (IOException ignored) {
                            }
                        }
                    }
                    rounds++;
                    nextSend = System.currentTimeMillis() + 2000;
                }
                for (MulticastSocket s : sockets) {
                    DatagramPacket packet = new DatagramPacket(buffer, buffer.length);
                    try {
                        s.receive(packet);
                    } catch (SocketTimeoutException e) {
                        continue;
                    } catch (IOException e) {
                        continue;
                    }
                    String location = header(new String(packet.getData(), 0, packet.getLength(), StandardCharsets.UTF_8), "location");
                    if (location != null && location.startsWith("http") && seen.add(location)) io.execute(() -> describe(location));
                }
            }
        } catch (Exception ignored) {
        } finally {
            for (MulticastSocket s : sockets) s.close();
            if (lock != null && lock.isHeld()) lock.release();
        }
    }

    private static String header(String response, String name) {
        for (String line : response.split("\r?\n")) {
            int colon = line.indexOf(':');
            if (colon > 0 && line.substring(0, colon).trim().equalsIgnoreCase(name)) return line.substring(colon + 1).trim();
        }
        return null;
    }

    /** Reads a device description and keeps it if it can play media (has AVTransport). */
    private void describe(String location) {
        try {
            String xml = http(location);
            DocumentBuilderFactory factory = DocumentBuilderFactory.newInstance();
            factory.setNamespaceAware(false);
            factory.setExpandEntityReferences(false);
            Document doc = factory.newDocumentBuilder().parse(new InputSource(new StringReader(xml)));
            String base = text(doc.getDocumentElement(), "URLBase");
            URL baseUrl = new URL(base != null && !base.isEmpty() ? base : location);
            NodeList services = doc.getElementsByTagName("service");
            Element deviceEl = null;
            Device d = new Device();
            for (int i = 0; i < services.getLength(); i++) {
                Element service = (Element) services.item(i);
                String type = text(service, "serviceType"), control = text(service, "controlURL");
                if (type == null || control == null) continue;
                if (type.contains(":AVTransport:") && d.avUrl == null) {
                    d.avType = type;
                    d.avUrl = new URL(baseUrl, control).toString();
                    Node list = service.getParentNode();
                    if (list != null && list.getParentNode() instanceof Element) deviceEl = (Element) list.getParentNode();
                } else if (type.contains(":RenderingControl:") && d.rcUrl == null) {
                    d.rcType = type;
                    d.rcUrl = new URL(baseUrl, control).toString();
                }
            }
            if (d.avUrl == null || deviceEl == null) return;
            String udn = text(deviceEl, "UDN");
            d.id = "dlna:" + (udn != null && !udn.isEmpty() ? udn : location);
            String name = text(deviceEl, "friendlyName");
            d.name = name != null && !name.isEmpty() ? name : "Screen";
            String maker = text(deviceEl, "manufacturer"), model = text(deviceEl, "modelName");
            d.model = ((maker != null ? maker : "") + " " + (model != null ? model : "")).trim();
            d.host = new URL(location).getHost();
            found.put(d.id, d);
            bridge.devicesChanged();
        } catch (Exception ignored) {
        }
    }

    /** Text of the first direct child element with this name (any namespace prefix). */
    private static String text(Element parent, String name) {
        for (Node n = parent.getFirstChild(); n != null; n = n.getNextSibling()) {
            if (n instanceof Element) {
                String tag = ((Element) n).getTagName();
                if (tag.equals(name) || tag.endsWith(":" + name)) return n.getTextContent().trim();
            }
        }
        return null;
    }

    /* ---------- Playback ---------- */

    void play(String id, Bridge.Media media, Done done) {
        Device d = found.get(id);
        if (d == null) {
            done.fail("That screen isn’t available. Search again.");
            return;
        }
        io.execute(() -> {
            try {
                stopPolling();
                active = d;
                userStopped = false;
                sawPlaying = false;
                pendingSeek = media.start > 1 ? media.start : 0;
                try {
                    soap(d.avUrl, d.avType, "Stop", "");
                } catch (IOException ignored) {
                }
                try {
                    soap(d.avUrl, d.avType, "SetAVTransportURI", "<CurrentURI>" + xml(media.url) + "</CurrentURI><CurrentURIMetaData>"
                            + xml(didl(media)) + "</CurrentURIMetaData>");
                } catch (IOException withMetadata) {
                    // Some screens reject the description; the link alone is enough for them.
                    soap(d.avUrl, d.avType, "SetAVTransportURI", "<CurrentURI>" + xml(media.url) + "</CurrentURI><CurrentURIMetaData></CurrentURIMetaData>");
                }
                try {
                    soap(d.avUrl, d.avType, "Play", "<Speed>1</Speed>");
                } catch (IOException playError) {
                    // Some screens start on their own and refuse an extra Play.
                    Thread.sleep(800);
                    String state = tag(soap(d.avUrl, d.avType, "GetTransportInfo", ""), "CurrentTransportState");
                    if (!"PLAYING".equals(state) && !"TRANSITIONING".equals(state)) throw playError;
                }
                startPolling();
                done.ok();
            } catch (Exception e) {
                done.fail(message(e));
            }
        });
    }

    void command(String cmd, double value, Done done) {
        Device d = active;
        if (d == null) {
            done.fail("Nothing is playing on a screen.");
            return;
        }
        io.execute(() -> {
            try {
                switch (cmd) {
                    case "pause":
                        soap(d.avUrl, d.avType, "Pause", "");
                        break;
                    case "resume":
                        soap(d.avUrl, d.avType, "Play", "<Speed>1</Speed>");
                        break;
                    case "seek":
                        soap(d.avUrl, d.avType, "Seek", "<Unit>REL_TIME</Unit><Target>" + hms(value) + "</Target>");
                        break;
                    case "volume":
                        if (d.rcUrl == null) throw new IOException("This screen doesn’t allow volume changes from the phone.");
                        soap(d.rcUrl, d.rcType, "SetVolume", "<Channel>Master</Channel><DesiredVolume>" + Math.round(value * 100) + "</DesiredVolume>");
                        break;
                    case "rate":
                        if (value != 1) throw new IOException("This screen only plays at normal speed.");
                        break;
                    case "stop":
                        userStopped = true;
                        stopPolling();
                        soap(d.avUrl, d.avType, "Stop", "");
                        break;
                    default:
                        throw new IOException("Unknown command.");
                }
                done.ok();
            } catch (Exception e) {
                done.fail(message(e));
            }
        });
    }

    private synchronized void startPolling() {
        stopPolling();
        failures = 0;
        pollTask = poller.scheduleWithFixedDelay(this::poll, 1200, 1000, TimeUnit.MILLISECONDS);
    }

    private synchronized void stopPolling() {
        if (pollTask != null) pollTask.cancel(false);
        pollTask = null;
    }

    private void poll() {
        Device d = active;
        if (d == null) return;
        try {
            String transport = tag(soap(d.avUrl, d.avType, "GetTransportInfo", ""), "CurrentTransportState");
            String position = soap(d.avUrl, d.avType, "GetPositionInfo", "");
            double pos = seconds(tag(position, "RelTime")), dur = seconds(tag(position, "TrackDuration"));
            String state;
            switch (transport != null ? transport : "") {
                case "PLAYING":
                    state = "playing";
                    break;
                case "PAUSED_PLAYBACK":
                case "PAUSED_RECORDING":
                    state = "paused";
                    break;
                case "TRANSITIONING":
                    state = "buffering";
                    break;
                default:
                    state = sawPlaying && !userStopped ? "ended" : "idle";
            }
            failures = 0;
            if ("playing".equals(state)) {
                sawPlaying = true;
                if (pendingSeek > 0) {
                    double target = pendingSeek;
                    pendingSeek = 0;
                    soap(d.avUrl, d.avType, "Seek", "<Unit>REL_TIME</Unit><Target>" + hms(target) + "</Target>");
                }
            }
            if ("ended".equals(state)) stopPolling();
            bridge.status(d.id, state, pos, dur);
        } catch (Exception e) {
            if (++failures >= 5) {
                stopPolling();
                bridge.session(d.id, "ended", "Lost contact with the screen.");
            }
        }
    }

    void disconnect() {
        stopPolling();
        active = null;
    }

    void release() {
        stopPolling();
        io.shutdownNow();
        poller.shutdownNow();
    }

    /* ---------- UPnP helpers ---------- */

    private static String didl(Bridge.Media media) {
        String upnpClass = media.mime.startsWith("audio") ? "object.item.audioItem.musicTrack" : "object.item.videoItem";
        // Standard DLNA flags (streaming, seekable by byte range). Many car and TV receivers want them before showing video.
        String lower = media.mime.toLowerCase(Locale.US);
        String features = lower.contains("mpegurl") || lower.contains("dash") ? "*"
                : "DLNA.ORG_OP=01;DLNA.ORG_CI=0;DLNA.ORG_FLAGS=01700000000000000000000000000000";
        return "<DIDL-Lite xmlns=\"urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/\" xmlns:dc=\"http://purl.org/dc/elements/1.1/\""
                + " xmlns:upnp=\"urn:schemas-upnp-org:metadata-1-0/upnp/\"><item id=\"0\" parentID=\"-1\" restricted=\"1\">"
                + "<dc:title>" + xml(media.title) + "</dc:title><upnp:class>" + upnpClass + "</upnp:class>"
                + "<res protocolInfo=\"http-get:*:" + xml(media.mime) + ":" + features + "\">" + xml(media.url) + "</res></item></DIDL-Lite>";
    }

    private static String soap(String url, String service, String action, String args) throws IOException {
        String body = "<?xml version=\"1.0\" encoding=\"utf-8\"?><s:Envelope xmlns:s=\"http://schemas.xmlsoap.org/soap/envelope/\""
                + " s:encodingStyle=\"http://schemas.xmlsoap.org/soap/encoding/\"><s:Body><u:" + action + " xmlns:u=\"" + service + "\">"
                + "<InstanceID>0</InstanceID>" + args + "</u:" + action + "></s:Body></s:Envelope>";
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        try {
            c.setConnectTimeout(4000);
            c.setReadTimeout(6000);
            c.setDoOutput(true);
            c.setRequestMethod("POST");
            c.setRequestProperty("Content-Type", "text/xml; charset=\"utf-8\"");
            c.setRequestProperty("SOAPACTION", "\"" + service + "#" + action + "\"");
            byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
            c.setFixedLengthStreamingMode(bytes.length);
            try (OutputStream out = c.getOutputStream()) {
                out.write(bytes);
            }
            int code = c.getResponseCode();
            String response = read(code >= 400 ? c.getErrorStream() : c.getInputStream());
            if (code >= 400) {
                String why = tag(response, "errorDescription");
                throw new IOException("The screen refused " + action + (why != null ? ": " + why : " (" + code + ")") + ".");
            }
            return response;
        } finally {
            c.disconnect();
        }
    }

    private static String http(String url) throws IOException {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        try {
            c.setConnectTimeout(3000);
            c.setReadTimeout(4000);
            return read(c.getInputStream());
        } finally {
            c.disconnect();
        }
    }

    private static String read(InputStream in) throws IOException {
        if (in == null) return "";
        try (InputStream s = in) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int n;
            while ((n = s.read(buf)) > 0) {
                out.write(buf, 0, n);
                if (out.size() > 1 << 20) break;
            }
            return out.toString("UTF-8");
        }
    }

    private static String tag(String xml, String name) {
        Matcher m = Pattern.compile("<(?:\\w+:)?" + name + "[^>]*>([^<]*)</(?:\\w+:)?" + name + ">").matcher(xml);
        return m.find() ? m.group(1).trim() : null;
    }

    private static double seconds(String hms) {
        if (hms == null || hms.isEmpty() || hms.startsWith("NOT")) return 0;
        try {
            String[] parts = hms.split(":");
            double total = 0;
            for (String p : parts) total = total * 60 + Double.parseDouble(p);
            return total;
        } catch (NumberFormatException e) {
            return 0;
        }
    }

    private static String hms(double seconds) {
        long s = Math.max(0, Math.round(seconds));
        return String.format(Locale.US, "%d:%02d:%02d", s / 3600, (s % 3600) / 60, s % 60);
    }

    private static String xml(String s) {
        return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace("\"", "&quot;").replace("'", "&apos;");
    }

    private static String message(Exception e) {
        String m = e.getMessage();
        if (e instanceof SocketTimeoutException) return "The screen didn’t answer.";
        return m != null && !m.isEmpty() ? m : "The screen didn’t respond.";
    }
}

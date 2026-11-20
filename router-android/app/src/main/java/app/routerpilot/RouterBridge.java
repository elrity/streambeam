package app.routerpilot;

import android.content.Context;
import android.net.ConnectivityManager;
import android.net.DhcpInfo;
import android.net.LinkProperties;
import android.net.Network;
import android.net.RouteInfo;
import android.net.wifi.WifiManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;

import org.json.JSONObject;

import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.Proxy;
import java.security.SecureRandom;
import java.security.cert.X509Certificate;
import java.util.Iterator;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

import javax.net.ssl.SSLContext;
import javax.net.ssl.TrustManager;
import javax.net.ssl.X509TrustManager;

import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;

/**
 * window.Native: HTTP requests to the router on the local network, made natively so the page isn't
 * limited by CORS, and the network's gateway address. Only local-network addresses are reachable.
 */
public class RouterBridge {
    private final MainActivity activity;
    private final WebView web;
    private final ExecutorService pool = Executors.newFixedThreadPool(4);
    private final OkHttpClient client;
    private OkHttpClient insecureClient;

    RouterBridge(MainActivity activity, WebView web) {
        this.activity = activity;
        this.web = web;
        this.client = new OkHttpClient.Builder()
                .proxy(Proxy.NO_PROXY)
                .connectTimeout(8, TimeUnit.SECONDS)
                .readTimeout(30, TimeUnit.SECONDS)
                .writeTimeout(30, TimeUnit.SECONDS)
                .build();
    }

    /** Routers on a LAN often use a self-signed certificate; accepted only when the page asks for it. */
    private synchronized OkHttpClient insecure() throws Exception {
        if (insecureClient != null) return insecureClient;
        X509TrustManager trustAll = new X509TrustManager() {
            @Override public void checkClientTrusted(X509Certificate[] chain, String authType) { }
            @Override public void checkServerTrusted(X509Certificate[] chain, String authType) { }
            @Override public X509Certificate[] getAcceptedIssuers() { return new X509Certificate[0]; }
        };
        SSLContext ctx = SSLContext.getInstance("TLS");
        ctx.init(null, new TrustManager[]{trustAll}, new SecureRandom());
        insecureClient = client.newBuilder()
                .sslSocketFactory(ctx.getSocketFactory(), trustAll)
                .hostnameVerifier((h, s) -> true)
                .build();
        return insecureClient;
    }

    /** True for private IPv4 addresses and local names such as router.lan or openwrt. */
    static boolean isLocalHost(String host) {
        if (host == null || host.isEmpty()) return false;
        String h = host.toLowerCase(Locale.ROOT);
        if (h.matches("\\d{1,3}(\\.\\d{1,3}){3}")) {
            String[] p = h.split("\\.");
            int a = Integer.parseInt(p[0]), b = Integer.parseInt(p[1]);
            return a == 10 || (a == 172 && b >= 16 && b <= 31) || (a == 192 && b == 168)
                    || (a == 169 && b == 254) || (a == 100 && b >= 64 && b <= 127);
        }
        if (!h.contains(".")) return true;
        return h.endsWith(".lan") || h.endsWith(".local") || h.endsWith(".home") || h.endsWith(".home.arpa")
                || h.endsWith(".router") || h.endsWith(".box") || h.endsWith(".localdomain");
    }

    /**
     * Starts a request; the answer arrives as window.__nativeDone(id, json) with
     * {status, body} or {error}. spec: {method, url, headers:{}, body, insecure}.
     */
    @JavascriptInterface
    public void request(final int id, final String spec) {
        pool.execute(() -> {
            JSONObject out = new JSONObject();
            try {
                JSONObject s = new JSONObject(spec);
                String url = s.getString("url");
                okhttp3.HttpUrl parsed = okhttp3.HttpUrl.parse(url);
                if (parsed == null) throw new IllegalArgumentException("Not a valid address: " + url);
                if (!isLocalHost(parsed.host()))
                    throw new IllegalArgumentException("Only addresses on your local network are allowed");

                String method = s.optString("method", "GET").toUpperCase(Locale.ROOT);
                Request.Builder rb = new Request.Builder().url(parsed);
                JSONObject headers = s.optJSONObject("headers");
                String contentType = "application/json";
                if (headers != null) {
                    for (Iterator<String> it = headers.keys(); it.hasNext(); ) {
                        String k = it.next();
                        if (k.equalsIgnoreCase("content-type")) contentType = headers.getString(k);
                        else rb.header(k, headers.getString(k));
                    }
                }
                RequestBody body = null;
                if (s.has("body") && !s.isNull("body")) {
                    body = RequestBody.create(s.getString("body"), MediaType.parse(contentType));
                } else if (method.equals("POST") || method.equals("PUT") || method.equals("PATCH")) {
                    body = RequestBody.create("", MediaType.parse(contentType));
                }
                rb.method(method, body);

                OkHttpClient c = s.optBoolean("insecure") ? insecure() : client;
                int timeout = s.optInt("timeout", 0);
                if (timeout > 0) c = c.newBuilder().callTimeout(timeout, TimeUnit.MILLISECONDS).build();
                try (Response r = c.newCall(rb.build()).execute()) {
                    out.put("status", r.code());
                    out.put("body", r.body() != null ? r.body().string() : "");
                }
            } catch (Exception e) {
                String msg = e.getMessage();
                try {
                    out.put("error", msg == null || msg.isEmpty() ? e.getClass().getSimpleName() : msg);
                } catch (Exception ignored) {
                }
            }
            final String js = "window.__nativeDone(" + id + "," + JSONObject.quote(out.toString()) + ")";
            web.post(() -> web.evaluateJavascript(js, null));
        });
    }

    /** The network's gateway (usually the router), like 192.168.1.1, or "" when not on a network. */
    @JavascriptInterface
    public String gateway() {
        try {
            ConnectivityManager cm = (ConnectivityManager) activity.getSystemService(Context.CONNECTIVITY_SERVICE);
            Network n = cm.getActiveNetwork();
            LinkProperties lp = n != null ? cm.getLinkProperties(n) : null;
            if (lp != null) {
                for (RouteInfo r : lp.getRoutes()) {
                    InetAddress g = r.getGateway();
                    if (r.isDefaultRoute() && g instanceof Inet4Address && !g.isAnyLocalAddress())
                        return g.getHostAddress();
                }
            }
        } catch (Exception ignored) {
        }
        try {
            WifiManager wm = (WifiManager) activity.getApplicationContext().getSystemService(Context.WIFI_SERVICE);
            @SuppressWarnings("deprecation") DhcpInfo d = wm.getDhcpInfo();
            if (d != null && d.gateway != 0) {
                int g = d.gateway;
                return (g & 0xff) + "." + ((g >> 8) & 0xff) + "." + ((g >> 16) & 0xff) + "." + ((g >> 24) & 0xff);
            }
        } catch (Exception ignored) {
        }
        return "";
    }

    /** Opens a link (such as the router's own admin page) in the phone's browser. */
    @JavascriptInterface
    public void openUrl(String url) {
        activity.runOnUiThread(() -> activity.openExternal(url));
    }

    @JavascriptInterface
    public String version() {
        try {
            return activity.getPackageManager().getPackageInfo(activity.getPackageName(), 0).versionName;
        } catch (Exception e) {
            return "";
        }
    }
}

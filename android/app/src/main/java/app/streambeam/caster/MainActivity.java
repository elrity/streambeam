package app.streambeam.caster;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Bundle;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.GeolocationPermissions;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;

import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;

import java.util.Collections;

/**
 * Hosts the StreamBeam web app full screen and gives it the native bridge (window.StreamBeamNative)
 * for finding and controlling screens on the local network. Only the app's own site gets the bridge.
 */
public class MainActivity extends Activity {
    private static final int FILE_REQUEST = 41;
    private static final int LOCATION_REQUEST = 42;

    private FrameLayout root;
    private WebView web;
    private Bridge bridge;
    private Uri start;
    private ValueCallback<Uri[]> fileCallback;
    private View customView;
    private WebChromeClient.CustomViewCallback customCallback;
    private GeolocationPermissions.Callback geoCallback;
    private String geoOrigin;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        start = Uri.parse(getString(R.string.start_url));
        root = new FrameLayout(this);
        web = new WebView(this);
        root.addView(web, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        setContentView(root);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE);
        s.setUserAgentString(s.getUserAgentString() + " StreamBeamApp/" + BuildConfig.VERSION_NAME);
        web.setWebViewClient(new Client());
        web.setWebChromeClient(new Chrome());

        bridge = new Bridge(this);
        if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            String origin = start.getScheme() + "://" + start.getAuthority();
            WebViewCompat.addWebMessageListener(web, "StreamBeamNative", Collections.singleton(origin), bridge);
        }

        if (state != null) web.restoreState(state);
        else web.loadUrl(urlFor(getIntent()));
    }

    /** Shortcuts and links open their own address inside the app; anything else opens the start page. */
    private String urlFor(Intent intent) {
        Uri data = intent != null ? intent.getData() : null;
        if (data != null && "https".equals(data.getScheme()) && start.getHost() != null && start.getHost().equals(data.getHost())) return data.toString();
        return start.toString();
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        if (intent.getData() != null) web.loadUrl(urlFor(intent));
    }

    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        web.saveState(out);
    }

    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        if (customView != null) hideCustomView();
        else if (web.canGoBack()) web.goBack();
        else super.onBackPressed();
    }

    @Override
    protected void onDestroy() {
        bridge.release();
        web.destroy();
        super.onDestroy();
    }

    @Override
    @SuppressWarnings("deprecation")
    protected void onActivityResult(int request, int result, Intent data) {
        if (request == FILE_REQUEST && fileCallback != null) {
            fileCallback.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(result, data));
            fileCallback = null;
        } else super.onActivityResult(request, result, data);
    }

    @Override
    public void onRequestPermissionsResult(int request, String[] permissions, int[] results) {
        if (request == LOCATION_REQUEST && geoCallback != null) {
            geoCallback.invoke(geoOrigin, results.length > 0 && results[0] == PackageManager.PERMISSION_GRANTED, false);
            geoCallback = null;
        }
    }

    private void openExternal(Uri uri) {
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, uri));
        } catch (ActivityNotFoundException ignored) {
        }
    }

    @SuppressWarnings("deprecation")
    private void hideCustomView() {
        if (customView == null) return;
        root.removeView(customView);
        customView = null;
        web.setVisibility(View.VISIBLE);
        getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_VISIBLE);
        if (customCallback != null) customCallback.onCustomViewHidden();
        customCallback = null;
    }

    private class Client extends WebViewClient {
        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            Uri uri = request.getUrl();
            String scheme = uri.getScheme();
            boolean isWeb = "https".equals(scheme) || "http".equals(scheme);
            if (isWeb && start.getHost() != null && start.getHost().equals(uri.getHost())) return false;
            if ("intent".equals(scheme)) {
                try {
                    Intent intent = Intent.parseUri(uri.toString(), Intent.URI_INTENT_SCHEME);
                    intent.addCategory(Intent.CATEGORY_BROWSABLE);
                    intent.setComponent(null);
                    intent.setSelector(null);
                    try {
                        startActivity(intent);
                    } catch (ActivityNotFoundException e) {
                        String fallback = intent.getStringExtra("browser_fallback_url");
                        if (fallback != null) openExternal(Uri.parse(fallback));
                        else if (intent.getPackage() != null) openExternal(Uri.parse("market://details?id=" + intent.getPackage()));
                    }
                } catch (Exception ignored) {
                }
                return true;
            }
            openExternal(uri);
            return true;
        }
    }

    private class Chrome extends WebChromeClient {
        @Override
        public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
            if (fileCallback != null) fileCallback.onReceiveValue(null);
            fileCallback = callback;
            try {
                startActivityForResult(params.createIntent(), FILE_REQUEST);
            } catch (ActivityNotFoundException e) {
                fileCallback = null;
                return false;
            }
            return true;
        }

        @Override
        @SuppressWarnings("deprecation")
        public void onShowCustomView(View view, CustomViewCallback callback) {
            if (customView != null) {
                callback.onCustomViewHidden();
                return;
            }
            customView = view;
            customCallback = callback;
            root.addView(view, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
            web.setVisibility(View.GONE);
            getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_FULLSCREEN
                    | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY);
        }

        @Override
        public void onHideCustomView() {
            hideCustomView();
        }

        @Override
        public void onGeolocationPermissionsShowPrompt(String origin, GeolocationPermissions.Callback callback) {
            if (checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED) {
                callback.invoke(origin, true, false);
                return;
            }
            geoCallback = callback;
            geoOrigin = origin;
            requestPermissions(new String[]{Manifest.permission.ACCESS_COARSE_LOCATION}, LOCATION_REQUEST);
        }
    }
}

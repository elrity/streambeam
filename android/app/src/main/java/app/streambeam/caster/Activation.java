package app.streambeam.caster;

import android.annotation.SuppressLint;
import android.content.Context;
import android.content.SharedPreferences;
import android.provider.Settings;
import android.util.Base64;

import java.io.ByteArrayOutputStream;
import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.security.KeyFactory;
import java.security.MessageDigest;
import java.security.PublicKey;
import java.security.Signature;
import java.security.spec.X509EncodedKeySpec;
import java.util.Arrays;
import java.util.Locale;

/**
 * One-phone activation. Each phone shows its own device code (from Android's per-app device id, so it is
 * the same after reinstalling but different on every other phone). The owner signs that code with a private
 * key that never leaves the owner (tools/activate.mjs, or the "Activate a phone" GitHub workflow); the app
 * holds only the matching public key. An activation code therefore works on exactly one phone: passing the
 * APK, or the code, to someone else gives them a different device code that the old activation doesn't fit.
 */
final class Activation {
    /** Public half of the owner's activation key (P-256). The private half stays with the owner. */
    private static final String PUBLIC_KEY =
            "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEj8cmN+dr9vMaesTLFDp83ZuOQQpsWZ92KYh9x7+kjh6fStv824MhqvPYlCiH4Ta+p+QCH3eeh94uz6q9kZQ4jQ==";
    private static final String PREFS = "activation", KEY = "code";
    private static final char[] B32 = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789".toCharArray(); // no 0/O or 1/I

    private Activation() {
    }

    static boolean required() {
        return BuildConfig.REQUIRE_ACTIVATION;
    }

    /** This phone's device code, like "K7QX2-MRH4D". */
    @SuppressLint("HardwareIds")
    static String deviceCode(Context context) {
        String id = Settings.Secure.getString(context.getContentResolver(), Settings.Secure.ANDROID_ID);
        try {
            byte[] h = MessageDigest.getInstance("SHA-256").digest(("StreamBeam:" + id + ":" + context.getPackageName()).getBytes(StandardCharsets.UTF_8));
            StringBuilder s = new StringBuilder();
            for (int i = 0; i < 10; i++) {
                if (i == 5) s.append('-');
                s.append(B32[(h[i] & 0xFF) % B32.length]);
            }
            return s.toString();
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    static boolean isActive(Context context) {
        String saved = prefs(context).getString(KEY, null);
        return saved != null && verify(deviceCode(context), saved);
    }

    /** Checks an activation code for this phone and remembers it when it fits. */
    static boolean activate(Context context, String code) {
        String clean = clean(code);
        if (clean.isEmpty() || !verify(deviceCode(context), clean)) return false;
        prefs(context).edit().putString(KEY, clean).apply();
        return true;
    }

    /** Accepts the bare code or a whole activation link (…?act=CODE), with stray spaces or line breaks. */
    static String clean(String code) {
        if (code == null) return "";
        String c = code.trim();
        int at = c.indexOf("act=");
        if (at >= 0) {
            c = c.substring(at + 4);
            int end = c.indexOf('&');
            if (end >= 0) c = c.substring(0, end);
        }
        return c.replaceAll("[^A-Za-z0-9_-]", "");
    }

    static boolean verify(String deviceCode, String code) {
        try {
            byte[] raw = Base64.decode(code, Base64.URL_SAFE | Base64.NO_WRAP | Base64.NO_PADDING);
            if (raw.length != 64) return false;
            PublicKey key = KeyFactory.getInstance("EC").generatePublic(new X509EncodedKeySpec(Base64.decode(PUBLIC_KEY, Base64.DEFAULT)));
            Signature sig = Signature.getInstance("SHA256withECDSA");
            sig.initVerify(key);
            sig.update(("StreamBeam activation " + deviceCode.toUpperCase(Locale.US)).getBytes(StandardCharsets.UTF_8));
            return sig.verify(der(raw));
        } catch (Exception e) {
            return false;
        }
    }

    /** Raw r||s (64 bytes) to the DER form Java's verifier expects. */
    private static byte[] der(byte[] raw) {
        byte[] r = new BigInteger(1, Arrays.copyOfRange(raw, 0, 32)).toByteArray();
        byte[] s = new BigInteger(1, Arrays.copyOfRange(raw, 32, 64)).toByteArray();
        ByteArrayOutputStream out = new ByteArrayOutputStream(72);
        out.write(0x30);
        out.write(4 + r.length + s.length);
        out.write(0x02);
        out.write(r.length);
        out.write(r, 0, r.length);
        out.write(0x02);
        out.write(s.length);
        out.write(s, 0, s.length);
        return out.toByteArray();
    }

    private static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }
}

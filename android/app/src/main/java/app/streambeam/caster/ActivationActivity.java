package app.streambeam.caster;

import android.app.Activity;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Bundle;
import android.text.InputType;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.EditText;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

/**
 * Shown instead of the app until this phone is activated (only in builds made with REQUIRE_ACTIVATION).
 * The person sends their device code to the owner and gets back a link or code that fits this phone only.
 */
public class ActivationActivity extends Activity {
    private EditText input;
    private TextView error;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        if (tryIntent(getIntent())) return;
        String device = Activation.deviceCode(this);

        LinearLayout col = new LinearLayout(this);
        col.setOrientation(LinearLayout.VERTICAL);
        col.setGravity(Gravity.CENTER_HORIZONTAL);
        int pad = dp(24);
        col.setPadding(pad, dp(40), pad, pad);

        ImageView logo = new ImageView(this);
        logo.setImageResource(R.drawable.logo);
        col.addView(logo, new LinearLayout.LayoutParams(dp(150), dp(150)));

        col.addView(text("Activate " + getString(R.string.app_name), 22, true, 0xFF141416), wrap(dp(20)));
        col.addView(text("Send this phone’s code to Rity to get your activation link. It works on this phone only.", 15, false, 0xFF5A5B60), wrap(dp(8)));

        TextView code = text(device, 30, true, 0xFF141416);
        code.setTypeface(Typeface.MONOSPACE, Typeface.BOLD);
        code.setLetterSpacing(0.08f);
        code.setTextIsSelectable(true);
        col.addView(code, wrap(dp(20)));

        LinearLayout row = new LinearLayout(this);
        row.setGravity(Gravity.CENTER);
        Button send = button("Send code", true);
        send.setOnClickListener(v -> startActivity(Intent.createChooser(new Intent(Intent.ACTION_SEND).setType("text/plain")
                .putExtra(Intent.EXTRA_TEXT, "Please activate " + getString(R.string.app_name) + " for my phone. Device code: " + device), "Send the code")));
        Button copy = button("Copy", false);
        copy.setOnClickListener(v -> {
            ((ClipboardManager) getSystemService(CLIPBOARD_SERVICE)).setPrimaryClip(ClipData.newPlainText("Device code", device));
            Toast.makeText(this, "Code copied", Toast.LENGTH_SHORT).show();
        });
        row.addView(send, weight());
        row.addView(copy, weight());
        col.addView(row, full(dp(14)));

        input = new EditText(this);
        input.setHint("Paste the activation code or link");
        input.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS | InputType.TYPE_TEXT_FLAG_MULTI_LINE);
        input.setMaxLines(4);
        col.addView(input, full(dp(28)));

        error = text("", 14, false, 0xFFC0392B);
        error.setVisibility(View.GONE);
        col.addView(error, wrap(dp(6)));

        Button go = button("Activate", true);
        go.setOnClickListener(v -> check(input.getText().toString()));
        col.addView(go, full(dp(12)));

        ScrollView scroll = new ScrollView(this);
        scroll.setFillViewport(true);
        scroll.setBackgroundColor(0xFFEEEFF1);
        scroll.addView(col);
        setContentView(scroll);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        tryIntent(intent);
    }

    /** An activation link (…/?act=CODE) opened on this phone activates it straight away. */
    private boolean tryIntent(Intent intent) {
        Uri data = intent != null ? intent.getData() : null;
        String act = data != null ? data.getQueryParameter("act") : null;
        if (act == null) return false;
        if (Activation.activate(this, act)) {
            done();
            return true;
        }
        Toast.makeText(this, "That activation link is for a different phone.", Toast.LENGTH_LONG).show();
        return false;
    }

    private void check(String value) {
        if (Activation.activate(this, value)) {
            done();
            return;
        }
        error.setText(Activation.clean(value).isEmpty() ? "Paste the code you received." : "This code doesn’t fit this phone. Check it, or ask for a new one with the code above.");
        error.setVisibility(View.VISIBLE);
    }

    private void done() {
        Toast.makeText(this, getString(R.string.app_name) + " is activated on this phone.", Toast.LENGTH_LONG).show();
        startActivity(new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP));
        finish();
    }

    private TextView text(String s, int sp, boolean bold, int color) {
        TextView t = new TextView(this);
        t.setText(s);
        t.setTextSize(sp);
        t.setTextColor(color);
        t.setGravity(Gravity.CENTER);
        if (bold) t.setTypeface(Typeface.DEFAULT_BOLD);
        return t;
    }

    private Button button(String label, boolean primary) {
        Button b = new Button(this);
        b.setText(label);
        b.setAllCaps(false);
        b.setTextColor(primary ? Color.WHITE : 0xFF141416);
        GradientDrawable bg = new GradientDrawable();
        bg.setCornerRadius(dp(14));
        bg.setColor(primary ? 0xFF141416 : 0xFFFCFCFD);
        b.setBackground(bg);
        b.setMinHeight(dp(48));
        return b;
    }

    private LinearLayout.LayoutParams wrap(int top) {
        LinearLayout.LayoutParams p = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        p.topMargin = top;
        return p;
    }

    private LinearLayout.LayoutParams full(int top) {
        LinearLayout.LayoutParams p = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        p.topMargin = top;
        return p;
    }

    private LinearLayout.LayoutParams weight() {
        LinearLayout.LayoutParams p = new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1);
        p.setMargins(dp(5), 0, dp(5), 0);
        return p;
    }

    private int dp(int v) {
        return Math.round(v * getResources().getDisplayMetrics().density);
    }
}

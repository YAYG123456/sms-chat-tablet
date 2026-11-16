package com.smschat.tablet;

import android.annotation.SuppressLint;
import android.os.Bundle;
import android.util.Base64;
import android.webkit.CookieManager;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import androidx.appcompat.app.AppCompatActivity;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;

public class MainActivity extends AppCompatActivity {

    // החלף לכתובת המדויקת של עמוד ההודעות באתר שלך
    private static final String START_URL = "https://www.955.co.il/sms/Default";

    private WebView webView;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        webView = new WebView(this);
        setContentView(webView);

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setAllowFileAccess(true);
        settings.setMediaPlaybackRequiresUserGesture(false);

        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(webView, true);

        webView.setWebChromeClient(new WebChromeClient());
        webView.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageFinished(WebView view, String url) {
                super.onPageFinished(view, url);
                CookieManager.getInstance().flush();
                injectAssets(view);
            }
        });

        webView.loadUrl(START_URL);
    }

    private void injectAssets(WebView view) {
        try {
            String css = readAsset("style.css");
            String encodedCss = Base64.encodeToString(css.getBytes(StandardCharsets.UTF_8), Base64.NO_WRAP);
            String injectCssJs = "(function() {" +
                    "if (document.getElementById('sms-injected-css')) return;" +
                    "var style = document.createElement('style');" +
                    "style.id = 'sms-injected-css';" +
                    "style.innerHTML = decodeURIComponent(escape(window.atob('" + encodedCss + "')));" +
                    "document.head.appendChild(style);" +
                    "})();";
            view.evaluateJavascript(injectCssJs, null);

            String js = readAsset("content.js");
            view.evaluateJavascript(js, null);
        } catch (Exception e) {
            e.printStackTrace();
        }
    }

    private String readAsset(String fileName) throws Exception {
        InputStream is = getAssets().open(fileName);
        byte[] buffer = new byte[is.available()];
        is.read(buffer);
        is.close();
        return new String(buffer, StandardCharsets.UTF_8);
    }

    @Override
    public void onBackPressed() {
        if (webView != null && webView.canGoBack()) {
            webView.goBack();
        } else {
            super.onBackPressed();
        }
    }
}

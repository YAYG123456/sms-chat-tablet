package com.smschat.tablet;

import android.annotation.SuppressLint;
import android.app.DownloadManager;
import android.net.Uri;
import android.net.http.SslError;
import android.os.Bundle;
import android.os.Environment;
import android.util.Base64;
import android.webkit.CookieManager;
import android.webkit.SslErrorHandler;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;
import androidx.appcompat.app.AppCompatActivity;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;

public class MainActivity extends AppCompatActivity {

    private static final String START_URL = "https://www.955.co.il/sms/Default";
    private WebView webView;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        webView = new WebView(this);
        webView.setFitsSystemWindows(true);
        setContentView(webView);

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setAllowFileAccess(true);
        settings.setJavaScriptCanOpenWindowsAutomatically(true);
        settings.setSupportMultipleWindows(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE);
        settings.setMediaPlaybackRequiresUserGesture(false);

        CookieManager cookieManager = CookieManager.getInstance();
        cookieManager.setAcceptCookie(true);
        cookieManager.setAcceptThirdPartyCookies(webView, true);

        // תמיכה בהורדת קובצי ייצוא (CSV) מתוך האפליקציה
        webView.setDownloadListener((url, userAgent, contentDisposition, mimetype, contentLength) -> {
            try {
                if (url.startsWith("http")) {
                    DownloadManager.Request request = new DownloadManager.Request(Uri.parse(url));
                    request.setMimeType(mimetype);
                    String cookies = CookieManager.getInstance().getCookie(url);
                    request.addRequestHeader("cookie", cookies);
                    request.addRequestHeader("User-Agent", userAgent);
                    request.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
                    request.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, "SMS_Export.csv");
                    DownloadManager dm = (DownloadManager) getSystemService(DOWNLOAD_SERVICE);
                    if (dm != null) {
                        dm.enqueue(request);
                        Toast.makeText(this, "הקובץ נשמר בתיקיית ההורדות", Toast.LENGTH_SHORT).show();
                    }
                }
            } catch (Exception e) {
                Toast.makeText(this, "לא ניתן להוריד קובץ זה במכשיר", Toast.LENGTH_SHORT).show();
            }
        });

        webView.setWebChromeClient(new WebChromeClient());
        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                String url = request.getUrl().toString();
                if (url.contains("955.co.il")) {
                    return false;
                }
                return false;
            }

            @Override
            public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
                // אישור תעודת הסינון של נטפרי אך ורק עבור דומיין האתר שלנו
                String failingUrl = error.getUrl();
                if (failingUrl != null && failingUrl.contains("955.co.il")) {
                    handler.proceed();
                } else {
                    handler.cancel();
                }
            }

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
            // 1. הזרקת קובץ העיצוב style.css דרך Base64
            String css = readAsset("style.css");
            String encodedCss = Base64.encodeToString(css.getBytes(StandardCharsets.UTF_8), Base64.NO_WRAP);
            String injectCssJs = "(function() {" +
                    "if (document.getElementById('sms-injected-css')) return;" +
                    "var style = document.createElement('style');" +
                    "style.id = 'sms-injected-css';" +
                    "style.innerHTML = new TextDecoder('utf-8').decode(Uint8Array.from(atob('" + encodedCss + "'), c => c.charCodeAt(0)));" +
                    "document.head.appendChild(style);" +
                    "})();";
            view.evaluateJavascript(injectCssJs, null);

            // 2. הזרקת קובץ הסקריפט content.js דרך Base64 למניעת שגיאות תחביר
            String js = readAsset("content.js");
            String encodedJs = Base64.encodeToString(js.getBytes(StandardCharsets.UTF_8), Base64.NO_WRAP);
            String injectScriptJs = "(function() {" +
                    "if (document.getElementById('sms-modern-app')) return;" +
                    "var code = new TextDecoder('utf-8').decode(Uint8Array.from(atob('" + encodedJs + "'), c => c.charCodeAt(0)));" +
                    "var script = document.createElement('script');" +
                    "script.textContent = code;" +
                    "document.body.appendChild(script);" +
                    "})();";
            view.evaluateJavascript(injectScriptJs, null);
        } catch (Exception e) {
            e.printStackTrace();
        }
    }

    private String readAsset(String fileName) throws Exception {
        InputStream is = getAssets().open(fileName);
        ByteArrayOutputStream buffer = new ByteArrayOutputStream();
        int nRead;
        byte[] data = new byte[4096];
        while ((nRead = is.read(data, 0, data.length)) != -1) {
            buffer.write(data, 0, nRead);
        }
        is.close();
        return buffer.toString(StandardCharsets.UTF_8.name());
    }

    @Override
    protected void onPause() {
        super.onPause();
        CookieManager.getInstance().flush();
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

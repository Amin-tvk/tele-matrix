package com.pocketcalc.app;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.view.Window;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.MimeTypeMap;
import android.webkit.PermissionRequest;
import android.webkit.ServiceWorkerClient;
import android.webkit.ServiceWorkerController;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.Toast;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

// Opens as a calculator once the user has picked a calculation; typing it and pressing "=" shows Tele.
// Leaving the app hides Tele behind the calculator again. Without a calculation set, Tele opens directly.
// Tele itself ships inside the app (see WebAssets) and only talks to the Matrix server
public class MainActivity extends Activity {
    private static final int FILE_CHOOSER_REQUEST = 1;
    private static final int PERMISSION_REQUEST = 2;
    private static final int LOCK_SETUP_REQUEST = 3;
    private static final int TELE_DARK = 0xFF212121;
    private static final int TELE_LIGHT = 0xFFFFFFFF;
    private static final long UPDATE_CHECK_INTERVAL_MS = 12 * 60 * 60 * 1000L;
    private static final String PREFS = "app";

    private FrameLayout root;
    private CalculatorView calculator;
    private WebView webView;
    private WebAssets assets;
    private FileSaver fileSaver;
    private ValueCallback<Uri[]> fileCallback;
    private PermissionRequest pendingPermission;
    private boolean isTeleDark = true;
    // Set while our own screens (file picker, lock setup) cover the app, so leaving for them doesn't lock
    private boolean isInOwnScreen;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        root = new FrameLayout(this);
        root.setFitsSystemWindows(true);
        setContentView(root);
        fileSaver = new FileSaver(this);

        calculator = new CalculatorView(this);
        calculator.setListener((keys) -> {
            if (!LockStore.matches(this, keys)) return false;
            calculator.clear();
            showTele();
            return true;
        });
        root.addView(calculator, new FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));

        applyPrivacy();
        // Tele loads behind the calculator, so it is ready the moment the calculation is typed
        createWebView();
        if (LockStore.isOn(this)) showCalculator();
        else showTele();
        forgetNotificationData();
    }

    @Override
    protected void onStop() {
        super.onStop();
        if (!isInOwnScreen && LockStore.isOn(this)) showCalculator();
    }

    @Override
    protected void onResume() {
        super.onResume();
        isInOwnScreen = false;
        if (webView.getVisibility() == View.VISIBLE) onTeleShown();
    }

    @Override
    public void onBackPressed() {
        if (webView.getVisibility() == View.VISIBLE && webView.canGoBack()) {
            webView.goBack();
            return;
        }
        // Keep Tele running instead of closing it
        moveTaskToBack(true);
    }

    private void showCalculator() {
        calculator.clear();
        calculator.setVisibility(View.VISIBLE);
        webView.setVisibility(View.INVISIBLE);
        setBarColors(getColor(R.color.calc_background), false);
        View focused = getCurrentFocus();
        if (focused != null) focused.clearFocus();
    }

    private void showTele() {
        webView.setVisibility(View.VISIBLE);
        calculator.setVisibility(View.GONE);
        webView.requestFocus();
        onTeleShown();
    }

    private void onTeleShown() {
        setBarColors(isTeleDark ? TELE_DARK : TELE_LIGHT, !isTeleDark);
        checkForUpdate();
    }

    @SuppressWarnings("deprecation")
    private void setBarColors(int color, boolean isLight) {
        Window window = getWindow();
        window.setStatusBarColor(color);
        window.setNavigationBarColor(color);
        root.setBackgroundColor(color);
        int flags = window.getDecorView().getSystemUiVisibility();
        int lightFlags = View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR
            | (Build.VERSION.SDK_INT >= 26 ? View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR : 0);
        window.getDecorView().setSystemUiVisibility(isLight ? flags | lightFlags : flags & ~lightFlags);
    }

    // Recent apps would otherwise show a picture of the chats
    private void applyPrivacy() {
        boolean isOn = LockStore.isOn(this);
        if (Build.VERSION.SDK_INT >= 33) {
            setRecentsScreenshotEnabled(!isOn);
        } else if (isOn) {
            getWindow().addFlags(WindowManager.LayoutParams.FLAG_SECURE);
        } else {
            getWindow().clearFlags(WindowManager.LayoutParams.FLAG_SECURE);
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    private void createWebView() {
        final String appHost = Uri.parse(BuildConfig.APP_URL).getHost();
        assets = new WebAssets(this, appHost == null ? "" : appHost);
        ServiceWorkerController.getInstance().setServiceWorkerClient(new ServiceWorkerClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebResourceRequest request) {
                return assets.respond(request);
            }
        });

        webView = new WebView(this);
        webView.setBackgroundColor(TELE_DARK);
        webView.setOverScrollMode(View.OVER_SCROLL_NEVER);
        webView.setVerticalScrollBarEnabled(false);
        webView.setHorizontalScrollBarEnabled(false);
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setSupportMultipleWindows(false);
        // Smoother scrolling: parts just off screen are drawn ahead, and the page renders with high priority
        settings.setOffscreenPreRaster(true);
        if (Build.VERSION.SDK_INT >= 26) webView.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, true);
        settings.setUserAgentString(settings.getUserAgentString() + " PeyvandAndroid/" + BuildConfig.VERSION_NAME);
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG);
        webView.addJavascriptInterface(new Bridge(), "PeyvandAndroid");

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                return assets.respond(request);
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                if (appHost != null && appHost.equals(uri.getHost()) && !uri.getPath().endsWith(".apk")) return false;
                // Links to other sites open in the browser
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, uri));
                } catch (ActivityNotFoundException ignored) {
                    // Nothing can open it
                }
                return true;
            }
        });
        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (fileCallback != null) fileCallback.onReceiveValue(null);
                fileCallback = callback;
                Intent intent = buildFileIntent(params);
                try {
                    isInOwnScreen = true;
                    startActivityForResult(intent, FILE_CHOOSER_REQUEST);
                } catch (ActivityNotFoundException e) {
                    isInOwnScreen = false;
                    fileCallback = null;
                    return false;
                }
                return true;
            }

            @Override
            public void onPermissionRequest(PermissionRequest request) {
                runOnUiThread(() -> handlePermissionRequest(request));
            }
        });
        root.addView(webView, 0, new FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
        webView.loadUrl(BuildConfig.APP_URL);
    }

    // Tele asks for several types at once ("image/*,video/*"), which the WebView's own intent can't express
    private static Intent buildFileIntent(WebChromeClient.FileChooserParams params) {
        List<String> types = new ArrayList<>();
        for (String accept : params.getAcceptTypes()) {
            for (String type : accept.split(",")) {
                String trimmed = type.trim();
                if (trimmed.isEmpty()) continue;
                if (trimmed.startsWith(".")) {
                    String fromExtension = MimeTypeMap.getSingleton().getMimeTypeFromExtension(trimmed.substring(1));
                    if (fromExtension == null) {
                        types.clear();
                        types.add("*/*");
                        break;
                    }
                    trimmed = fromExtension;
                }
                types.add(trimmed);
            }
        }
        Intent intent = new Intent(Intent.ACTION_GET_CONTENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        if (types.isEmpty() || types.contains("*/*")) {
            intent.setType("*/*");
        } else if (types.size() == 1) {
            intent.setType(types.get(0));
        } else {
            intent.setType("*/*");
            intent.putExtra(Intent.EXTRA_MIME_TYPES, types.toArray(new String[0]));
        }
        intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE,
            params.getMode() == WebChromeClient.FileChooserParams.MODE_OPEN_MULTIPLE);
        return intent;
    }

    // Several picked files come back as a list rather than a single address
    private static Uri[] readPickedFiles(int resultCode, Intent data) {
        if (resultCode != RESULT_OK || data == null) return null;
        ClipData clip = data.getClipData();
        if (clip != null && clip.getItemCount() > 0) {
            Uri[] uris = new Uri[clip.getItemCount()];
            for (int i = 0; i < uris.length; i++) uris[i] = clip.getItemAt(i).getUri();
            return uris;
        }
        return data.getData() == null ? null : new Uri[] {data.getData()};
    }

    // Voice messages and calls need the microphone (and camera); Android asks the user first
    private void handlePermissionRequest(PermissionRequest request) {
        List<String> needed = new ArrayList<>();
        for (String resource : request.getResources()) {
            if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(resource)) needed.add(Manifest.permission.RECORD_AUDIO);
            if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(resource)) needed.add(Manifest.permission.CAMERA);
        }
        List<String> missing = new ArrayList<>();
        for (String permission : needed) {
            if (checkSelfPermission(permission) != PackageManager.PERMISSION_GRANTED) missing.add(permission);
        }
        if (missing.isEmpty()) {
            request.grant(request.getResources());
            return;
        }
        if (pendingPermission != null) pendingPermission.deny();
        pendingPermission = request;
        requestPermissions(missing.toArray(new String[0]), PERMISSION_REQUEST);
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] results) {
        if (requestCode != PERMISSION_REQUEST || pendingPermission == null) return;
        boolean isGranted = results.length > 0;
        for (int result : results) isGranted &= result == PackageManager.PERMISSION_GRANTED;
        if (isGranted) pendingPermission.grant(pendingPermission.getResources());
        else pendingPermission.deny();
        pendingPermission = null;
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == FILE_CHOOSER_REQUEST && fileCallback != null) {
            fileCallback.onReceiveValue(readPickedFiles(resultCode, data));
            fileCallback = null;
        } else if (requestCode == LOCK_SETUP_REQUEST) {
            applyPrivacy();
            webView.evaluateJavascript("window.dispatchEvent(new Event('peyvandcalculatorlock'))", null);
        }
    }

    // Version 2 checked for messages in the background with a copy of the login; nothing of that is kept now
    private void forgetNotificationData() {
        getSharedPreferences("session", MODE_PRIVATE).edit().clear().apply();
        getSharedPreferences("notify", MODE_PRIVATE).edit().clear().apply();
        android.app.NotificationManager manager = getSystemService(android.app.NotificationManager.class);
        if (manager != null) {
            manager.cancelAll();
            if (Build.VERSION.SDK_INT >= 26) {
                manager.deleteNotificationChannel("messages");
                manager.deleteNotificationChannel("background");
            }
        }
    }

    // New versions of the app are announced in android-version.txt next to the APK on the website
    private void checkForUpdate() {
        SharedPreferences prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
        long now = System.currentTimeMillis();
        if (now - prefs.getLong("updateCheckedAt", 0) < UPDATE_CHECK_INTERVAL_MS) return;
        prefs.edit().putLong("updateCheckedAt", now).apply();
        new Thread(() -> {
            try {
                // The CDN in front of the site caches files regardless of their headers; a changing query skips it
                URL url = new URL(Uri.parse(BuildConfig.APP_URL).buildUpon().path("android-version.txt")
                    .appendQueryParameter("t", String.valueOf(now)).build().toString());
                HttpURLConnection connection = (HttpURLConnection) url.openConnection();
                connection.setConnectTimeout(15000);
                connection.setReadTimeout(15000);
                int latest;
                try (BufferedReader reader = new BufferedReader(
                    new InputStreamReader(connection.getInputStream(), StandardCharsets.UTF_8))) {
                    latest = Integer.parseInt(reader.readLine().trim());
                } finally {
                    connection.disconnect();
                }
                if (latest > BuildConfig.VERSION_CODE) runOnUiThread(() -> offerUpdate(latest));
            } catch (Exception ignored) {
                // Try again next time
            }
        }).start();
    }

    private void offerUpdate(int version) {
        if (isFinishing() || webView.getVisibility() != View.VISIBLE) return;
        new AlertDialog.Builder(this)
            .setTitle("Update available")
            .setMessage("A new version of the app is ready. Download it and open the file to install it; "
                + "you stay signed in.")
            .setPositiveButton("Download", (dialog, which) -> {
                Uri apk = Uri.parse(BuildConfig.APP_URL).buildUpon().path("calculator.apk")
                    .appendQueryParameter("v", String.valueOf(version)).build();
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, apk));
                } catch (ActivityNotFoundException ignored) {
                    // No browser
                }
            })
            .setNegativeButton("Later", null)
            .show();
    }

    // What Tele's pages can call
    private class Bridge {
        @JavascriptInterface
        public boolean isCalculatorLockOn() {
            return LockStore.isOn(MainActivity.this);
        }

        @JavascriptInterface
        public void openCalculatorLock() {
            runOnUiThread(() -> {
                isInOwnScreen = true;
                startActivityForResult(new Intent(MainActivity.this, LockSetupActivity.class), LOCK_SETUP_REQUEST);
            });
        }

        @JavascriptInterface
        public void setDarkTheme(boolean isDark) {
            runOnUiThread(() -> {
                isTeleDark = isDark;
                webView.setBackgroundColor(isDark ? TELE_DARK : TELE_LIGHT);
                if (webView.getVisibility() == View.VISIBLE) {
                    setBarColors(isDark ? TELE_DARK : TELE_LIGHT, !isDark);
                }
            });
        }

        @JavascriptInterface
        public String startFile(String filename, String mimeType) {
            // Before Android 10, writing to Downloads needs the storage permission
            if (Build.VERSION.SDK_INT < 29 && checkSelfPermission(Manifest.permission.WRITE_EXTERNAL_STORAGE)
                != PackageManager.PERMISSION_GRANTED) {
                runOnUiThread(() -> {
                    Toast.makeText(MainActivity.this, "Allow storage, then save the file again",
                        Toast.LENGTH_LONG).show();
                    requestPermissions(new String[] {Manifest.permission.WRITE_EXTERNAL_STORAGE}, PERMISSION_REQUEST);
                });
                return "";
            }
            String id = fileSaver.start(filename, mimeType);
            if (id.isEmpty()) {
                runOnUiThread(() -> Toast.makeText(MainActivity.this, "Couldn't save the file",
                    Toast.LENGTH_SHORT).show());
            }
            return id;
        }

        @JavascriptInterface
        public boolean appendFile(String id, String base64) {
            return fileSaver.append(id, base64);
        }

        @JavascriptInterface
        public void finishFile(String id) {
            String name = fileSaver.finish(id);
            runOnUiThread(() -> Toast.makeText(MainActivity.this,
                name == null ? "Couldn't save the file" : "Saved to Downloads: " + name, Toast.LENGTH_SHORT).show());
        }
    }
}

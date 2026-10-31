package com.pocketcalc.app;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;

import java.util.ArrayList;
import java.util.List;

// Opens as a calculator once the user has picked a calculation; typing it and pressing "=" shows Tele.
// Leaving the app hides Tele behind the calculator again. Without a calculation set, Tele opens directly
public class MainActivity extends Activity {
    private static final int FILE_CHOOSER_REQUEST = 1;
    private static final int PERMISSION_REQUEST = 2;
    private static final int LOCK_SETUP_REQUEST = 3;

    private FrameLayout root;
    private CalculatorView calculator;
    private WebView webView;
    private ValueCallback<Uri[]> fileCallback;
    private PermissionRequest pendingPermission;
    // Set while our own screens (file picker, lock setup) cover the app, so leaving for them doesn't lock
    private boolean isInOwnScreen;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        root = new FrameLayout(this);
        root.setFitsSystemWindows(true);
        setContentView(root);

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
        getWindow().setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_STATE_ALWAYS_HIDDEN);
        View focused = getCurrentFocus();
        if (focused != null) focused.clearFocus();
    }

    private void showTele() {
        webView.setVisibility(View.VISIBLE);
        calculator.setVisibility(View.GONE);
        webView.requestFocus();
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
        webView = new WebView(this);
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setSupportMultipleWindows(false);
        settings.setUserAgentString(settings.getUserAgentString() + " PeyvandAndroid/" + BuildConfig.VERSION_NAME);
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG);
        webView.addJavascriptInterface(new Bridge(), "PeyvandAndroid");

        final String appHost = Uri.parse(BuildConfig.APP_URL).getHost();
        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                if (appHost != null && appHost.equals(uri.getHost())) return false;
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
                Intent intent = params.createIntent();
                intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE,
                    params.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE);
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
            fileCallback.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(resultCode, data));
            fileCallback = null;
        } else if (requestCode == LOCK_SETUP_REQUEST) {
            applyPrivacy();
            webView.evaluateJavascript("window.dispatchEvent(new Event('peyvandcalculatorlock'))", null);
        }
    }

    // What Tele's settings page can call
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
    }
}

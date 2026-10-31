package com.pocketcalc.app;

import android.content.Context;
import android.net.Uri;
import android.webkit.MimeTypeMap;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;

// Tele's web build ships inside the APK (assets/web, listed in assets/web-files.txt). Requests for the app's own
// address are answered from there, so Tele starts without the website; anything not bundled (like the large
// emoji images) still comes from the network
final class WebAssets {
    private static final String ROOT = "web";
    private static final Map<String, String> EXTRA_TYPES = new HashMap<>();

    static {
        EXTRA_TYPES.put("js", "text/javascript");
        EXTRA_TYPES.put("mjs", "text/javascript");
        EXTRA_TYPES.put("css", "text/css");
        EXTRA_TYPES.put("html", "text/html");
        EXTRA_TYPES.put("json", "application/json");
        EXTRA_TYPES.put("webmanifest", "application/manifest+json");
        EXTRA_TYPES.put("wasm", "application/wasm");
        EXTRA_TYPES.put("svg", "image/svg+xml");
        EXTRA_TYPES.put("tgs", "application/gzip");
        EXTRA_TYPES.put("txt", "text/plain");
        EXTRA_TYPES.put("woff2", "font/woff2");
    }

    private final Context context;
    private final String host;
    private final Set<String> files = new HashSet<>();

    WebAssets(Context context, String host) {
        this.context = context.getApplicationContext();
        this.host = host;
        try (InputStream in = this.context.getAssets().open("web-files.txt");
             BufferedReader reader = new BufferedReader(new InputStreamReader(in, StandardCharsets.UTF_8))) {
            String line;
            while ((line = reader.readLine()) != null) {
                if (!line.isEmpty()) files.add(line);
            }
        } catch (IOException e) {
            // No bundled build: everything loads from the website
        }
    }

    boolean isBundled() {
        return !files.isEmpty();
    }

    WebResourceResponse respond(WebResourceRequest request) {
        if (!"GET".equals(request.getMethod())) return null;
        Uri uri = request.getUrl();
        if (!"https".equals(uri.getScheme()) || !host.equals(uri.getHost())) return null;
        String path = uri.getPath();
        if (path == null || path.isEmpty() || path.equals("/")) path = "/index.html";
        String file = path.substring(1);
        if (!files.contains(file)) return null;
        try {
            InputStream stream = context.getAssets().open(ROOT + "/" + file);
            WebResourceResponse response = new WebResourceResponse(typeOf(file), null, stream);
            Map<String, String> headers = new HashMap<>();
            headers.put("Cache-Control", file.startsWith("assets/") ? "max-age=31536000, immutable" : "no-cache");
            headers.put("Access-Control-Allow-Origin", "*");
            if (file.endsWith(".js")) headers.put("Service-Worker-Allowed", "/");
            response.setResponseHeaders(headers);
            return response;
        } catch (IOException e) {
            return null;
        }
    }

    private static String typeOf(String file) {
        int dot = file.lastIndexOf('.');
        String extension = dot < 0 ? "" : file.substring(dot + 1).toLowerCase();
        String type = EXTRA_TYPES.get(extension);
        if (type == null) type = MimeTypeMap.getSingleton().getMimeTypeFromExtension(extension);
        return type == null ? "application/octet-stream" : type;
    }
}

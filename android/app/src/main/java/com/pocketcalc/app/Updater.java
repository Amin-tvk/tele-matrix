package com.pocketcalc.app;

import android.app.Activity;
import android.app.AlertDialog;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInstaller;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;

import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;

// Downloads a new version inside the app and hands it to Android's installer, so updating is one tap instead of
// a trip through the browser and the Downloads folder. The new APK is signed with the same key, so Android
// installs it over this one and everything stays as it was. Like Telegram, the progress shows on Tele's own
// "Update" button at the bottom of the chat list, which the listener passes on to
final class Updater {
    private static final String PREFS = "app";
    private static final String PENDING_VERSION = "pendingInstallVersion";

    static final String STATE_DOWNLOADING = "downloading";
    static final String STATE_INSTALLING = "installing";
    static final String STATE_FAILED = "failed";
    static final String STATE_AVAILABLE = "available";

    interface Listener {
        void onState(String state, int percent);
    }

    private static boolean isRunning;

    private Updater() {}

    static void start(Activity activity, int version, Listener listener) {
        if (isRunning) return;
        // Android 8+ asks once whether this app may install updates
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && !activity.getPackageManager().canRequestPackageInstalls()) {
            activity.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putInt(PENDING_VERSION, version).apply();
            new AlertDialog.Builder(activity)
                .setTitle("Allow updates")
                .setMessage("To install the update, turn on \"Allow from this source\" on the next screen, then come back.")
                .setPositiveButton("Continue", (dialog, which) -> {
                    try {
                        activity.startActivity(new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                            Uri.parse("package:" + activity.getPackageName())));
                    } catch (Exception ignored) {
                        // No such screen on this phone
                    }
                })
                .setNegativeButton("Later", null)
                .show();
            return;
        }
        download(activity, version, listener);
    }

    // Called when the app comes back from the "install unknown apps" screen
    static void resumePending(Activity activity, Listener listener) {
        int version = activity.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getInt(PENDING_VERSION, 0);
        if (version == 0) return;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && !activity.getPackageManager().canRequestPackageInstalls()) {
            return;
        }
        activity.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().remove(PENDING_VERSION).apply();
        download(activity, version, listener);
    }

    private static void download(Activity activity, int version, Listener listener) {
        isRunning = true;
        listener.onState(STATE_DOWNLOADING, 0);
        new Thread(() -> {
            boolean isDone = false;
            try {
                install(activity, version, (percent) -> activity.runOnUiThread(
                    () -> listener.onState(STATE_DOWNLOADING, percent)));
                isDone = true;
            } catch (Exception ignored) {
                // Shown on the button, which then tries again
            }
            boolean isInstalling = isDone;
            activity.runOnUiThread(() -> {
                isRunning = false;
                listener.onState(isInstalling ? STATE_INSTALLING : STATE_FAILED, 100);
            });
        }).start();
    }

    private interface Progress {
        void update(int percent);
    }

    private static void install(Activity activity, int version, Progress progress) throws Exception {
        // Always the latest build; the site serves it uncached (see android/README.md)
        URL url = new URL(Uri.parse(BuildConfig.APP_URL).buildUpon().path("download")
            .appendQueryParameter("v", String.valueOf(version)).build().toString());
        HttpURLConnection connection = (HttpURLConnection) url.openConnection();
        connection.setConnectTimeout(20000);
        connection.setReadTimeout(30000);
        PackageInstaller installer = activity.getPackageManager().getPackageInstaller();
        PackageInstaller.SessionParams params =
            new PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL);
        params.setAppPackageName(activity.getPackageName());
        int sessionId = installer.createSession(params);
        try (PackageInstaller.Session session = installer.openSession(sessionId)) {
            long total = connection.getContentLengthLong();
            try (InputStream in = connection.getInputStream();
                 OutputStream out = session.openWrite("update.apk", 0, total > 0 ? total : -1)) {
                byte[] buffer = new byte[64 * 1024];
                long done = 0;
                int lastPercent = -1;
                int read;
                while ((read = in.read(buffer)) != -1) {
                    out.write(buffer, 0, read);
                    done += read;
                    int percent = total > 0 ? (int) (done * 100 / total) : 0;
                    if (percent != lastPercent) {
                        lastPercent = percent;
                        progress.update(percent);
                    }
                }
                session.fsync(out);
            } finally {
                connection.disconnect();
            }
            Intent result = new Intent(activity, InstallReceiver.class);
            int flags = PendingIntent.FLAG_UPDATE_CURRENT
                | (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S ? PendingIntent.FLAG_MUTABLE : 0);
            session.commit(PendingIntent.getBroadcast(activity, sessionId, result, flags).getIntentSender());
        } catch (Exception e) {
            installer.abandonSession(sessionId);
            throw e;
        }
    }
}

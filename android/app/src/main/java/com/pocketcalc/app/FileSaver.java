package com.pocketcalc.app;

import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.util.HashMap;
import java.util.Map;
import java.util.UUID;

// Saves files Tele downloads into the phone's Downloads folder. They arrive from the page in pieces
final class FileSaver {
    private static final class Pending {
        final OutputStream out;
        final Uri uri;
        final String name;

        Pending(OutputStream out, Uri uri, String name) {
            this.out = out;
            this.uri = uri;
            this.name = name;
        }
    }

    private final Context context;
    private final Map<String, Pending> pending = new HashMap<>();

    FileSaver(Context context) {
        this.context = context.getApplicationContext();
    }

    synchronized String start(String filename, String mimeType) {
        String name = cleanName(filename);
        try {
            Pending file;
            if (Build.VERSION.SDK_INT >= 29) {
                ContentValues values = new ContentValues();
                values.put(MediaStore.Downloads.DISPLAY_NAME, name);
                values.put(MediaStore.Downloads.MIME_TYPE, mimeType);
                values.put(MediaStore.Downloads.IS_PENDING, 1);
                ContentResolver resolver = context.getContentResolver();
                Uri uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
                if (uri == null) return "";
                OutputStream out = resolver.openOutputStream(uri);
                if (out == null) return "";
                file = new Pending(out, uri, name);
            } else {
                File dir = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS);
                if (!dir.exists() && !dir.mkdirs()) return "";
                File target = uniqueFile(dir, name);
                file = new Pending(new FileOutputStream(target), null, target.getName());
            }
            String id = UUID.randomUUID().toString();
            pending.put(id, file);
            return id;
        } catch (IOException | SecurityException e) {
            return "";
        }
    }

    synchronized boolean append(String id, String base64) {
        Pending file = pending.get(id);
        if (file == null) return false;
        try {
            file.out.write(Base64.decode(base64, Base64.DEFAULT));
            return true;
        } catch (IOException | IllegalArgumentException e) {
            abandon(id, file);
            return false;
        }
    }

    // The saved file's name, or null when saving failed
    synchronized String finish(String id) {
        Pending file = pending.remove(id);
        if (file == null) return null;
        try {
            file.out.close();
            if (file.uri != null) {
                ContentValues values = new ContentValues();
                values.put(MediaStore.Downloads.IS_PENDING, 0);
                context.getContentResolver().update(file.uri, values, null, null);
            }
            return file.name;
        } catch (IOException e) {
            return null;
        }
    }

    private void abandon(String id, Pending file) {
        pending.remove(id);
        try {
            file.out.close();
        } catch (IOException ignored) {
            // Already broken
        }
        if (file.uri != null) context.getContentResolver().delete(file.uri, null, null);
    }

    private static String cleanName(String filename) {
        String name = filename == null ? "" : filename.replaceAll("[\\\\/:*?\"<>|\\p{Cntrl}]", "_").trim();
        return name.isEmpty() ? "file" : name;
    }

    private static File uniqueFile(File dir, String name) {
        File file = new File(dir, name);
        int dot = name.lastIndexOf('.');
        String base = dot > 0 ? name.substring(0, dot) : name;
        String extension = dot > 0 ? name.substring(dot) : "";
        for (int i = 1; file.exists(); i++) file = new File(dir, base + " (" + i + ")" + extension);
        return file;
    }
}

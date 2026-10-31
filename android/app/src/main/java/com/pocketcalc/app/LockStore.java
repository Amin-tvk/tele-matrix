package com.pocketcalc.app;

import android.content.Context;
import android.content.SharedPreferences;
import android.util.Base64;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.security.SecureRandom;

// The calculation that opens Tele. Only a salted hash is kept, so the app's files don't reveal it
final class LockStore {
    private static final String PREFS = "calculator";
    private static final String KEY_SALT = "salt";
    private static final String KEY_HASH = "hash";

    private LockStore() {
    }

    private static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    static boolean isOn(Context context) {
        return prefs(context).contains(KEY_HASH);
    }

    static boolean matches(Context context, String keys) {
        SharedPreferences prefs = prefs(context);
        String salt = prefs.getString(KEY_SALT, null);
        String hash = prefs.getString(KEY_HASH, null);
        return salt != null && hash != null && MessageDigest.isEqual(
            hash.getBytes(StandardCharsets.UTF_8), hash(salt, keys).getBytes(StandardCharsets.UTF_8));
    }

    static void set(Context context, String keys) {
        byte[] bytes = new byte[16];
        new SecureRandom().nextBytes(bytes);
        String salt = Base64.encodeToString(bytes, Base64.NO_WRAP);
        prefs(context).edit().putString(KEY_SALT, salt).putString(KEY_HASH, hash(salt, keys)).apply();
    }

    static void turnOff(Context context) {
        prefs(context).edit().clear().apply();
    }

    private static String hash(String salt, String keys) {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            byte[] result = digest.digest((salt + keys).getBytes(StandardCharsets.UTF_8));
            return Base64.encodeToString(result, Base64.NO_WRAP);
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }
}

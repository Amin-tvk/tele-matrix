package com.pocketcalc.app;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONException;
import org.json.JSONObject;

// The Matrix login Tele shares with the app, so it can check for new messages while Tele is closed
final class SessionStore {
    static final class Session {
        final String homeserver;
        final String accessToken;

        Session(String homeserver, String accessToken) {
            this.homeserver = homeserver.replaceAll("/+$", "");
            this.accessToken = accessToken;
        }
    }

    private static final String PREFS = "session";
    private static final String KEY_HOMESERVER = "homeserver";
    private static final String KEY_TOKEN = "token";

    private SessionStore() {
    }

    private static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    // True when the login changed
    static boolean save(Context context, String sessionJson) {
        try {
            JSONObject json = new JSONObject(sessionJson);
            String homeserver = json.optString("homeserver", "");
            String token = json.optString("accessToken", "");
            if (homeserver.isEmpty() || token.isEmpty()) return false;
            SharedPreferences prefs = prefs(context);
            if (token.equals(prefs.getString(KEY_TOKEN, null))) return false;
            prefs.edit().putString(KEY_HOMESERVER, homeserver).putString(KEY_TOKEN, token).apply();
            return true;
        } catch (JSONException e) {
            return false;
        }
    }

    static Session load(Context context) {
        SharedPreferences prefs = prefs(context);
        String homeserver = prefs.getString(KEY_HOMESERVER, null);
        String token = prefs.getString(KEY_TOKEN, null);
        return homeserver == null || token == null ? null : new Session(homeserver, token);
    }

    static void clear(Context context) {
        prefs(context).edit().clear().apply();
    }
}

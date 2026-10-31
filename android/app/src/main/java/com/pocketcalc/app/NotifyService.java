package com.pocketcalc.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.IBinder;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Set;

// Shows notifications for new messages while Tele is closed. Google's push service is out of reach, so the app
// asks the server for the account's notification list every minute. That list (unlike /sync) leaves the device's
// encryption key messages for Tele itself
public class NotifyService extends Service {
    private static final String CHANNEL_MESSAGES = "messages";
    private static final String CHANNEL_BACKGROUND = "background";
    private static final int FOREGROUND_ID = 1;
    private static final long POLL_INTERVAL_MS = 60 * 1000;
    private static final long RETRY_INTERVAL_MS = 30 * 1000;
    private static final int TIMEOUT_MS = 20 * 1000;
    private static final String PREFS = "notify";
    private static final String KEY_LAST_TS = "lastTs";

    // Set by MainActivity while Tele is on screen: then there's nothing to notify about
    static volatile boolean isTeleVisible;

    private HandlerThread thread;
    private Handler handler;
    private final Map<String, String> roomNames = new HashMap<>();
    private final Map<String, String> userNames = new HashMap<>();
    private final Set<String> shownRooms = new HashSet<>();

    static void start(Context context) {
        if (SessionStore.load(context) == null) return;
        Intent intent = new Intent(context, NotifyService.class);
        try {
            if (Build.VERSION.SDK_INT >= 26) context.startForegroundService(intent);
            else context.startService(intent);
        } catch (RuntimeException e) {
            // Android refused a background start; the next app launch starts it
        }
    }

    static void stop(Context context) {
        context.stopService(new Intent(context, NotifyService.class));
        context.getSharedPreferences(PREFS, MODE_PRIVATE).edit().clear().apply();
    }

    // Called when Tele comes on screen: whatever was waiting is being read now
    static void clearMessages(Context context) {
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        for (android.service.notification.StatusBarNotification shown : manager.getActiveNotifications()) {
            if (shown.getId() != FOREGROUND_ID) manager.cancel(shown.getTag(), shown.getId());
        }
    }

    @Override
    public void onCreate() {
        super.onCreate();
        createChannels();
        Notification notification = baseBuilder(CHANNEL_BACKGROUND)
            .setContentTitle(getString(R.string.app_name))
            .setOngoing(true)
            .build();
        if (Build.VERSION.SDK_INT >= 29) {
            startForeground(FOREGROUND_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
        } else {
            startForeground(FOREGROUND_ID, notification);
        }
        thread = new HandlerThread("notify");
        thread.start();
        handler = new Handler(thread.getLooper());
        handler.post(this::poll);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        if (thread != null) thread.quitSafely();
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    private void createChannels() {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager manager = getSystemService(NotificationManager.class);
        NotificationChannel messages = new NotificationChannel(CHANNEL_MESSAGES, "Messages",
            NotificationManager.IMPORTANCE_HIGH);
        manager.createNotificationChannel(messages);
        NotificationChannel background = new NotificationChannel(CHANNEL_BACKGROUND, "Running in background",
            NotificationManager.IMPORTANCE_MIN);
        background.setShowBadge(false);
        manager.createNotificationChannel(background);
    }

    private Notification.Builder baseBuilder(String channel) {
        Notification.Builder builder = Build.VERSION.SDK_INT >= 26
            ? new Notification.Builder(this, channel) : new Notification.Builder(this);
        Intent open = new Intent(this, MainActivity.class).setFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        PendingIntent pending = PendingIntent.getActivity(this, 0, open,
            PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        return builder.setSmallIcon(R.drawable.ic_notification).setContentIntent(pending);
    }

    private void poll() {
        SessionStore.Session session = SessionStore.load(this);
        if (session == null) {
            stopSelf();
            return;
        }
        long delay = POLL_INTERVAL_MS;
        try {
            check(session);
        } catch (UnauthorizedException e) {
            // Signed out somewhere else
            SessionStore.clear(this);
            stopSelf();
            return;
        } catch (Exception e) {
            delay = RETRY_INTERVAL_MS;
        }
        handler.postDelayed(this::poll, delay);
    }

    private static final class UnauthorizedException extends IOException {
    }

    private static final class RoomUpdate {
        int count;
        long ts;
        JSONObject event;
    }

    private void check(SessionStore.Session session) throws Exception {
        JSONObject result = get(session, "/_matrix/client/v3/notifications?limit=50");
        JSONArray list = result.optJSONArray("notifications");
        if (list == null) return;
        long lastTs = getSharedPreferences(PREFS, MODE_PRIVATE).getLong(KEY_LAST_TS, 0);
        boolean isFirstCheck = lastTs == 0;
        long newestTs = lastTs;
        Map<String, RoomUpdate> unread = new LinkedHashMap<>();
        Set<String> roomsWithNew = new HashSet<>();
        for (int i = 0; i < list.length(); i++) {
            JSONObject item = list.getJSONObject(i);
            if (item.optBoolean("read", true)) continue;
            String roomId = item.optString("room_id");
            long ts = item.optLong("ts");
            RoomUpdate update = unread.get(roomId);
            if (update == null) {
                update = new RoomUpdate();
                unread.put(roomId, update);
            }
            update.count++;
            if (ts > update.ts) {
                update.ts = ts;
                update.event = item.optJSONObject("event");
            }
            if (ts > lastTs) roomsWithNew.add(roomId);
            newestTs = Math.max(newestTs, ts);
        }
        getSharedPreferences(PREFS, MODE_PRIVATE).edit().putLong(KEY_LAST_TS, Math.max(newestTs, 1)).apply();

        NotificationManager manager = getSystemService(NotificationManager.class);
        // Rooms read on another device lose their notification
        for (String roomId : new HashSet<>(shownRooms)) {
            if (!unread.containsKey(roomId)) {
                manager.cancel(roomId, 0);
                shownRooms.remove(roomId);
            }
        }
        // Old unread messages from before the app started checking don't ring
        if (isTeleVisible) {
            clearMessages(this);
            shownRooms.clear();
            return;
        }
        if (isFirstCheck) return;
        boolean isDisguised = LockStore.isOn(this);
        for (Map.Entry<String, RoomUpdate> entry : unread.entrySet()) {
            String roomId = entry.getKey();
            if (!roomsWithNew.contains(roomId)) continue;
            RoomUpdate update = entry.getValue();
            Notification.Builder builder = baseBuilder(CHANNEL_MESSAGES)
                .setAutoCancel(true)
                .setWhen(update.ts)
                .setShowWhen(true)
                .setNumber(update.count)
                .setCategory(Notification.CATEGORY_MESSAGE);
            if (Build.VERSION.SDK_INT < 26) builder.setPriority(Notification.PRIORITY_HIGH);
            if (isDisguised) {
                // Nothing on the lock screen should give Tele away
                builder.setContentTitle(getString(R.string.app_name)).setContentText("You have new notifications");
            } else {
                String sender = update.event == null ? "" : update.event.optString("sender");
                String senderName = userName(session, sender);
                String roomName = roomName(session, roomId);
                String text = describe(update.event);
                if (roomName == null) {
                    builder.setContentTitle(senderName).setContentText(text);
                } else {
                    builder.setContentTitle(roomName).setContentText(senderName + ": " + text);
                }
                if (update.count > 1) builder.setSubText(update.count + " new messages");
            }
            manager.notify(roomId, 0, builder.build());
            shownRooms.add(roomId);
        }
    }

    // Encrypted messages can only be read inside Tele
    private static String describe(JSONObject event) {
        if (event == null) return "New message";
        JSONObject content = event.optJSONObject("content");
        String type = event.optString("type");
        if ("m.room.message".equals(type) && content != null) {
            String msgtype = content.optString("msgtype");
            if ("m.image".equals(msgtype)) return "Photo";
            if ("m.video".equals(msgtype)) return "Video";
            if ("m.audio".equals(msgtype)) return "Voice message";
            if ("m.file".equals(msgtype)) return "File";
            String body = content.optString("body");
            if (!body.isEmpty()) return body.length() > 200 ? body.substring(0, 200) + "…" : body;
        }
        if ("m.sticker".equals(type)) return "Sticker";
        if ("m.room.member".equals(type)) return "Invitation";
        return "New message";
    }

    private String roomName(SessionStore.Session session, String roomId) {
        if (roomNames.containsKey(roomId)) return roomNames.get(roomId);
        String name = null;
        try {
            name = get(session, "/_matrix/client/v3/rooms/" + Uri.encode(roomId) + "/state/m.room.name")
                .optString("name", null);
            if (name != null && name.isEmpty()) name = null;
        } catch (Exception ignored) {
            // No name: a direct chat
        }
        roomNames.put(roomId, name);
        return name;
    }

    private String userName(SessionStore.Session session, String userId) {
        if (userId.isEmpty()) return getString(R.string.app_name);
        String cached = userNames.get(userId);
        if (cached != null) return cached;
        String name = userId.startsWith("@") ? userId.substring(1).split(":")[0] : userId;
        try {
            String displayName = get(session, "/_matrix/client/v3/profile/" + Uri.encode(userId) + "/displayname")
                .optString("displayname", "");
            if (!displayName.isEmpty()) name = displayName;
        } catch (Exception ignored) {
            // Keep the ID
        }
        userNames.put(userId, name);
        return name;
    }

    private static JSONObject get(SessionStore.Session session, String path) throws Exception {
        HttpURLConnection connection = (HttpURLConnection) new URL(session.homeserver + path).openConnection();
        connection.setConnectTimeout(TIMEOUT_MS);
        connection.setReadTimeout(TIMEOUT_MS);
        connection.setRequestProperty("Authorization", "Bearer " + session.accessToken);
        try {
            int status = connection.getResponseCode();
            if (status == 401) throw new UnauthorizedException();
            if (status != 200) throw new IOException("HTTP " + status);
            try (InputStream in = connection.getInputStream()) {
                ByteArrayOutputStream out = new ByteArrayOutputStream();
                byte[] buffer = new byte[8192];
                int read;
                while ((read = in.read(buffer)) > 0) out.write(buffer, 0, read);
                return new JSONObject(new String(out.toByteArray(), StandardCharsets.UTF_8));
            }
        } finally {
            connection.disconnect();
        }
    }
}

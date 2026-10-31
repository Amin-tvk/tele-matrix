package com.pocketcalc.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

// Picks up checking for messages again after the phone restarts or the app is updated
public class BootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        NotifyService.start(context);
    }
}

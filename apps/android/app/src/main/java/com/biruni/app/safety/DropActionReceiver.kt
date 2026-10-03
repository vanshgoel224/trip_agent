package com.biruni.app.safety

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/** Handles the "I'm OK" button on the alert notification. */
class DropActionReceiver : BroadcastReceiver() {
    override fun onReceive(ctx: Context, intent: Intent) {
        if (intent.action == DropWatchService.ACTION_CANCEL) DropWatchService.cancel(ctx, "screen")
    }
}

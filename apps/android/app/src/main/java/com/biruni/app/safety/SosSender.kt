package com.biruni.app.safety

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.pm.PackageManager
import android.location.Location
import android.location.LocationManager
import android.telephony.SmsManager
import androidx.core.content.ContextCompat
import com.biruni.app.BiruniApp
import com.biruni.app.net.BiruniClient

/** Sends an SOS: Biruni server first (reaches trip members and helpers), SMS to your numbers as the backup. */
object SosSender {
    data class Outcome(val server: Boolean, val smsSent: Int, val detail: String)

    @SuppressLint("MissingPermission")
    fun lastLocation(ctx: Context): Location? {
        if (ContextCompat.checkSelfPermission(ctx, Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED &&
            ContextCompat.checkSelfPermission(ctx, Manifest.permission.ACCESS_COARSE_LOCATION) != PackageManager.PERMISSION_GRANTED
        ) return null
        val lm = ctx.getSystemService(LocationManager::class.java)
        return lm.getProviders(true).mapNotNull { runCatching { lm.getLastKnownLocation(it) }.getOrNull() }.maxByOrNull { it.time }
    }

    fun mapLink(l: Location?) = l?.let { "https://maps.google.com/?q=${it.latitude},${it.longitude}" }

    /** The server session the app (or this service) can use; signs in with the stored PIN if needed. */
    fun client(ctx: Context): BiruniClient? {
        val app = ctx.applicationContext as BiruniApp
        app.client?.takeIf { it.signedIn }?.let { return it }
        val prefs = app.safety
        val pin = prefs.pin
        if (prefs.serverUrl.isBlank() || prefs.username.isBlank() || pin.isNullOrEmpty()) return null
        return runCatching { BiruniClient(prefs.serverUrl).also { it.signIn(prefs.username, pin); app.client = it } }.getOrNull()
    }

    /** Blocking. Call off the main thread. */
    fun send(ctx: Context, message: String, viaServer: Boolean = true): Outcome {
        val app = ctx.applicationContext as BiruniApp
        val loc = lastLocation(ctx)
        var server = false
        var detail = ""
        if (viaServer) {
            try {
                val c = client(ctx)
                if (c != null) {
                    c.sos(message, loc?.latitude, loc?.longitude, app.safety.everyoneOnSos)
                    server = true
                } else detail = "no Biruni server linked"
            } catch (e: Exception) { detail = e.message ?: "server unreachable" }
        }
        val sms = sendSms(ctx, "SOS from Biruni: $message${mapLink(loc)?.let { "\nMy location: $it" } ?: "\n(location unknown)"}")
        return Outcome(server, sms, detail)
    }

    /** Texts every emergency number. Returns how many were handed to the SMS system. */
    fun sendSms(ctx: Context, text: String): Int {
        val numbers = (ctx.applicationContext as BiruniApp).safety.emergencyNumbers
        if (numbers.isEmpty() || ContextCompat.checkSelfPermission(ctx, Manifest.permission.SEND_SMS) != PackageManager.PERMISSION_GRANTED) return 0
        val sms = ctx.getSystemService(SmsManager::class.java)
        var n = 0
        for (num in numbers) runCatching {
            sms.sendMultipartTextMessage(num, null, sms.divideMessage(text), null, null)
            n++
        }
        return n
    }
}

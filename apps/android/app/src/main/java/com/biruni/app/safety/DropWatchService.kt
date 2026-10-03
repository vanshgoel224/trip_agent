package com.biruni.app.safety

import android.Manifest
import android.app.Notification
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.media.AudioAttributes
import android.media.Ringtone
import android.media.RingtoneManager
import android.os.Build
import android.os.IBinder
import android.os.VibrationEffect
import android.os.Vibrator
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import com.biruni.app.BiruniApp
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import org.json.JSONObject
import kotlin.math.atan2
import kotlin.math.sqrt

data class DropState(
    val event: FallEvent,
    val secondsLeft: Int,
    val total: Int,
    val reportedToServer: Boolean,
    val result: String? = null,
    val cancelledBy: String? = null,
) {
    val active get() = result == null && cancelledBy == null
}

/**
 * Foreground service that keeps the accelerometer running with the screen off (a web app can't).
 * On a drop: report it to the server (which runs its own countdown, so the SOS still goes out if
 * this phone dies), show a full-screen alert, and run a local countdown. Cancel by tapping, shaking
 * 3 times, any hardware key on the alert screen, or from another device. At zero the SOS goes out.
 */
class DropWatchService : Service(), SensorEventListener {
    companion object {
        private val _state = MutableStateFlow<DropState?>(null)
        val state: StateFlow<DropState?> = _state
        const val ACTION_CANCEL = "cancel"
        const val ACTION_STOP = "stop"
        const val ACTION_TEST = "test"
        private const val NOTIF = 51
        private const val ALERT_NOTIF = 52
        @Volatile var running = false

        fun start(ctx: Context) = ContextCompat.startForegroundService(ctx, Intent(ctx, DropWatchService::class.java))
        fun stop(ctx: Context) { ctx.startService(Intent(ctx, DropWatchService::class.java).setAction(ACTION_STOP)) }
        fun cancel(ctx: Context, by: String) { ctx.startService(Intent(ctx, DropWatchService::class.java).setAction(ACTION_CANCEL).putExtra("by", by)) }
        /** Simulates a drop so you can rehearse the alert and cancel flow. */
        fun test(ctx: Context) = ContextCompat.startForegroundService(ctx, Intent(ctx, DropWatchService::class.java).setAction(ACTION_TEST))
    }

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private var countdown: Job? = null
    private var ringtone: Ringtone? = null
    private var sm: SensorManager? = null
    private val detector = FallDetector(::onFall)
    private val shakes = ShakeCounter({ cancelNow("shake") })
    private var gyro = 0.0
    @Volatile private var serverFallId: String? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        startAsForeground()
        when (intent?.action) {
            ACTION_STOP -> { stopSelf(); return START_NOT_STICKY }
            ACTION_CANCEL -> cancelNow(intent.getStringExtra("by") ?: "screen")
            ACTION_TEST -> onFall(FallEvent(450, 1.0, 5.2, 180, null, null, "medium"))
        }
        if (!running) {
            val mgr = getSystemService(SensorManager::class.java)
            val acc = mgr.getDefaultSensor(Sensor.TYPE_ACCELEROMETER)
            if (acc == null) { stopSelf(); return START_NOT_STICKY }
            running = true
            sm = mgr
            mgr.registerListener(this, acc, SensorManager.SENSOR_DELAY_GAME)
            mgr.getDefaultSensor(Sensor.TYPE_GYROSCOPE)?.let { mgr.registerListener(this, it, SensorManager.SENSOR_DELAY_GAME) }
        }
        return START_STICKY
    }

    private fun startAsForeground() {
        val fine = ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED
        val type = ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE or (if (fine) ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION else 0)
        ServiceCompat.startForeground(this, NOTIF, watchNotification(), type)
    }

    private fun watchNotification(): Notification = NotificationCompat.Builder(this, BiruniApp.CH_WATCH)
        .setSmallIcon(android.R.drawable.ic_lock_idle_alarm)
        .setContentTitle("Biruni drop watch is on")
        .setContentText("Sends an SOS if the phone is dropped and you don't cancel.")
        .setOngoing(true)
        .addAction(0, "Turn off", PendingIntent.getService(this, 1, Intent(this, DropWatchService::class.java).setAction(ACTION_STOP), PendingIntent.FLAG_IMMUTABLE))
        .build()

    // ---- sensors ----
    override fun onSensorChanged(e: SensorEvent) {
        val t = e.timestamp / 1_000_000
        val x = e.values[0].toDouble()
        val y = e.values[1].toDouble()
        val z = e.values[2].toDouble()
        when (e.sensor.type) {
            Sensor.TYPE_GYROSCOPE -> gyro = Math.toDegrees(sqrt(x * x + y * y + z * z))
            Sensor.TYPE_ACCELEROMETER -> {
                detector.orientation = OrientationSnap(Math.toDegrees(atan2(-x, sqrt(y * y + z * z))).toInt(), Math.toDegrees(atan2(y, z)).toInt())
                if (_state.value?.active == true) shakes.push(t, x, y, z) else detector.push(t, x, y, z, gyro)
            }
        }
    }

    override fun onAccuracyChanged(s: Sensor?, a: Int) = Unit

    // ---- fall → countdown → SOS ----
    private fun onFall(ev: FallEvent) {
        if (_state.value?.active == true) return
        val app = application as BiruniApp
        val total = app.safety.cancelWindowSec
        serverFallId = null
        _state.value = DropState(ev, total, total, false)
        alarm(true)
        showAlert(ev)
        countdown = scope.launch {
            // Report to the server in parallel: its countdown is the safety net if this phone dies.
            val report = launch(Dispatchers.IO) {
                runCatching {
                    val c = SosSender.client(this@DropWatchService) ?: return@runCatching
                    val loc = SosSender.lastLocation(this@DropWatchService)
                    val body = JSONObject().put("freefallMs", ev.freefallMs).put("heightM", ev.heightM).put("impactG", ev.impactG)
                        .put("tumbleDeg", ev.tumbleDeg).put("severity", ev.severity).put("device", Build.MODEL)
                    if (loc != null) body.put("location", JSONObject().put("lat", loc.latitude).put("lng", loc.longitude).put("accuracy", loc.accuracy.toDouble()))
                    serverFallId = c.reportFall(body).optString("id").takeIf { it.isNotEmpty() }
                    _state.value = _state.value?.takeIf { it.active }?.copy(reportedToServer = serverFallId != null)
                }
            }
            var left = total
            while (left > 0 && _state.value?.active == true) {
                delay(1000)
                left--
                _state.value = _state.value?.takeIf { it.active }?.copy(secondsLeft = left) ?: return@launch
                // Cancelled from another device or the web app? The server no longer lists it as active.
                if (left % 3 == 0 && serverFallId != null) {
                    val gone = runCatching { SosSender.client(this@DropWatchService)?.activeFall()?.isNull("active") }.getOrNull() == true
                    if (gone && _state.value?.active == true) { cancelNow("other-device", tellServer = false); return@launch }
                }
            }
            report.join()
            if (_state.value?.active != true) return@launch
            val msg = "Phone dropped (~${"%.1f".format(ev.heightM)} m, ${ev.impactG} g impact) and not cancelled. Please check on me."
            // If the server has the fall it sends the SOS itself; otherwise (offline) send it from here.
            val out = SosSender.send(this@DropWatchService, msg, viaServer = serverFallId == null)
            val parts = buildList {
                if (serverFallId != null || out.server) add("SOS sent through Biruni")
                if (out.smsSent > 0) add("SMS sent to ${out.smsSent} number(s)")
            }
            _state.value = _state.value?.copy(result = if (parts.isEmpty()) "Could not send: no server and no emergency numbers saved. Call 112." else parts.joinToString(" · "))
            alarm(false)
            getSystemService(NotificationManager::class.java).cancel(ALERT_NOTIF)
        }
    }

    private fun cancelNow(by: String, tellServer: Boolean = true) {
        val cur = _state.value ?: return
        if (!cur.active) return
        countdown?.cancel()
        _state.value = cur.copy(cancelledBy = by)
        alarm(false)
        getSystemService(NotificationManager::class.java).cancel(ALERT_NOTIF)
        val id = serverFallId
        if (tellServer && id != null) scope.launch(Dispatchers.IO) { runCatching { SosSender.client(this@DropWatchService)?.cancelFall(id, by) } }
    }

    private fun showAlert(ev: FallEvent) {
        val open = PendingIntent.getActivity(this, 2, Intent(this, DropAlertActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK), PendingIntent.FLAG_IMMUTABLE)
        val imOk = PendingIntent.getBroadcast(this, 3, Intent(this, DropActionReceiver::class.java).setAction(ACTION_CANCEL), PendingIntent.FLAG_IMMUTABLE)
        val n = NotificationCompat.Builder(this, BiruniApp.CH_ALERT)
            .setSmallIcon(android.R.drawable.ic_dialog_alert)
            .setContentTitle("Phone dropped. SOS soon.")
            .setContentText("Tap I'm OK to cancel (about ${"%.1f".format(ev.heightM)} m, ${ev.impactG} g).")
            .setPriority(NotificationCompat.PRIORITY_MAX)
            .setCategory(NotificationCompat.CATEGORY_ALARM)
            .setOngoing(true)
            .setFullScreenIntent(open, true)
            .setContentIntent(open)
            .addAction(0, "I'm OK", imOk)
            .build()
        getSystemService(NotificationManager::class.java).notify(ALERT_NOTIF, n)
    }

    private fun alarm(on: Boolean) {
        val vib = getSystemService(Vibrator::class.java)
        if (on) {
            runCatching {
                ringtone = RingtoneManager.getRingtone(this, RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM))?.apply {
                    audioAttributes = AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_ALARM).setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build()
                    isLooping = true
                    play()
                }
            }
            vib?.vibrate(VibrationEffect.createWaveform(longArrayOf(0, 600, 400), 0))
        } else {
            runCatching { ringtone?.stop() }
            ringtone = null
            vib?.cancel()
        }
    }

    override fun onDestroy() {
        running = false
        runCatching { sm?.unregisterListener(this) }
        alarm(false)
        scope.cancel()
        super.onDestroy()
    }
}

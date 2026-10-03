package com.biruni.app.llm

import android.app.Notification
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import com.biruni.app.BiruniApp
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import java.io.File
import java.io.RandomAccessFile
import java.net.HttpURLConnection
import java.net.URL

data class DownloadState(val modelId: String, val done: Long, val total: Long, val error: String? = null, val finished: Boolean = false) {
    val fraction get() = if (total > 0) done.toFloat() / total else 0f
}

/**
 * Downloads a model in a foreground service so it survives the screen turning off.
 * Resumable: a partial ".part" file is continued with an HTTP Range request.
 */
class ModelDownloadService : Service() {
    companion object {
        private val _state = MutableStateFlow<DownloadState?>(null)
        val state: StateFlow<DownloadState?> = _state
        private const val NOTIF_ID = 41

        fun start(ctx: Context, modelId: String) {
            ctx.startForegroundService(Intent(ctx, ModelDownloadService::class.java).putExtra("id", modelId))
        }
        fun cancel(ctx: Context) {
            ctx.startService(Intent(ctx, ModelDownloadService::class.java).setAction("cancel"))
        }
    }

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var job: Job? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == "cancel") {
            job?.cancel()
            _state.value = _state.value?.copy(error = "Cancelled")
            stopSelf()
            return START_NOT_STICKY
        }
        val model = ModelCatalog.models.firstOrNull { it.id == intent?.getStringExtra("id") } ?: run { stopSelf(); return START_NOT_STICKY }
        ServiceCompat.startForeground(this, NOTIF_ID, notification(model.name, 0), ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        if (job?.isActive == true) return START_NOT_STICKY
        job = scope.launch {
            try {
                download(model) { isActive }
                _state.value = DownloadState(model.id, model.bytes, model.bytes, finished = true)
            } catch (e: Exception) {
                _state.value = (_state.value ?: DownloadState(model.id, 0, model.bytes)).copy(error = e.message ?: "Download failed")
            } finally {
                ServiceCompat.stopForeground(this@ModelDownloadService, ServiceCompat.STOP_FOREGROUND_REMOVE)
                stopSelf()
            }
        }
        return START_NOT_STICKY
    }

    private fun download(model: ModelInfo, alive: () -> Boolean) {
        val dir = File(filesDir, "models").apply { mkdirs() }
        val part = File(dir, model.fileName + ".part")
        val dest = File(dir, model.fileName)
        if (dest.exists() && dest.length() == model.bytes) return
        var have = if (part.exists()) part.length() else 0L
        val conn = (URL(model.url).openConnection() as HttpURLConnection).apply {
            instanceFollowRedirects = true
            connectTimeout = 20_000
            readTimeout = 60_000
            if (have > 0) setRequestProperty("Range", "bytes=$have-")
        }
        val code = conn.responseCode
        if (code == 200) have = 0 // server ignored Range: start over
        else if (code != 206) throw IllegalStateException("Server answered HTTP $code")
        val total = if (code == 206) have + conn.contentLengthLong else conn.contentLengthLong.takeIf { it > 0 } ?: model.bytes
        RandomAccessFile(part, "rw").use { out ->
            out.setLength(have)
            out.seek(have)
            conn.inputStream.use { input ->
                val buf = ByteArray(1 shl 16)
                var lastNotify = 0L
                while (alive()) {
                    val n = input.read(buf)
                    if (n < 0) break
                    out.write(buf, 0, n)
                    have += n
                    val now = System.currentTimeMillis()
                    if (now - lastNotify > 500) {
                        lastNotify = now
                        _state.value = DownloadState(model.id, have, total)
                        val pct = if (total > 0) (have * 100 / total).toInt() else 0
                        getSystemService(android.app.NotificationManager::class.java).notify(NOTIF_ID, notification(model.name, pct))
                    }
                }
            }
        }
        if (!alive()) throw IllegalStateException("Cancelled")
        if (have < total) throw IllegalStateException("Connection dropped at ${have * 100 / total}% — tap Download to resume")
        val head = part.inputStream().use { s -> ByteArray(4).also { s.read(it) } }
        if (String(head, Charsets.US_ASCII) != "GGUF") { part.delete(); throw IllegalStateException("Downloaded file is not a GGUF model") }
        if (!part.renameTo(dest)) throw IllegalStateException("Could not save the model")
    }

    private fun notification(name: String, pct: Int): Notification =
        NotificationCompat.Builder(this, BiruniApp.CH_DOWNLOAD)
            .setSmallIcon(android.R.drawable.stat_sys_download)
            .setContentTitle("Downloading $name")
            .setContentText("$pct%")
            .setProgress(100, pct, false)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .build()

    override fun onDestroy() {
        scope.cancel()
        super.onDestroy()
    }
}

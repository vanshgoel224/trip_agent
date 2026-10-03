package com.biruni.app

import android.app.Application
import android.app.NotificationChannel
import android.app.NotificationManager
import com.biruni.app.agent.LocalAgent
import com.biruni.app.agent.OfflineSync
import com.biruni.app.agent.TripDb
import com.biruni.app.agent.TripTools
import com.biruni.app.llm.LocalLlm
import com.biruni.app.net.BiruniClient
import com.biruni.app.safety.SafetyPrefs

/** Process-wide singletons (no DI framework: there are only a handful). */
class BiruniApp : Application() {
    companion object {
        const val CH_DOWNLOAD = "download"
        const val CH_WATCH = "watch"
        const val CH_ALERT = "alert"
        lateinit var instance: BiruniApp private set
    }

    val llm by lazy { LocalLlm(this) }
    val db by lazy { TripDb(this) }
    val tools by lazy { TripTools(db) }
    val agent by lazy { LocalAgent(llm, tools) }
    val sync by lazy { OfflineSync(db) }
    val safety by lazy { SafetyPrefs(this) }

    /** Signed-in server session, if the user linked a Biruni server. */
    @Volatile var client: BiruniClient? = null

    override fun onCreate() {
        super.onCreate()
        instance = this
        val nm = getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(NotificationChannel(CH_DOWNLOAD, "Model downloads", NotificationManager.IMPORTANCE_LOW))
        nm.createNotificationChannel(NotificationChannel(CH_WATCH, "Drop watch", NotificationManager.IMPORTANCE_LOW))
        nm.createNotificationChannel(NotificationChannel(CH_ALERT, "Drop alerts", NotificationManager.IMPORTANCE_HIGH).apply {
            description = "Shown when a drop is detected and an SOS is about to be sent"
            setBypassDnd(true)
            enableVibration(true)
        })
    }
}

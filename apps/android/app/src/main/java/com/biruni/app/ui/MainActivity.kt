package com.biruni.app.ui

import android.Manifest
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.OpenableColumns
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.viewModels
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Chat
import androidx.compose.material.icons.filled.EventNote
import androidx.compose.material.icons.filled.Memory
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.Shield
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import com.biruni.app.BiruniApp
import com.biruni.app.safety.DropWatchService

class MainActivity : ComponentActivity() {
    private val vm: AppViewModel by viewModels()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val app = application as BiruniApp
        if (app.safety.dropWatch && !DropWatchService.running) runCatching { DropWatchService.start(this) }

        setContent {
            val dark = isSystemInDarkTheme()
            val scheme = if (dark) darkColorScheme(primary = Color(0xFF7DD3FC)) else lightColorScheme(primary = Color(0xFF0369A1))
            MaterialTheme(colorScheme = scheme) {
                var tab by remember { mutableIntStateOf(0) }
                var legal by remember { mutableStateOf(!app.safety.legalAccepted) }
                val snack = remember { SnackbarHostState() }
                LaunchedEffect(vm.message) { vm.message?.let { snack.showSnackbar(it); vm.toast(null) } }

                val perms = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) {}
                val picker = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri: Uri? ->
                    if (uri != null) {
                        val name = contentResolver.query(uri, null, null, null, null)?.use { c -> if (c.moveToFirst()) c.getString(c.getColumnIndexOrThrow(OpenableColumns.DISPLAY_NAME)) else null } ?: "imported.gguf"
                        vm.import(uri, name)
                    }
                }

                if (legal) AlertDialog(
                    onDismissRequest = {},
                    title = { Text("Before you start") },
                    text = { Text("Biruni™ helps, but you decide and you are responsible for your travel, bookings, payments and safety. It is not an emergency service: in danger, call 112. The on-device AI can be wrong.\n\nAllow location, SMS (for SOS texts) and notifications so safety features can work.") },
                    confirmButton = {
                        TextButton({
                            app.safety.legalAccepted = true
                            legal = false
                            val p = mutableListOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION, Manifest.permission.SEND_SMS)
                            if (Build.VERSION.SDK_INT >= 33) p += Manifest.permission.POST_NOTIFICATIONS
                            perms.launch(p.toTypedArray())
                        }) { Text("I understand") }
                    },
                )

                Scaffold(
                    snackbarHost = { SnackbarHost(snack) },
                    bottomBar = {
                        NavigationBar {
                            listOf("Chat" to Icons.Filled.Chat, "Plan" to Icons.Filled.EventNote, "Safety" to Icons.Filled.Shield, "Model" to Icons.Filled.Memory, "More" to Icons.Filled.Settings)
                                .forEachIndexed { i, (label, icon) -> NavigationBarItem(tab == i, { tab = i }, { Icon(icon, label) }, label = { Text(label) }) }
                        }
                    },
                ) { pad ->
                    val m = Modifier.padding(pad)
                    androidx.compose.foundation.layout.Box(m) {
                        when (tab) {
                            0 -> ChatScreen(vm) { tab = 3 }
                            1 -> PlanScreen(vm)
                            2 -> SafetyScreen(vm)
                            3 -> ModelScreen(vm) { picker.launch(arrayOf("*/*")) }
                            else -> SettingsScreen(vm)
                        }
                    }
                }
            }
        }
    }
}

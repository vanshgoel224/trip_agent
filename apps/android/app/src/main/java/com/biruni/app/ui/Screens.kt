package com.biruni.app.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import com.biruni.app.BiruniApp
import com.biruni.app.llm.LlmState
import com.biruni.app.llm.ModelCatalog
import com.biruni.app.llm.ModelDownloadService

private fun fmtBytes(b: Long) = if (b >= 1 shl 30) "%.2f GB".format(b / (1L shl 30).toDouble()) else "${b shr 20} MB"

@Composable
fun ChatScreen(vm: AppViewModel, goModel: () -> Unit) {
    val st by vm.llmState.collectAsState()
    var input by remember { mutableStateOf("") }
    val list = rememberLazyListState()
    LaunchedEffect(vm.chat.size, vm.streaming) { if (vm.chat.isNotEmpty()) list.animateScrollToItem(vm.chat.size) }
    Column(Modifier.fillMaxSize()) {
        Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
            val label = if (vm.useServer) "Biruni server" else when (st) {
                is LlmState.Ready -> "On-device · ${(st as LlmState.Ready).file.removeSuffix(".gguf").take(28)}"
                is LlmState.Loading -> "Loading model…"
                is LlmState.Failed -> "Model error"
                LlmState.NoModel -> "No model yet"
            }
            Text(label, style = MaterialTheme.typography.labelLarge, modifier = Modifier.weight(1f))
            if (vm.serverUser != null) {
                Text("Server", style = MaterialTheme.typography.labelMedium)
                Switch(vm.useServer, { vm.useServer = it; vm.newChat() }, modifier = Modifier.padding(start = 6.dp))
            }
            TextButton({ vm.newChat() }) { Text("New") }
        }
        if (!vm.useServer && st is LlmState.NoModel && vm.installed().isEmpty()) {
            Card(Modifier.padding(12.dp)) {
                Column(Modifier.padding(16.dp)) {
                    Text("Download an on-device model to chat offline.", style = MaterialTheme.typography.titleMedium)
                    Text("About 1 GB once, then no internet is needed.", style = MaterialTheme.typography.bodyMedium, modifier = Modifier.padding(vertical = 6.dp))
                    Button(goModel) { Text("Choose a model") }
                }
            }
        }
        LazyColumn(Modifier.weight(1f).padding(horizontal = 12.dp), state = list, verticalArrangement = Arrangement.spacedBy(8.dp)) {
            if (vm.chat.isEmpty()) item {
                Text(
                    "Try: \"Plan day 1 in Rishikesh: rafting at 9, lunch at 1\", \"I spent 450 on a taxi\", or \"my bus got cancelled\".",
                    style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(vertical = 24.dp),
                )
            }
            items(vm.chat) { m -> Bubble(m) }
            if (vm.busy) item {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    CircularProgressIndicator(Modifier.padding(end = 10.dp), strokeWidth = 2.dp)
                    Text(vm.streaming.ifEmpty { "Thinking…" }, style = MaterialTheme.typography.bodyMedium)
                }
            }
        }
        Row(Modifier.fillMaxWidth().padding(8.dp), verticalAlignment = Alignment.CenterVertically) {
            OutlinedTextField(input, { input = it }, Modifier.weight(1f), placeholder = { Text("Message") }, maxLines = 4, shape = RoundedCornerShape(24.dp))
            IconButton({ vm.send(input); input = "" }, enabled = input.isNotBlank() && !vm.busy) { Icon(Icons.AutoMirrored.Filled.Send, "Send") }
        }
    }
}

@Composable
private fun Bubble(m: ChatLine) {
    val mine = m.role == "user"
    val bg = when (m.role) { "user" -> MaterialTheme.colorScheme.primary; "error" -> MaterialTheme.colorScheme.errorContainer; else -> MaterialTheme.colorScheme.surfaceVariant }
    val fg = when (m.role) { "user" -> MaterialTheme.colorScheme.onPrimary; "error" -> MaterialTheme.colorScheme.onErrorContainer; else -> MaterialTheme.colorScheme.onSurfaceVariant }
    Box(Modifier.fillMaxWidth(), contentAlignment = if (mine) Alignment.CenterEnd else Alignment.CenterStart) {
        Column(Modifier.widthIn(max = 320.dp).background(bg, RoundedCornerShape(16.dp)).padding(12.dp)) {
            m.notes.forEach { Text(it.take(120), style = MaterialTheme.typography.labelSmall, color = fg.copy(alpha = .7f)) }
            Text(m.text, color = fg)
        }
    }
}

@Composable
fun PlanScreen(vm: AppViewModel) {
    var city by remember { mutableStateOf("") }
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Text("Plan", style = MaterialTheme.typography.headlineSmall)
        Text(vm.budget.ifEmpty { "No budget yet" }, style = MaterialTheme.typography.bodyMedium)
        if (vm.plan.length() == 0) Text("Nothing planned. Ask the chat to add activities.", color = MaterialTheme.colorScheme.onSurfaceVariant)
        var lastDay = -1L
        for (i in 0 until vm.plan.length()) {
            val r = vm.plan.getJSONObject(i)
            if (r.getLong("day") != lastDay) { lastDay = r.getLong("day"); Text("Day $lastDay", style = MaterialTheme.typography.titleMedium, modifier = Modifier.padding(top = 8.dp)) }
            val cancelled = r.optString("status") == "cancelled"
            Text("${r.optString("time_slot", "").takeIf { it != "null" }.orEmpty().padEnd(8)} ${r.getString("activity")}${r.optString("location").takeIf { it.isNotBlank() && it != "null" }?.let { " · $it" } ?: ""}${if (cancelled) "  (cancelled)" else ""}")
        }
        HorizontalDivider(Modifier.padding(vertical = 8.dp))
        Text("Save a city for offline", style = MaterialTheme.typography.titleMedium)
        Text("While you have signal: saves nearby ATMs, hospitals, police, food, sights and a 7-day forecast so they work with no network.", style = MaterialTheme.typography.bodySmall)
        Row(verticalAlignment = Alignment.CenterVertically) {
            OutlinedTextField(city, { city = it }, Modifier.weight(1f), label = { Text("City") }, singleLine = true)
            Button({ vm.syncCity(city); city = "" }, enabled = city.isNotBlank(), modifier = Modifier.padding(start = 8.dp)) { Text("Save") }
        }
        val cities = vm.cachedCities()
        if (cities.isNotEmpty()) Text("Saved: ${cities.joinToString { it.replaceFirstChar(Char::uppercase) }}", style = MaterialTheme.typography.bodySmall)
    }
}

@Composable
fun SafetyScreen(vm: AppViewModel) {
    val app = BiruniApp.instance
    var numbers by remember { mutableStateOf(app.safety.emergencyNumbers.joinToString(", ")) }
    var sosMsg by remember { mutableStateOf("") }
    var window by remember { mutableStateOf(app.safety.cancelWindowSec.toString()) }
    var everyone by remember { mutableStateOf(app.safety.everyoneOnSos) }
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text("Safety", style = MaterialTheme.typography.headlineSmall)
        OutlinedTextField(sosMsg, { sosMsg = it }, Modifier.fillMaxWidth(), label = { Text("What's happening? (optional)") })
        Button({ vm.sos(sosMsg) }, Modifier.fillMaxWidth(), colors = ButtonDefaults.buttonColors(containerColor = Color(0xFFB91C1C))) { Text("SEND SOS", style = MaterialTheme.typography.titleLarge, modifier = Modifier.padding(8.dp)) }
        Text("Texts your emergency numbers your location and, if a Biruni server is linked, alerts your trip members and helpers. Biruni does not call the police or rescue: call 112 (ambulance 108).", style = MaterialTheme.typography.bodySmall)
        HorizontalDivider()
        OutlinedTextField(numbers, { numbers = it; app.safety.emergencyNumbers = it.split(',', ' ', ';').map(String::trim).filter { n -> n.length >= 6 } }, Modifier.fillMaxWidth(),
            label = { Text("Emergency numbers (comma separated)") }, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Phone), supportingText = { Text("Stored encrypted with a key in the Android Keystore.") })
        HorizontalDivider()
        Row(verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text("Drop & crash watch", style = MaterialTheme.typography.titleMedium)
                Text("Runs with the screen off. If the phone is dropped and you don't cancel, an SOS goes out.", style = MaterialTheme.typography.bodySmall)
            }
            Switch(vm.dropWatch, { vm.toggleDropWatch(it) })
        }
        OutlinedTextField(window, { window = it; it.toIntOrNull()?.let { s -> app.safety.cancelWindowSec = s } }, Modifier.fillMaxWidth(), label = { Text("Seconds to cancel (15–300)") }, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number), singleLine = true)
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("Also alert every opted-in Biruni helper on my server", Modifier.weight(1f), style = MaterialTheme.typography.bodyMedium)
            Switch(everyone, { everyone = it; app.safety.everyoneOnSos = it })
        }
        OutlinedButton({ com.biruni.app.safety.DropWatchService.test(app) }) { Text("Rehearse a drop alert") }
        Text("Cancel: tap I'M OK, shake the phone 3 times, press any key on the alert, or tap I'm OK on another device signed into your account. Thresholds were tuned on synthetic data, not real phones.", style = MaterialTheme.typography.bodySmall)
    }
}

@Composable
fun ModelScreen(vm: AppViewModel, pickFile: () -> Unit) {
    val st by vm.llmState.collectAsState()
    val dl by vm.download.collectAsState()
    val app = BiruniApp.instance
    var refresh by remember { mutableStateOf(0) }
    LaunchedEffect(dl?.finished, st) { refresh++ }
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Text("On-device model", style = MaterialTheme.typography.headlineSmall)
        Text("Runs fully on this phone through llama.cpp. No internet or account needed once downloaded. Speed is roughly 3–10 words per second on a mid-range CPU (a rough range; it depends on your chip).", style = MaterialTheme.typography.bodySmall)
        when (val s = st) {
            is LlmState.Ready -> Text("Loaded: ${s.file} (context ${s.nCtx})", color = Color(0xFF16A34A))
            is LlmState.Loading -> Text("Loading ${s.file}…")
            is LlmState.Failed -> Text(s.message, color = MaterialTheme.colorScheme.error)
            LlmState.NoModel -> {}
        }
        key(refresh) {
            vm.installed().forEach { f ->
                Card { Row(Modifier.padding(12.dp), verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) { Text(f.name, style = MaterialTheme.typography.titleSmall); Text(fmtBytes(f.length()), style = MaterialTheme.typography.bodySmall) }
                    if ((st as? LlmState.Ready)?.file != f.name) TextButton({ vm.loadModel(f.name) }) { Text("Use") }
                    TextButton({ vm.deleteModel(f.name); refresh++ }) { Text("Delete") }
                } }
            }
        }
        HorizontalDivider()
        Text("Download", style = MaterialTheme.typography.titleMedium)
        ModelCatalog.models.forEach { m ->
            val have = app.llm.installed().any { it.name == m.fileName }
            val active = dl?.takeIf { it.modelId == m.id && !it.finished && it.error == null }
            Card { Column(Modifier.padding(12.dp)) {
                Text(m.name, style = MaterialTheme.typography.titleSmall)
                Text("${fmtBytes(m.bytes)} · needs about ${m.minRamGb} GB RAM · ${m.note}", style = MaterialTheme.typography.bodySmall)
                if (active != null) {
                    LinearProgressIndicator(progress = { active.fraction }, Modifier.fillMaxWidth().padding(vertical = 8.dp))
                    Row { Text("${fmtBytes(active.done)} / ${fmtBytes(active.total)}", Modifier.weight(1f)); TextButton({ ModelDownloadService.cancel(app) }) { Text("Cancel") } }
                } else {
                    dl?.takeIf { it.modelId == m.id && it.error != null }?.let { Text(it.error!!, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
                    Button({ ModelDownloadService.start(app, m.id) }, enabled = !have, modifier = Modifier.padding(top = 6.dp)) { Text(if (have) "Downloaded" else "Download") }
                }
            } }
        }
        OutlinedButton(pickFile) { Text("Import a .gguf from storage") }
        Text("Any chat-capable GGUF with tool support in its template works; Qwen 2.5 is the tested family.", style = MaterialTheme.typography.bodySmall)
    }
}

@Composable
fun SettingsScreen(vm: AppViewModel) {
    val app = BiruniApp.instance
    var url by remember { mutableStateOf(app.safety.serverUrl) }
    var user by remember { mutableStateOf(app.safety.username) }
    var pin by remember { mutableStateOf("") }
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Text("Biruni server (optional)", style = MaterialTheme.typography.headlineSmall)
        Text("Link your own Biruni server for the full agent: recovery with ₹2,000 authority, booking, shared trips, SOS to other people. The app works without it.", style = MaterialTheme.typography.bodySmall)
        OutlinedTextField(url, { url = it }, Modifier.fillMaxWidth(), label = { Text("Server address (https://…)") }, singleLine = true)
        OutlinedTextField(user, { user = it }, Modifier.fillMaxWidth(), label = { Text("Username") }, singleLine = true)
        OutlinedTextField(pin, { pin = it }, Modifier.fillMaxWidth(), label = { Text("PIN") }, singleLine = true, visualTransformation = PasswordVisualTransformation(), keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.NumberPassword))
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Button({ vm.signIn(url, user, pin, false) }, enabled = url.isNotBlank() && user.isNotBlank() && pin.isNotBlank()) { Text("Sign in") }
            OutlinedButton({ vm.signIn(url, user, pin, true) }, enabled = url.isNotBlank() && user.isNotBlank() && pin.isNotBlank()) { Text("Create account") }
            if (vm.serverUser != null) TextButton({ vm.signOut() }) { Text("Sign out") }
        }
        Text("Your PIN is kept on this phone, encrypted with an Android Keystore key, only so the drop watch can reach your server when you can't unlock the app. Sign out removes it.", style = MaterialTheme.typography.bodySmall)
        HorizontalDivider(Modifier.padding(vertical = 6.dp))
        Text("About", style = MaterialTheme.typography.titleMedium)
        Text("Biruni™ helps; you decide and you are responsible for your travel, bookings, payments and safety. It is not an emergency service and does not replace 112. The on-device model can be wrong: check anything that matters.", style = MaterialTheme.typography.bodySmall)
        Text("Model, map and weather data: llama.cpp (MIT), Qwen (Apache-2.0, see each model card), © OpenStreetMap contributors (ODbL), Open-Meteo.", style = MaterialTheme.typography.bodySmall)
    }
}

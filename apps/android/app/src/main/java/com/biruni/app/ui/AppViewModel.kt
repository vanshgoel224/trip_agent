package com.biruni.app.ui

import android.app.Application
import android.net.Uri
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.biruni.app.BiruniApp
import com.biruni.app.llm.LlmState
import com.biruni.app.llm.ModelDownloadService
import com.biruni.app.net.BiruniClient
import com.biruni.app.safety.DropWatchService
import com.biruni.app.safety.SosSender
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONArray

data class ChatLine(val role: String, val text: String, val notes: List<String> = emptyList())

class AppViewModel(private val app: Application) : AndroidViewModel(app) {
    private val a get() = app as BiruniApp
    val llmState: StateFlow<LlmState> get() = a.llm.state
    val download get() = ModelDownloadService.state

    val chat = mutableStateListOf<ChatLine>()
    var busy by mutableStateOf(false)
    var streaming by mutableStateOf("")
    var useServer by mutableStateOf(false)
    var message by mutableStateOf<String?>(null)
    var plan by mutableStateOf(JSONArray())
    var budget by mutableStateOf("")
    var serverUser by mutableStateOf<String?>(null)
    var dropWatch by mutableStateOf(a.safety.dropWatch)
    private var serverChatId: String? = null

    init { refreshPlan() }

    fun toast(m: String?) { message = m }

    // ---- chat ----
    fun send(text: String) {
        val t = text.trim()
        if (t.isEmpty() || busy) return
        chat.add(ChatLine("user", t))
        busy = true
        streaming = ""
        viewModelScope.launch {
            val notes = mutableListOf<String>()
            try {
                val reply = if (useServer && a.client != null) serverAsk(t) else a.agent.ask(t) { e ->
                    when (e.kind) {
                        "token" -> streaming += e.text
                        "tool" -> { notes += "🔧 ${e.text}"; streaming = "" }
                    }
                }
                chat.add(ChatLine("assistant", reply, notes))
                refreshPlan()
            } catch (e: Exception) {
                chat.add(ChatLine("error", e.message ?: "Something went wrong"))
            } finally {
                busy = false
                streaming = ""
            }
        }
    }

    fun newChat() { a.agent.reset(); chat.clear(); serverChatId = null }

    private suspend fun serverAsk(text: String): String = withContext(Dispatchers.IO) {
        val c = a.client ?: throw IllegalStateException("Not signed in to a Biruni server")
        val id = serverChatId ?: c.newChat("general").optString("chatId").also { serverChatId = it }
        c.send(id, text).optJSONObject("message")?.optString("text") ?: "(no reply)"
    }

    fun refreshPlan() = viewModelScope.launch {
        val (p, b) = withContext(Dispatchers.IO) { a.db.query("SELECT * FROM itinerary ORDER BY day, time_slot") to a.tools.budgetSummary() }
        plan = p
        budget = "Budget ₹${b.optDouble("total_budgeted").toLong()} · spent ₹${b.optDouble("total_spent").toLong()} · left ₹${b.optDouble("remaining").toLong()}"
    }

    // ---- model ----
    fun installed() = a.llm.installed()
    fun selectedModel() = a.llm.selected
    fun loadModel(name: String) = viewModelScope.launch { if (!a.llm.load(name)) toast((a.llm.state.value as? LlmState.Failed)?.message) }
    fun deleteModel(name: String) = viewModelScope.launch { a.llm.delete(name); toast("Deleted") }
    fun import(uri: Uri, name: String) = viewModelScope.launch {
        try { val f = a.llm.import(uri, name); toast("Imported ${f.name}") } catch (e: Exception) { toast(e.message) }
    }
    fun systemInfo(): String = try { kotlinx.coroutines.runBlocking { a.llm.systemInfo() } } catch (e: Throwable) { e.message ?: "unavailable" }

    // ---- offline cache ----
    fun syncCity(city: String) = viewModelScope.launch {
        toast("Saving $city…")
        try { val r = a.sync.syncCity(city); toast("Saved ${r.city}: ${r.places} places, ${r.weatherDays}-day forecast") } catch (e: Exception) { toast("Sync failed: ${e.message}") }
    }
    fun cachedCities() = a.db.cachedPlaces("pois")

    // ---- safety ----
    fun toggleDropWatch(on: Boolean) {
        a.safety.dropWatch = on
        dropWatch = on
        if (on) DropWatchService.start(app) else DropWatchService.stop(app)
    }

    fun sos(message: String) = viewModelScope.launch {
        toast("Sending SOS…")
        val out = withContext(Dispatchers.IO) { SosSender.send(app, message.ifBlank { "I need help." }) }
        toast(
            buildList {
                if (out.server) add("Sent via Biruni")
                if (out.smsSent > 0) add("SMS to ${out.smsSent}")
            }.ifEmpty { listOf("Not sent: save emergency numbers or link a server. Call 112.") }.joinToString(" · "),
        )
    }

    // ---- server link ----
    fun signIn(url: String, user: String, pin: String, create: Boolean) = viewModelScope.launch {
        try {
            withContext(Dispatchers.IO) {
                val c = BiruniClient(url)
                if (create) c.signUp(user, pin) else c.signIn(user, pin)
                a.client = c
                a.safety.serverUrl = c.base
                a.safety.username = user
                a.safety.pin = pin
            }
            serverUser = user
            toast("Signed in as $user")
        } catch (e: Exception) { toast(e.message ?: "Could not connect") }
    }

    fun signOut() = viewModelScope.launch {
        withContext(Dispatchers.IO) { a.client?.signOut() }
        a.client = null
        a.safety.pin = null
        serverUser = null
        useServer = false
        toast("Signed out; PIN removed from this phone")
    }
}

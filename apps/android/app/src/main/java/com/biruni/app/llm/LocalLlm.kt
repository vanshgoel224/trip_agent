package com.biruni.app.llm

import android.content.Context
import android.content.SharedPreferences
import android.net.Uri
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import java.io.File

sealed interface LlmState {
    data object NoModel : LlmState
    data class Loading(val file: String) : LlmState
    data class Ready(val file: String, val nCtx: Int) : LlmState
    data class Failed(val message: String) : LlmState
}

class LlmException(message: String) : Exception(message)

/** Owns the one loaded model. Every native call goes through [lock]. */
class LocalLlm(private val app: Context) {
    private val lock = Mutex()
    private val prefs: SharedPreferences = app.getSharedPreferences("llm", Context.MODE_PRIVATE)
    private val _state = MutableStateFlow<LlmState>(LlmState.NoModel)
    val state: StateFlow<LlmState> = _state
    private var nativeReady = false

    val modelDir: File get() = File(app.filesDir, "models").apply { mkdirs() }
    fun installed(): List<File> = modelDir.listFiles { f -> f.name.endsWith(".gguf") }?.sortedBy { it.name } ?: emptyList()
    var selected: String?
        get() = prefs.getString("selected", null)
        set(v) = prefs.edit().putString("selected", v).apply()
    var contextSize: Int
        get() = prefs.getInt("nCtx", 4096)
        set(v) = prefs.edit().putInt("nCtx", v).apply()

    private fun ensureNative() {
        if (!nativeReady) {
            LlamaNative.init(app.applicationInfo.nativeLibraryDir)
            nativeReady = true
        }
    }

    suspend fun systemInfo(): String = lock.withLock { withContext(Dispatchers.Default) { ensureNative(); LlamaNative.systemInfo() } }

    /** Loads the selected model if it isn't loaded already. */
    suspend fun ensureLoaded(): Boolean {
        val cur = _state.value
        val want = selected ?: installed().firstOrNull()?.name ?: run { _state.value = LlmState.NoModel; return false }
        if (cur is LlmState.Ready && cur.file == want) return true
        return load(want)
    }

    suspend fun load(fileName: String): Boolean = lock.withLock {
        withContext(Dispatchers.Default) {
            val f = File(modelDir, fileName)
            if (!f.exists()) { _state.value = LlmState.Failed("$fileName is not on this phone"); return@withContext false }
            _state.value = LlmState.Loading(fileName)
            ensureNative()
            val err = LlamaNative.load(f.absolutePath, contextSize, 0)
            if (err.isNotEmpty()) { _state.value = LlmState.Failed(err); return@withContext false }
            selected = fileName
            _state.value = LlmState.Ready(fileName, LlamaNative.contextSize())
            true
        }
    }

    suspend fun unload() = lock.withLock {
        withContext(Dispatchers.Default) { if (nativeReady) LlamaNative.unload() }
        _state.value = LlmState.NoModel
    }

    suspend fun delete(fileName: String) {
        if ((_state.value as? LlmState.Ready)?.file == fileName) unload()
        File(modelDir, fileName).delete()
        if (selected == fileName) selected = null
    }

    /** Copies a GGUF picked with the system file picker into app storage. */
    suspend fun import(uri: Uri, name: String): File = withContext(Dispatchers.IO) {
        val safe = name.replace(Regex("[^A-Za-z0-9._-]"), "_").let { if (it.endsWith(".gguf")) it else "$it.gguf" }
        val out = File(modelDir, safe)
        app.contentResolver.openInputStream(uri)?.use { input ->
            val head = ByteArray(4)
            input.mark(4)
            out.outputStream().use { o ->
                val n = input.read(head)
                if (n < 4 || String(head, Charsets.US_ASCII) != "GGUF") throw LlmException("Not a GGUF model file")
                o.write(head, 0, n)
                input.copyTo(o, 1 shl 20)
            }
        } ?: throw LlmException("Could not open the file")
        out
    }

    /** Formats messages + tools with the model's own chat template. */
    suspend fun prompt(messagesJson: String, toolsJson: String): String = lock.withLock {
        withContext(Dispatchers.Default) {
            val p = LlamaNative.applyTemplate(messagesJson, toolsJson)
            if (p.startsWith(LlamaNative.ERR)) throw LlmException("chat template: ${p.drop(1)}")
            p
        }
    }

    /** Generates a completion; throws LlmException("too_long") if the prompt doesn't fit. */
    suspend fun generate(prompt: String, maxTokens: Int, onPiece: (String) -> Boolean): String = lock.withLock {
        withContext(Dispatchers.Default) {
            val out = LlamaNative.generate(prompt, maxTokens) { onPiece(it) }
            if (out.startsWith(LlamaNative.ERR)) throw LlmException(out.drop(1))
            out
        }
    }

    /** Parses raw output into an OpenAI-style assistant message JSON (null if the parser failed). */
    suspend fun parse(raw: String): String? = lock.withLock {
        withContext(Dispatchers.Default) { LlamaNative.parse(raw).takeUnless { it.startsWith(LlamaNative.ERR) } }
    }
}

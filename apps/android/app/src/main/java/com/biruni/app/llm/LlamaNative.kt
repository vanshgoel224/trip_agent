package com.biruni.app.llm

/** Callback for streamed text pieces. Return false to stop generating. */
fun interface TokenCallback {
    fun onToken(piece: String): Boolean
}

/**
 * Thin JNI surface over llama.cpp (src/main/cpp/biruni_llama.cpp). Strings starting with
 * U+0001 are errors. Not thread-safe: LocalLlm serialises every call.
 */
object LlamaNative {
    const val ERR = '\u0001'

    init {
        System.loadLibrary("biruni_llama")
    }

    external fun init(nativeLibDir: String)
    external fun systemInfo(): String
    /** "" on success, otherwise a readable error. */
    external fun load(path: String, nCtx: Int, nThreads: Int): String
    external fun contextSize(): Int
    external fun applyTemplate(messagesJson: String, toolsJson: String): String
    external fun generate(prompt: String, maxTokens: Int, callback: TokenCallback): String
    external fun parse(raw: String): String
    external fun unload()
}

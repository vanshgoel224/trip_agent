package com.biruni.app.llm

/**
 * Models offered for one-tap download. URLs and sizes were checked against Hugging Face
 * (official Qwen GGUF repos, Q4_K_M) when this was written; any other GGUF can be imported
 * from the phone's storage instead.
 */
data class ModelInfo(
    val id: String,
    val name: String,
    val url: String,
    val bytes: Long,
    val minRamGb: Int,
    val note: String,
) {
    val fileName get() = url.substringAfterLast('/')
}

object ModelCatalog {
    val models = listOf(
        ModelInfo(
            id = "qwen2.5-1.5b",
            name = "Qwen 2.5 1.5B Instruct (recommended)",
            url = "https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct-GGUF/resolve/main/qwen2.5-1.5b-instruct-q4_k_m.gguf",
            bytes = 1_117_320_736,
            minRamGb = 4,
            note = "Best balance of speed and tool-calling on most phones.",
        ),
        ModelInfo(
            id = "qwen2.5-3b",
            name = "Qwen 2.5 3B Instruct",
            url = "https://huggingface.co/Qwen/Qwen2.5-3B-Instruct-GGUF/resolve/main/qwen2.5-3b-instruct-q4_k_m.gguf",
            bytes = 2_104_932_768,
            minRamGb = 8,
            note = "Better answers, roughly half the speed. 8 GB RAM phones.",
        ),
        ModelInfo(
            id = "qwen2.5-0.5b",
            name = "Qwen 2.5 0.5B Instruct (tiny)",
            url = "https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct-GGUF/resolve/main/qwen2.5-0.5b-instruct-q4_k_m.gguf",
            bytes = 491_400_032,
            minRamGb = 3,
            note = "Fast on old phones; tool calls are often wrong.",
        ),
    )

    fun byFile(name: String) = models.firstOrNull { it.fileName == name }
}

package com.biruni.app.agent

import com.biruni.app.llm.LlmException
import com.biruni.app.llm.LocalLlm
import org.json.JSONArray
import org.json.JSONObject

data class AgentEvent(val kind: String, val text: String)

/**
 * On-phone agent loop (port of agent.py's run_turn): the model may call tools, we run them and feed
 * results back, until it answers. Safety words are handled before the model is asked.
 */
class LocalAgent(private val llm: LocalLlm, private val tools: TripTools) {
    companion object {
        const val SYSTEM = """You are Biruni, a trip assistant running offline on the user's phone. You manage itinerary, budget, contacts and re-planning with local tools only. You have no live internet data.
Rules:
- Cached data (places, weather, transit) may be stale. Call get_cache_freshness and tell the user its age before relying on it.
- If a plan breaks, use get_itinerary and the cached lookups to build the best alternative, update the itinerary, and log it with generate_contingency. Be decisive but say it is based on cached info.
- Never claim live prices, availability or train/bus status. Say you can't know.
- Never add a discovered place without the user's explicit yes.
- Money: you never pay or book anything. You only keep notes.
- Keep answers short: this is a phone screen. Reply in the user's language."""
        private const val MAX_STEPS = 6
        private const val MAX_TOKENS = 512
    }

    private val history = JSONArray().put(JSONObject().put("role", "system").put("content", SYSTEM))

    fun reset() {
        while (history.length() > 1) history.remove(history.length() - 1)
    }

    /** Runs one user turn. [onEvent] gets "token", "tool" and "tool_result" updates for the UI. */
    suspend fun ask(userText: String, onEvent: (AgentEvent) -> Unit): String {
        if (Guards.isSafety(userText)) {
            history.put(JSONObject().put("role", "user").put("content", userText))
            history.put(JSONObject().put("role", "assistant").put("content", Guards.SAFETY_REPLY))
            return Guards.SAFETY_REPLY
        }
        if (!llm.ensureLoaded()) throw LlmException("No on-device model loaded. Open the Model tab and download one.")
        val mark = history.length()
        history.put(JSONObject().put("role", "user").put("content", userText))
        try {
            repeat(MAX_STEPS) {
                var raw = generateWithTrim(onEvent)
                var msg = llm.parse(raw)?.let { runCatching { JSONObject(it) }.getOrNull() }
                // Small models sometimes emit malformed tool JSON. Retry once; never show raw tool markup.
                if (msg == null && raw.contains("<tool_call>")) {
                    onEvent(AgentEvent("token", ""))
                    raw = generateWithTrim(onEvent)
                    msg = llm.parse(raw)?.let { runCatching { JSONObject(it) }.getOrNull() }
                    if (msg == null) msg = JSONObject().put("role", "assistant").put("content", "I couldn't work out that action. Please rephrase it more simply.")
                }
                msg = msg ?: JSONObject().put("role", "assistant").put("content", raw)
                val calls = msg.optJSONArray("tool_calls")
                if (calls == null || calls.length() == 0) {
                    val text = msg.optString("content").trim().ifEmpty { "(no answer)" }
                    history.put(JSONObject().put("role", "assistant").put("content", text))
                    return text
                }
                history.put(msg)
                for (i in 0 until calls.length()) {
                    val c = calls.getJSONObject(i)
                    val f = c.optJSONObject("function") ?: c
                    val name = f.optString("name")
                    val args = when (val a = f.opt("arguments")) {
                        is JSONObject -> a
                        is String -> runCatching { JSONObject(a) }.getOrDefault(JSONObject())
                        else -> JSONObject()
                    }
                    onEvent(AgentEvent("tool", "$name ${args}"))
                    val result = tools.execute(name, args, userText)
                    onEvent(AgentEvent("tool_result", result.toString().take(200)))
                    history.put(JSONObject().put("role", "tool").put("tool_call_id", c.optString("id")).put("name", name).put("content", result.toString()))
                }
            }
            val fallback = "I couldn't finish that in a few steps. Try asking it in smaller pieces."
            history.put(JSONObject().put("role", "assistant").put("content", fallback))
            return fallback
        } catch (e: Exception) {
            // Don't leave a half-finished turn in the history.
            while (history.length() > mark) history.remove(history.length() - 1)
            throw e
        }
    }

    /** Generates; if the prompt is too long, drops the oldest exchange and retries. */
    private suspend fun generateWithTrim(onEvent: (AgentEvent) -> Unit): String {
        while (true) {
            val prompt = llm.prompt(history.toString(), tools.schema.toString())
            try {
                return llm.generate(prompt, MAX_TOKENS) { onEvent(AgentEvent("token", it)); true }
            } catch (e: LlmException) {
                if (e.message != "too_long" || !dropOldestTurn()) throw if (e.message == "too_long") LlmException("This chat got too long for the model. Start a new chat.") else e
            }
        }
    }

    private fun dropOldestTurn(): Boolean {
        var start = -1
        for (i in 1 until history.length()) if (history.getJSONObject(i).optString("role") == "user") { start = i; break }
        if (start < 0) return false
        var end = history.length()
        for (i in start + 1 until history.length()) if (history.getJSONObject(i).optString("role") == "user") { end = i; break }
        if (end >= history.length()) return false // only the current turn is left
        repeat(end - start) { history.remove(start) }
        return true
    }
}

package com.biruni.app.agent

/**
 * Deterministic guards, ported from the server (packages/policy, services/orchestrator/chat-agent.ts)
 * so the phone behaves the same offline. These run before / around the model and can't be talked out of.
 */
object Guards {
    private val SAFETY_WORDS = listOf(
        "accident", "injur", "hurt", "bleed", "assault", "harass", "attack", "unsafe", "threat",
        "robbed", "stolen phone", "followed", "following me", "stalking", "stalker", "medical", "hospital", "emergency", "police", "sos",
        "scared", "afraid", "in danger", "not safe", "molest", "kidnap", "drunk", "rash driv", "overspeeding", "chest pain", "can't breathe", "unconscious", "fainted",
    )

    // Hindi / Hinglish: exact words only ("hoon" is one letter from "khoon").
    private val SAFETY_EXACT = Regex(
        "(^|[^\\p{L}])(peecha|pichha|picha kar|darr? lag|bachao|bachaao|madad karo|chot lagi|khoon nikal|khoon beh|chhed|ched raha|chhed raha|maar raha|maar diya|loot liya|loot gaya|पीछा|डर लग|बचाओ|मदद करो|चोट लगी|खून)([^\\p{L}]|$)",
        RegexOption.IGNORE_CASE,
    )

    private val APPROVAL = Regex("\\b(yes|yeah|yep|haan|ha|han|ji|approve|approved|go ahead|add it|do it|ok|okay|theek|thik|kar do|karo|confirm|sure)\\b", RegexOption.IGNORE_CASE)
    private val NEGATION = Regex("\\b(not yet|don'?t|do not|dont|wait|hold on|hold off|no|nope|nahi|nahin|mat|abhi nahi|ruko|later|cancel that)\\b", RegexOption.IGNORE_CASE)

    fun isSafety(text: String): Boolean {
        val t = text.lowercase()
        if (SAFETY_WORDS.any { t.contains(it) }) return true
        if (SAFETY_EXACT.containsMatchIn(text)) return true
        // Typo tolerance for the longer English words ("acident", "harrased").
        val words = t.split(Regex("[^\\p{L}']+")).filter { it.length >= 5 }
        // Whole word or same-length prefix ("injurd" → "injur") within one edit.
        return SAFETY_WORDS.filter { it.length >= 5 && !it.contains(' ') }.any { w ->
            words.any { editDistance(it, w) <= 1 || (w.length >= 6 && it.length > w.length && editDistance(it.take(w.length), w) <= 1) }
        }
    }

    /** True only for an explicit, unhedged yes ("yes but wait" and "abhi nahi" are not). */
    fun explicitYes(text: String) = APPROVAL.containsMatchIn(text) && !NEGATION.containsMatchIn(text)

    const val SAFETY_REPLY =
        "This sounds like a safety issue, so I'm not planning anything right now.\n" +
            "• If you are in danger or hurt: call 112 now (ambulance 108).\n" +
            "• Tap SOS on the Safety tab to text your emergency contacts your location.\n" +
            "• Move to a lit, public place if you can.\n" +
            "Tell me when you're safe and I'll help re-plan."

    /** Damerau-Levenshtein (optimal string alignment) distance. */
    fun editDistance(a: String, b: String): Int {
        val d = Array(a.length + 1) { IntArray(b.length + 1) }
        for (i in 0..a.length) d[i][0] = i
        for (j in 0..b.length) d[0][j] = j
        for (i in 1..a.length) for (j in 1..b.length) {
            val cost = if (a[i - 1] == b[j - 1]) 0 else 1
            d[i][j] = minOf(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost)
            if (i > 1 && j > 1 && a[i - 1] == b[j - 2] && a[i - 2] == b[j - 1]) d[i][j] = minOf(d[i][j], d[i - 2][j - 2] + 1)
        }
        return d[a.length][b.length]
    }
}

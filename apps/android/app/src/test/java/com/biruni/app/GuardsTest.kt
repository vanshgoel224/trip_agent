package com.biruni.app

import com.biruni.app.agent.Guards
import com.biruni.app.net.BiruniClient
import org.junit.Assert.*
import org.junit.Test

class GuardsTest {
    @Test fun englishSafetyIncludingTypos() {
        for (s in listOf("there was an accident", "ACIDENT on the highway", "someone is following me", "I feel unsafe", "chest pain"))
            assertTrue(s, Guards.isSafety(s))
    }

    @Test fun hindiSafety() {
        for (s in listOf("koi mera peecha kar raha hai", "bachao", "मुझे डर लग रहा है", "chot lagi hai"))
            assertTrue(s, Guards.isSafety(s))
    }

    @Test fun normalMessagesAreNotSafety() {
        for (s in listOf("I am fine, I am home", "main theek hoon", "book a taxi to the station", "plan day 2 in Goa", "the bus is delayed"))
            assertFalse(s, Guards.isSafety(s))
    }

    @Test fun explicitYesNeedsNoHedging() {
        assertTrue(Guards.explicitYes("yes"))
        assertTrue(Guards.explicitYes("haan kar do"))
        assertFalse(Guards.explicitYes("yes but wait"))
        assertFalse(Guards.explicitYes("abhi nahi"))
        assertFalse(Guards.explicitYes("add it? not yet"))
        assertFalse(Guards.explicitYes("what is the weather"))
    }

    @Test fun serverUrlRules() {
        assertEquals("https://biruni.example.com", BiruniClient.normalise("biruni.example.com/"))
        assertEquals("http://192.168.1.20:8787", BiruniClient.normalise("http://192.168.1.20:8787"))
        assertEquals("http://100.101.102.103:8787", BiruniClient.normalise("http://100.101.102.103:8787"))
        assertEquals("http://localhost:8787", BiruniClient.normalise("http://localhost:8787"))
        assertThrows(IllegalArgumentException::class.java) { BiruniClient.normalise("http://evil.example.com") }
        assertThrows(IllegalArgumentException::class.java) { BiruniClient.normalise("ftp://x.example.com") }
        assertThrows(IllegalArgumentException::class.java) { BiruniClient.normalise("  ") }
    }
}

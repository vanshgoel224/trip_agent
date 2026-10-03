package com.biruni.app

import com.biruni.app.safety.FallDetector
import com.biruni.app.safety.FallEvent
import com.biruni.app.safety.ShakeCounter
import org.junit.Assert.*
import org.junit.Test

class FallDetectorTest {
    private val g = 9.81

    /** Feeds: 1 g rest, free fall for [ffMs], then an impact of [impact] g. 200 Hz samples. */
    private fun drop(d: FallDetector, ffMs: Long, impact: Double, start: Long = 1000): Long {
        var t = start
        repeat(100) { d.push(t, 0.0, 0.0, g); t += 5 }
        val end = t + ffMs
        while (t < end) { d.push(t, 0.0, 0.0, 0.1 * g); t += 5 }
        d.push(t, 0.0, 0.0, impact * g); t += 5
        repeat(40) { d.push(t, 0.0, 0.0, g); t += 5 }
        return t
    }

    @Test fun oneMetreDropIsDetectedWithRightHeight() {
        val got = mutableListOf<FallEvent>()
        drop(FallDetector({ got += it }), ffMs = 450, impact = 6.0)
        assertEquals(1, got.size)
        assertEquals(1.0, got[0].heightM, 0.1) // ½·9.81·0.45² ≈ 0.99 m
        assertEquals("high", got[0].severity)
    }

    @Test fun twoCentimetreSlipIsIgnored() {
        val got = mutableListOf<FallEvent>()
        drop(FallDetector({ got += it }), ffMs = 60, impact = 3.0)
        assertTrue(got.isEmpty())
    }

    @Test fun walkingAndTapsAreIgnored() {
        val got = mutableListOf<FallEvent>()
        val d = FallDetector({ got += it })
        var t = 0L
        repeat(2000) { i -> d.push(t, 0.0, 0.0, g * (1.0 + 0.4 * Math.sin(i / 8.0))); t += 5 }
        d.push(t, 0.0, 0.0, 4.0 * g) // a hard tap with no free fall before it
        assertTrue(got.isEmpty())
    }

    @Test fun freeFallWithoutImpactIsIgnored() {
        val got = mutableListOf<FallEvent>()
        val d = FallDetector({ got += it })
        var t = 0L
        repeat(100) { d.push(t, 0.0, 0.0, 0.1 * g); t += 5 }
        repeat(400) { d.push(t, 0.0, 0.0, g); t += 5 } // lands softly
        assertTrue(got.isEmpty())
    }

    @Test fun bounceIsNotASecondFall() {
        val got = mutableListOf<FallEvent>()
        val d = FallDetector({ got += it })
        val t = drop(d, 450, 6.0)
        drop(d, 120, 3.0, start = t) // bounce within cooldown
        assertEquals(1, got.size)
    }

    @Test fun threeShakesCancelButTwoDoNot() {
        var n = 0
        val s = ShakeCounter({ n++ })
        s.push(0, 0.0, 0.0, 3 * g); s.push(400, 0.0, 0.0, 3 * g)
        assertEquals(0, n)
        s.push(800, 0.0, 0.0, 3 * g)
        assertEquals(1, n)
    }

    @Test fun slowShakesOutsideWindowDoNotCancel() {
        var n = 0
        val s = ShakeCounter({ n++ })
        s.push(0, 0.0, 0.0, 3 * g); s.push(3000, 0.0, 0.0, 3 * g); s.push(6000, 0.0, 0.0, 3 * g)
        assertEquals(0, n)
    }
}

package com.biruni.app.safety

import kotlin.math.sqrt

data class OrientationSnap(val pitch: Int, val roll: Int)

data class FallEvent(
    val freefallMs: Long, val heightM: Double, val impactG: Double, val tumbleDeg: Int,
    val before: OrientationSnap?, val after: OrientationSnap?, val severity: String,
)

/**
 * Kotlin port of apps/web/modules/falldetect.js (same thresholds): free fall (|a| near 0 g), then
 * an impact spike. height = ½·g·t². Pure logic, unit-tested with synthetic samples. Thresholds are
 * tuned on synthetic data, not real phones.
 */
class FallDetector(
    private val onFall: (FallEvent) -> Unit,
    private val freefallG: Double = 0.35,
    private val minFreefallMs: Long = 80,
    private val impactG: Double = 2.2,
    private val impactWindowMs: Long = 1200,
    private val minHeightM: Double = 0.25,
    private val cooldownMs: Long = 5000,
) {
    companion object { const val G = 9.81 }

    private var ffStart = -1L
    private var ffEnd = -1L
    private var tumble = 0.0
    private var lastT = -1L
    private var before: OrientationSnap? = null
    private var cooldownUntil = 0L
    var orientation: OrientationSnap? = null

    private fun reset() { ffStart = -1; ffEnd = -1; tumble = 0.0; before = null }

    /** t in ms; ax,ay,az in m/s² (including gravity); gyro in deg/s (optional). */
    fun push(t: Long, ax: Double, ay: Double, az: Double, gyroDegPerSec: Double = 0.0) {
        val g = sqrt(ax * ax + ay * ay + az * az) / G
        val dt = if (lastT < 0) 0.0 else (t - lastT).coerceIn(0, 100) / 1000.0
        lastT = t
        if (t < cooldownUntil) return
        if (g < freefallG) {
            if (ffStart < 0) { ffStart = t; before = orientation; tumble = 0.0 }
            ffEnd = t
            tumble += gyroDegPerSec * dt
            return
        }
        if (ffStart < 0) return
        val ffMs = ffEnd - ffStart
        if (t - ffEnd > impactWindowMs || (ffMs < minFreefallMs && g < impactG)) {
            if (t - ffEnd > impactWindowMs || ffMs < minFreefallMs) reset()
            return
        }
        if (g >= impactG && ffMs >= minFreefallMs) {
            val s = ffMs / 1000.0
            val h = 0.5 * G * s * s
            if (h < minHeightM) { reset(); return }
            val ev = FallEvent(ffMs, Math.round(h * 100) / 100.0, Math.round(g * 10) / 10.0, Math.round(tumble).toInt(), before, orientation, severity(h, g))
            cooldownUntil = t + cooldownMs
            reset()
            onFall(ev)
        }
    }

    fun severity(heightM: Double, g: Double) = when {
        heightM >= 1.5 || g >= 6 -> "high"
        heightM >= 0.8 || g >= 3.5 -> "medium"
        else -> "low"
    }
}

/** Cancel gesture for a broken screen: [need] strong shakes within [withinMs]. */
class ShakeCounter(private val onShakes: () -> Unit, private val need: Int = 3, private val withinMs: Long = 4000, private val minG: Double = 2.0) {
    private val hits = ArrayDeque<Long>()
    private var last = Long.MIN_VALUE / 2

    fun push(t: Long, ax: Double, ay: Double, az: Double) {
        val g = sqrt(ax * ax + ay * ay + az * az) / FallDetector.G
        if (g < minG || t - last < 250) return
        last = t
        while (hits.isNotEmpty() && t - hits.first() >= withinMs) hits.removeFirst()
        hits.addLast(t)
        if (hits.size >= need) { hits.clear(); onShakes() }
    }
}

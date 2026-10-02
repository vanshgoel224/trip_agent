// Drop detector: pure logic (no DOM), so it can be unit-tested with synthetic samples.
// A drop looks like: free fall (|a| ≈ 0 g, since the accelerometer reads ~0 while
// falling), then an impact spike. From that we estimate the fall:
//   height ≈ ½·g·t²  (t = free-fall time)    tumble = ∫|rotation rate| dt during the fall
// and record the phone's angle before and after.
const G = 9.81;

export const DEFAULTS = {
  freefallG: 0.35, // below this |a| counts as free fall
  minFreefallMs: 80, // ≈ 3 cm; shorter = just a jiggle
  impactG: 2.2, // spike that ends the fall
  impactWindowMs: 1200, // impact must follow free fall within this
  minHeightM: 0.25, // ignore tiny drops (phone slipping onto a table)
};

export class FallDetector {
  constructor(onFall, opts = {}) {
    this.o = { ...DEFAULTS, ...opts };
    this.onFall = onFall;
    this.reset();
    this.orientation = null;
  }
  reset() {
    this.ffStart = null; // free-fall start time
    this.ffEnd = null;
    this.tumble = 0;
    this.lastT = null;
    this.before = null;
    this.peak = 0;
    this.cooldownUntil = this.cooldownUntil ?? 0;
  }
  /** Latest device orientation in degrees (beta = front/back tilt, gamma = left/right). */
  setOrientation(beta, gamma, alpha) {
    if (beta == null || gamma == null) return;
    this.orientation = { beta: Math.round(beta), gamma: Math.round(gamma), alpha: alpha == null ? undefined : Math.round(alpha) };
  }
  /**
   * One accelerometer sample: t in ms, a = accelerationIncludingGravity {x,y,z} in m/s²,
   * rot = rotationRate {alpha,beta,gamma} in deg/s (optional).
   */
  push(t, a, rot) {
    if (!a || a.x == null) return;
    const g = Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z) / G;
    const dt = this.lastT == null ? 0 : Math.max(0, Math.min(100, t - this.lastT)) / 1000;
    this.lastT = t;
    if (t < this.cooldownUntil) return;

    if (g < this.o.freefallG) {
      if (this.ffStart == null) {
        this.ffStart = t;
        this.before = this.orientation;
        this.tumble = 0;
      }
      this.ffEnd = t;
      if (rot) this.tumble += (Math.abs(rot.alpha ?? 0) + Math.abs(rot.beta ?? 0) + Math.abs(rot.gamma ?? 0)) * dt;
      return;
    }
    if (this.ffStart == null) return;
    const ffMs = this.ffEnd - this.ffStart;
    if (t - this.ffEnd > this.o.impactWindowMs || (ffMs < this.o.minFreefallMs && g < this.o.impactG)) {
      // Free fall that never landed hard, or too short: not a drop.
      if (t - this.ffEnd > this.o.impactWindowMs || ffMs < this.o.minFreefallMs) this.reset();
      return;
    }
    if (g >= this.o.impactG && ffMs >= this.o.minFreefallMs) {
      const tS = ffMs / 1000;
      const heightM = 0.5 * G * tS * tS;
      if (heightM < this.o.minHeightM) return this.reset();
      const ev = {
        at: new Date().toISOString(),
        freefallMs: Math.round(ffMs),
        heightM: Math.round(heightM * 100) / 100,
        impactG: Math.round(g * 10) / 10,
        tumbleDeg: Math.round(this.tumble),
        orientationBefore: this.before,
      };
      this.cooldownUntil = t + 5000; // one fall at a time; the bounce isn't a second fall
      this.reset();
      // Angle after landing: read once the phone settles.
      const finish = () => this.onFall({ ...ev, orientationAfter: this.orientation, severity: severity(ev) });
      if (typeof setTimeout === "function" && this.o.settleMs !== 0) setTimeout(finish, this.o.settleMs ?? 800);
      else finish();
    }
  }
}

export function severity(ev) {
  if (ev.heightM >= 1.5 || ev.impactG >= 6) return "high";
  if (ev.heightM >= 0.8 || ev.impactG >= 3.5) return "medium";
  return "low";
}

/** Cancel gesture for a broken screen: N strong shakes within a few seconds. */
export class ShakeCounter {
  constructor(onShakes, { need = 3, withinMs = 4000, minG = 2.0 } = {}) {
    Object.assign(this, { onShakes, need, withinMs, minG, hits: [], last: -Infinity });
  }
  push(t, a) {
    if (!a || a.x == null) return;
    const g = Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z) / G;
    if (g < this.minG || t - this.last < 250) return; // one hit per 250 ms
    this.last = t;
    this.hits = [...this.hits.filter((h) => t - h < this.withinMs), t];
    if (this.hits.length >= this.need) {
      this.hits = [];
      this.onShakes();
    }
  }
}

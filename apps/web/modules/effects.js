// Audio & visual effects, all generated in code (no sound files to download):
// Web Audio tones, vibration, toasts and small animations. Respects the 🔇 switch
// and the phone's "reduce motion" setting. Effects never block or throw.
const ls = { get: (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } }, set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} } };
let ctx = null;
export const fx = { muted: ls.get("biruni.muted", false) };
export const reducedMotion = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

function audio() {
  if (fx.muted) return null;
  try {
    ctx ??= new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === "suspended") ctx.resume();
    return ctx;
  } catch {
    return null;
  }
}
/** One soft tone: frequency glide + quick attack/decay envelope. */
function tone(f1, f2, ms, { type = "sine", gain = 0.06, at = 0 } = {}) {
  const c = audio();
  if (!c) return;
  const t = c.currentTime + at / 1000;
  const o = c.createOscillator(), g = c.createGain();
  o.type = type;
  o.frequency.setValueAtTime(f1, t);
  o.frequency.exponentialRampToValueAtTime(Math.max(1, f2), t + ms / 1000);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(gain, t + 0.012);
  g.gain.exponentialRampToValueAtTime(0.0001, t + ms / 1000);
  o.connect(g).connect(c.destination);
  o.start(t);
  o.stop(t + ms / 1000 + 0.02);
}
export function haptic(pattern) {
  if (fx.muted) return;
  try { navigator.vibrate?.(pattern); } catch {}
}

export const sfx = {
  send: () => (tone(520, 780, 90), haptic(8)),
  receive: () => (tone(660, 880, 70), tone(880, 990, 90, { at: 80 })),
  success: () => (tone(523, 523, 90), tone(659, 659, 90, { at: 90 }), tone(784, 784, 160, { at: 180 }), haptic([10, 40, 10])),
  error: () => (tone(300, 200, 180, { type: "triangle", gain: 0.05 }), haptic([30, 60, 30])),
  notify: () => (tone(740, 740, 110), tone(988, 988, 140, { at: 130 }), haptic(20)),
  /** SOS / drop alarm: two-tone siren, loud on purpose (ignores reduced motion, not mute). */
  alarm(seconds = 3) {
    for (let i = 0; i < seconds * 2; i++) tone(i % 2 ? 960 : 720, i % 2 ? 720 : 960, 480, { type: "square", gain: 0.08, at: i * 500 });
    haptic([500, 200, 500, 200, 500]);
  },
};

export function setMuted(m) {
  fx.muted = !!m;
  ls.set("biruni.muted", fx.muted);
}

/** Small, non-blocking message at the bottom of the screen. kind: ok | bad | info */
export function toast(message, kind = "info", ms = 3200) {
  let host = document.getElementById("toasts");
  if (!host) {
    host = document.createElement("div");
    host.id = "toasts";
    host.setAttribute("aria-live", "polite");
    document.body.append(host);
  }
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.textContent = message;
  host.append(el);
  (kind === "bad" ? sfx.error : kind === "ok" ? sfx.success : sfx.notify)();
  setTimeout(() => {
    el.classList.add("out");
    setTimeout(() => el.remove(), reducedMotion() ? 0 : 250);
  }, ms);
  return el;
}

/** Brief highlight on an element (e.g. a new booking in the trip card). */
export function flash(el) {
  if (!el || reducedMotion()) return;
  el.classList.remove("flash");
  void el.offsetWidth;
  el.classList.add("flash");
}

export function initEffects({ $ }) {
  // 🔇 / 🔊 switch in the top bar.
  const b = document.createElement("button");
  b.className = "icon-btn";
  b.id = "muteBtn";
  const label = () => ((b.textContent = fx.muted ? "🔇" : "🔊"), (b.title = fx.muted ? "Sounds & vibration off" : "Sounds & vibration on"));
  label();
  b.onclick = () => (setMuted(!fx.muted), label(), fx.muted || sfx.notify());
  $("themeBtn")?.after(b);
  // Browsers only allow audio after a user gesture: unlock it on the first tap.
  const unlock = () => (audio(), window.removeEventListener("pointerdown", unlock));
  window.addEventListener("pointerdown", unlock);
  if (reducedMotion()) document.documentElement.classList.add("reduce-motion");
  return { sfx, toast, flash };
}

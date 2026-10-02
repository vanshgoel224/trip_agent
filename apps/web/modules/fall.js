// Phone-drop watch (UI). Detects a drop, records the moment, starts a 60 s countdown
// (kept on the server, so a phone that breaks still triggers the SOS) and offers ways
// to cancel that don't need a working screen: shake 3×, say "I'm OK", any key, or
// tap "I'm OK" on any other device signed into your account.
import { FallDetector, ShakeCounter } from "./falldetect.js";
import { sfx } from "./effects.js";

const OK_WORDS = /\b(i'?m ok(ay)?|i am ok(ay)?|ok(ay)?|fine|theek|thik|theek hoon|thik hu|safe|cancel|no help|nahi)\b/i;

export function initFall({ $, api, esc, S, secureLocal }) {
  const ov = document.createElement("div");
  ov.className = "fall-overlay hidden";
  ov.id = "fallOverlay";
  ov.setAttribute("role", "alertdialog");
  ov.innerHTML = `<div class="fall-box">
    <h2>📱💥 Phone drop detected</h2>
    <p id="fallInfo" class="small"></p>
    <p class="fall-count"><span id="fallSecs">60</span>s</p>
    <p>If you're OK, cancel now. Otherwise Biruni will send an <b>SOS with your location</b> to your trip, your contacts and everyone nearby on Biruni who offered to help.</p>
    <button class="pill accent fall-ok" id="fallOk">✅ I'm OK — cancel</button>
    <p class="small muted">Screen broken? <b>Shake the phone 3 times</b>, or <b>say "I'm OK"</b>, or cancel from your other phone / laptop.</p>
    <a class="pill danger" href="tel:112">📞 Call 112 now</a>
    <p class="small" id="fallStatus"></p>
  </div>`;
  document.body.append(ov);

  let active = null, ticker = null, rec = null, local = false, offlineTimer = null, reporting = false;
  const vibrate = (p) => { try { navigator.vibrate?.(p); } catch {} };
  const say = (t) => { try { speechSynthesis.cancel(); speechSynthesis.speak(Object.assign(new SpeechSynthesisUtterance(t), { lang: "en-IN" })); } catch {} };

  function show(fall, isLocal) {
    active = fall;
    local = isLocal;
    ov.classList.remove("hidden");
    $("fallInfo").innerHTML = `${esc(fall.severity ?? "")} drop · ~${Number(fall.heightM).toFixed(1)} m · ${Number(fall.impactG).toFixed(1)} g${fall.tumbleDeg ? ` · tumbled ${fall.tumbleDeg}°` : ""}${fall.orientationAfter ? ` · landed at ${fall.orientationAfter.beta}°/${fall.orientationAfter.gamma}°` : ""}${isLocal ? "" : " · <b>on your other device</b>"}`;
    $("fallStatus").textContent = fall.status === "PENDING" ? "" : fall.status;
    clearInterval(ticker);
    const tick = () => {
      const s = Math.max(0, Math.round((Date.parse(fall.deadline) - Date.now()) / 1000));
      $("fallSecs").textContent = s;
      if (local && s > 0 && s % 10 === 0) (vibrate([300, 150, 300]), sfx.notify());
      if (local && s > 0 && s <= 5) sfx.alarm(0.5);
      if (s === 0) clearInterval(ticker);
    };
    tick();
    ticker = setInterval(tick, 1000);
    if (local) {
      sfx.alarm(2);
      vibrate([600, 200, 600, 200, 600]);
      say("Your phone was dropped. Are you OK? Say I'm OK, or shake the phone three times to cancel.");
      listen();
    }
  }
  function hide(msg) {
    clearInterval(ticker);
    clearTimeout(offlineTimer);
    try { rec?.abort(); } catch {}
    rec = null;
    if (msg) {
      $("fallStatus").textContent = msg;
      setTimeout(() => ov.classList.add("hidden"), 2500);
    } else ov.classList.add("hidden");
    active = null;
  }

  async function cancel(by) {
    if (!active) return;
    const f = active;
    if (!f.fallId) return hide("Cancelled (this phone was offline; nothing was sent)."); // local-only countdown
    try {
      await api("POST", `/api/falls/${f.fallId}/cancel`, { by });
      hide(`Cancelled (${by}). No SOS sent.`);
      say("Cancelled. Glad you're OK.");
    } catch (e) {
      $("fallStatus").textContent = e.message;
    }
  }
  $("fallOk").onclick = () => cancel("screen");
  window.addEventListener("keydown", (e) => active && local && e.key !== "Tab" && cancel("keyboard"));

  // Voice cancel (Chrome/Android; unavailable in some WebViews).
  function listen() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) return;
    try {
      rec = new SR();
      rec.lang = "en-IN";
      rec.continuous = true;
      rec.interimResults = true;
      rec.onresult = (e) => {
        const heard = [...e.results].map((r) => r[0].transcript).join(" ");
        if (OK_WORDS.test(heard)) cancel("voice");
      };
      rec.onend = () => active && local && setTimeout(() => { try { rec?.start(); } catch {} }, 300);
      rec.start();
    } catch {}
  }

  // Sensors
  const shake = new ShakeCounter(() => active && local && cancel("shake"));
  const det = new FallDetector(async (ev) => {
    const loc = (await secureLocal.lastLocation().catch(() => null)) ?? undefined;
    let battery;
    try { battery = (await navigator.getBattery?.())?.level; } catch {}
    const report = { ...ev, location: loc, battery, tripId: S.tripId || undefined, device: navigator.userAgentData?.platform || navigator.platform || "phone" };
    secureLocal.put("lastFall", report).catch(() => {});
    reporting = true; // our own live event may arrive before this reply: it's still "this phone"
    try {
      const f = await api("POST", "/api/falls", report);
      show(f, true);
    } catch {
      // Offline: run the countdown here and try to send the SOS when it ends.
      const f = { ...report, deadline: new Date(Date.now() + 60_000).toISOString(), status: "PENDING" };
      show(f, true);
      $("fallStatus").textContent = "No connection: counting down on this phone.";
      offlineTimer = setTimeout(async () => {
        if (!active) return;
        try {
          await api("POST", "/api/sos", { message: `Phone drop detected (~${ev.heightM} m, ${ev.impactG} g) and not cancelled.`, location: loc, everyone: true, tripId: S.tripId || undefined });
          hide("SOS sent.");
        } catch {
          const text = `SOS: my phone was dropped and I didn't respond.${loc ? ` Location: ${loc.lat},${loc.lng}` : ""} Please call 112.`;
          $("fallStatus").innerHTML = `Couldn't reach Biruni. <a class="pill danger" href="sms:?&body=${encodeURIComponent(text)}">✉️ Send SMS</a>`;
        }
      }, 60_000);
    } finally {
      reporting = false;
    }
  });
  const onMotion = (e) => {
    const t = performance.now();
    det.push(t, e.accelerationIncludingGravity, e.rotationRate);
    shake.push(t, e.accelerationIncludingGravity);
  };
  const onOrient = (e) => det.setOrientation(e.beta, e.gamma, e.alpha);

  // Other devices on the same account show the countdown too, and can cancel it.
  window.addEventListener("biruni:event", (ev) => {
    const e = ev.detail;
    if (e.type === "FALL" && e.data && !reporting && (!active || active.fallId !== e.data.fallId)) api("GET", "/api/falls/active").then((f) => f && show(f, false)).catch(() => {});
    if (e.type === "FALL_CANCELLED" && active?.fallId === e.data?.fallId) hide("Cancelled from another device.");
    if (e.type === "FALL_SOS") hide("No response: SOS sent to your trip, contacts and helpers nearby.");
  });
  api("GET", "/api/falls/active").then((r) => r?.active?.fallId && show(r.active, false)).catch(() => {});

  return {
    async start() {
      if (typeof DeviceMotionEvent === "undefined") throw new Error("No motion sensors on this device/browser");
      if (typeof DeviceMotionEvent.requestPermission === "function") {
        const r = await DeviceMotionEvent.requestPermission().catch(() => "denied"); // iOS
        if (r !== "granted") throw new Error("Motion permission denied");
      }
      window.addEventListener("devicemotion", onMotion);
      window.addEventListener("deviceorientation", onOrient);
    },
    stop() {
      window.removeEventListener("devicemotion", onMotion);
      window.removeEventListener("deviceorientation", onOrient);
    },
    /** For testing on a laptop: pretend the phone just fell. */
    simulate(ev = { freefallMs: 450, heightM: 1.0, impactG: 4.8, tumbleDeg: 260, severity: "medium", orientationBefore: { beta: 80, gamma: 4 }, orientationAfter: { beta: -2, gamma: 170 } }) {
      return det.onFall({ at: new Date().toISOString(), ...ev });
    },
    cancel,
  };
}

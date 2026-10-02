// Permissions centre: what Biruni can use on this phone, why, and how to fix a "no".
// Works in Chrome (PWA) and in the Android APK's WebView (the APK declares the same
// permissions in its manifest; Android then shows its own prompt on first use).
const isApk = () => /; wv\)/.test(navigator.userAgent) || !!window.Capacitor;
const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent);

const ITEMS = [
  { id: "geolocation", icon: "📍", name: "Location", why: "Maps, directions, leave-now alerts, and your position in an SOS." },
  { id: "microphone", icon: "🎤", name: "Microphone", why: "Talk instead of typing; voice translation; say “I'm OK” after a drop." },
  { id: "camera", icon: "📷", name: "Camera", why: "Attach a photo of where you are to an SOS." },
  { id: "motion", icon: "📱", name: "Motion sensors", why: "Drop & crash watch (detects a fall and asks if you're OK)." },
  { id: "notifications", icon: "🔔", name: "Notifications", why: "SOS alerts from others even when Biruni isn't on screen." },
  { id: "storage", icon: "💾", name: "Keep data on this phone", why: "Stops the browser from clearing your encrypted offline location when space is low." },
];

async function query(id) {
  try {
    if (id === "motion") {
      if (typeof DeviceMotionEvent === "undefined") return "unsupported";
      if (typeof DeviceMotionEvent.requestPermission === "function") return localStorage.getItem("biruni.motionOk") === "1" ? "granted" : "prompt";
      const r = await navigator.permissions?.query({ name: "accelerometer" }).catch(() => null);
      return r?.state ?? "granted"; // Android Chrome/WebView: no prompt needed
    }
    if (id === "notifications") return typeof Notification === "undefined" ? "unsupported" : Notification.permission === "default" ? "prompt" : Notification.permission;
    if (id === "storage") return navigator.storage?.persisted ? ((await navigator.storage.persisted()) ? "granted" : "prompt") : "unsupported";
    if ((id === "microphone" || id === "camera") && !navigator.mediaDevices?.getUserMedia) return "unsupported";
    if (id === "geolocation" && !navigator.geolocation) return "unsupported";
    const r = await navigator.permissions?.query({ name: id });
    return r?.state ?? "prompt";
  } catch {
    return "prompt"; // browsers that can't query still let us ask
  }
}

async function request(id) {
  if (id === "geolocation")
    return new Promise((res) => navigator.geolocation.getCurrentPosition(() => res("granted"), (e) => res(e.code === 1 ? "denied" : "granted"), { timeout: 15000 }));
  if (id === "microphone" || id === "camera") {
    try {
      const s = await navigator.mediaDevices.getUserMedia(id === "camera" ? { video: { facingMode: "environment" } } : { audio: true });
      s.getTracks().forEach((t) => t.stop());
      return "granted";
    } catch (e) {
      return e.name === "NotAllowedError" ? "denied" : e.name === "NotFoundError" ? "unsupported" : "denied";
    }
  }
  if (id === "motion") {
    if (typeof DeviceMotionEvent?.requestPermission === "function") {
      const r = await DeviceMotionEvent.requestPermission().catch(() => "denied");
      if (r === "granted") localStorage.setItem("biruni.motionOk", "1");
      return r;
    }
    // Android: no prompt; check the sensor actually delivers readings.
    return new Promise((res) => {
      const on = (e) => (window.removeEventListener("devicemotion", on), res(e.accelerationIncludingGravity?.x != null ? "granted" : "unsupported"));
      window.addEventListener("devicemotion", on);
      setTimeout(() => (window.removeEventListener("devicemotion", on), res("unsupported")), 1500);
    });
  }
  if (id === "notifications") return typeof Notification === "undefined" ? "unsupported" : await Notification.requestPermission();
  if (id === "storage") return (await navigator.storage?.persist?.()) ? "granted" : "denied";
  return "unsupported";
}

function fixHint(id) {
  if (isApk()) return "Android Settings → Apps → Biruni → Permissions → allow it. Then come back and tap Check again.";
  if (isIOS()) return id === "motion" ? "Reload Biruni and tap Allow when Safari asks about motion." : "Settings → Safari (or your browser) → this site → allow it.";
  return "Tap the 🔒 / ⓘ icon left of the address → Permissions (Site settings) → Allow. Then tap Check again.";
}

const LABEL = { granted: "✅ Allowed", prompt: "Not asked yet", denied: "⛔ Blocked", unsupported: "Not available here" };

export function initPermissions({ $, store, esc }) {
  const btn = document.createElement("button");
  btn.className = "side-link";
  btn.id = "permBtn";
  btn.textContent = "🛡️ Permissions";
  $("powerBtn")?.before(btn) ?? $("lockBtn")?.before(btn);

  const dlg = document.createElement("dialog");
  dlg.id = "permDialog";
  dlg.innerHTML = `<div class="modal">
    <div class="row between"><h2>🛡️ Permissions</h2><button class="icon-btn" data-close aria-label="Close">✕</button></div>
    <p class="muted small" id="permIntro"></p>
    <div id="permList"></div>
    <div class="row"><button class="pill accent" id="permAll">Allow everything needed</button><button class="pill" id="permRecheck">Check again</button></div>
  </div>`;
  document.body.append(dlg);
  dlg.querySelector("[data-close]").onclick = () => dlg.close();

  async function render() {
    const secure = window.isSecureContext;
    $("permIntro").innerHTML = secure
      ? `Biruni only asks for what a feature needs. You can change these any time.${isApk() ? " (Android app)" : ""}`
      : `<b>⚠ This page isn't on https://</b>, so the phone will refuse location, microphone, camera and motion. Open Biruni through its https address (or localhost).`;
    const states = await Promise.all(ITEMS.map((i) => query(i.id)));
    $("permList").innerHTML = ITEMS.map((i, k) => `<div class="perm-row">
      <div><b>${i.icon} ${i.name}</b> <span class="perm-state ${states[k]}">${LABEL[states[k]] ?? states[k]}</span><br><span class="muted small">${i.why}</span>
      ${states[k] === "denied" ? `<br><span class="small warn-text">How to fix: ${esc(fixHint(i.id))}</span>` : ""}</div>
      ${states[k] === "prompt" ? `<button class="pill" data-ask="${i.id}">Allow</button>` : ""}</div>`).join("");
    const missing = states.filter((s) => s === "prompt" || s === "denied").length;
    btn.textContent = `🛡️ Permissions${missing ? ` (${missing})` : " ✓"}`;
    return states;
  }
  dlg.addEventListener("click", async (e) => {
    const id = e.target.dataset.ask;
    if (!id) return;
    e.target.textContent = "Asking…";
    await request(id);
    render();
  });
  $("permRecheck").onclick = render;
  $("permAll").onclick = async () => {
    for (const i of ITEMS) if ((await query(i.id)) === "prompt") await request(i.id); // one at a time: phones show one prompt at a time
    render();
  };
  btn.onclick = () => (dlg.showModal(), render());
  render();

  return {
    render,
    /** First run: open the panel once, after the terms are accepted. */
    onboard() {
      if (store.get("permOnboarded", false)) return;
      store.set("permOnboarded", true);
      dlg.showModal();
      render();
    },
    query,
    request,
  };
}

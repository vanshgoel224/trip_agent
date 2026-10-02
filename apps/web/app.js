// Biruni UI. Talks only to the Biruni API — never to MCP servers or vendor rails directly.
const $ = (id) => document.getElementById(id);
const inr = (n) => "₹" + Number(n).toLocaleString("en-IN");
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const fmt = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>").replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener" style="color:var(--link)">$1</a>');
const store = { get: (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } }, set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} } };

const S = { modes: [], chats: [], chatId: store.get("chatId", null), tripId: store.get("tripId", ""), snap: null, langs: [], es: null, connections: null };

async function api(method, path, body) {
  const r = await fetch(path, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error?.message ?? r.statusText);
  return j;
}

// ---------------- chats ----------------
const modeInfo = (m) => S.modes.find((x) => x.mode === m) ?? { label: m, icon: "•" };

async function loadModes() {
  S.modes = await api("GET", "/api/chat-modes");
  $("modeMenu").innerHTML = S.modes.map((m) => `<button data-mode="${m.mode}"><span>${m.icon}</span> ${esc(m.label)}</button>`).join("");
  $("modeChips").innerHTML = S.modes.map((m) => `<button class="chip" data-mode="${m.mode}">${m.icon} ${esc(m.label)}</button>`).join("");
}

async function loadChats() {
  S.chats = await api("GET", "/api/chats");
  const groups = {};
  for (const c of S.chats) (groups[c.mode] ??= []).push(c);
  $("chatList").innerHTML = S.modes
    .filter((m) => groups[m.mode])
    .map((m) => `<div class="chat-group">${m.icon} ${esc(m.label)}</div>` + groups[m.mode].map((c) => `<button class="chat-item ${c.chatId === S.chatId ? "active" : ""}" data-chat="${c.chatId}"><span class="t">${esc(c.title)}</span><span class="x" data-del="${c.chatId}" title="Delete">✕</span></button>`).join(""))
    .join("") || `<p class="muted small" style="padding:8px 10px">No chats yet.</p>`;
}

async function newChat(mode) {
  const c = await api("POST", "/api/chats", { mode, tripId: S.tripId || undefined });
  $("modeMenu").classList.add("hidden");
  await openChat(c.chatId);
  await loadChats();
  $("input").focus();
}

async function openChat(chatId) {
  S.chatId = chatId;
  store.set("chatId", chatId);
  closeSidebar();
  if (!chatId) return renderEmpty();
  let data;
  try {
    data = await api("GET", `/api/chats/${chatId}`);
  } catch {
    S.chatId = null;
    return renderEmpty();
  }
  const { chat, messages } = data;
  if (chat.tripId && chat.tripId !== S.tripId) setTrip(chat.tripId, false);
  $("chatTitle").textContent = `${modeInfo(chat.mode).icon} ${chat.title}`;
  $("translateBar").classList.toggle("hidden", chat.mode !== "translate");
  $("input").placeholder = chat.mode === "translate" ? "Type something to translate…" : chat.mode === "splitwise" ? "e.g. I paid 1200 for dinner, split with Rahul and Priya" : "Ask Biruni anything…";
  const box = $("messages");
  box.innerHTML = "";
  if (!messages.length) box.append(heroFor(chat.mode));
  for (const m of messages) addMsg(m.role, m.text, m);
  document.querySelectorAll(".chat-item").forEach((el) => el.classList.toggle("active", el.dataset.chat === chatId));
}

function heroFor(mode) {
  const ideas = {
    general: ["What's my trip status?", "I'm travelling with Rahul and Priya, both vegetarian", "Add lunch at a beach shack tomorrow 1pm"],
    recovery: ["My bus was cancelled", "meri train 5 ghante late hai", "undo"],
    translate: ["Where is the bus stand? → Tamil", "कितने का है? → English", "Please slow down → Kannada"],
    splitwise: ["I paid 2400 for the cab, split with Rahul and Priya", "Rahul paid 900 for lunch for all three", "Who owes whom?"],
    discover: ["Hidden places near Gokarna", "Offbeat food in Old Delhi", "Quiet beaches in South Goa"],
    maps: ["Where am I?", "Nearest ATM", "Directions to the railway station"],
    calendar: ["What's on my calendar this week?", "Add check-out at 11am on Friday"],
    budget: ["How much can Biruni spend for me?", "What's protected in my account?"],
  }[mode] ?? [];
  const d = document.createElement("div");
  d.className = "hero";
  d.innerHTML = `<div class="hero-logo">${modeInfo(mode).icon}</div><h1>${esc(modeInfo(mode).label)}</h1><div class="chips">${ideas.map((i) => `<button class="chip" data-say="${esc(i)}">${esc(i)}</button>`).join("")}</div>`;
  return d;
}

function renderEmpty() {
  $("chatTitle").textContent = "Biruni";
  $("translateBar").classList.add("hidden");
  const box = $("messages");
  box.innerHTML = "";
  const hero = document.createElement("div");
  hero.className = "hero";
  hero.innerHTML = `<div class="hero-logo">◐</div><h1>Where to?</h1><p class="muted">Plans, disruptions, translation, splitting bills, maps — one place.</p><div class="chips">${S.modes.map((m) => `<button class="chip" data-mode="${m.mode}">${m.icon} ${esc(m.label)}</button>`).join("")}</div>`;
  box.append(hero);
}

function addMsg(role, text, m = {}) {
  const box = $("messages");
  box.querySelector(".hero")?.remove();
  const d = document.createElement("div");
  d.className = `msg ${role}`;
  const tools = (m.tools ?? []).map((t) => `<span class="tool-chip">${esc(t)}</span>`).join("");
  const meta = role === "assistant" ? `<div class="meta">${tools}${m.source ? `<span>${esc(String(m.source).replace("ONLINE_MODEL:", "").replace("OFFLINE_MODEL:", "offline · "))}</span>` : ""}<button class="play" data-play="${esc(text)}">🔊</button></div>` : "";
  d.innerHTML = `<div class="bubble">${fmt(text)}</div>${meta}`;
  box.append(d);
  box.scrollTop = box.scrollHeight;
  return d;
}

async function send(text) {
  text = text.trim();
  if (!text) return;
  if (!S.chatId) {
    const c = await api("POST", "/api/chats", { mode: "general", tripId: S.tripId || undefined });
    S.chatId = c.chatId;
    store.set("chatId", c.chatId);
    await openChat(c.chatId);
  }
  addMsg("user", text);
  const typing = document.createElement("div");
  typing.className = "msg assistant";
  typing.innerHTML = `<div class="bubble typing">Thinking</div>`;
  $("messages").append(typing);
  $("send").disabled = true;
  try {
    const isTr = S.chats.find((c) => c.chatId === S.chatId)?.mode === "translate" || !$("translateBar").classList.contains("hidden");
    const r = await api("POST", `/api/chats/${S.chatId}/messages`, isTr ? { text, targetLanguage: $("toLang").value, sourceLanguage: $("fromLang").value } : { text });
    typing.remove();
    addMsg("assistant", r.message.text, r.message);
    if ($("speak").checked) speak(r.message.text, langForSpeech());
    loadChats();
    refreshTrip();
  } catch (e) {
    typing.remove();
    addMsg("assistant", `Error: ${e.message}`);
  } finally {
    $("send").disabled = false;
  }
}

// ---------------- voice ----------------
const langForSpeech = () => (S.chats.find((c) => c.chatId === S.chatId)?.mode === "translate" ? $("toLang").value : "en-IN");

async function speak(text, lang = "en-IN") {
  try {
    const r = await api("POST", "/api/voice/tts", { text, language: lang });
    if (r.audioUrl) return void new Audio(r.audioUrl).play();
  } catch {}
  if ("speechSynthesis" in window) {
    const u = new SpeechSynthesisUtterance(text);
    u.lang = lang;
    const v = speechSynthesis.getVoices().find((x) => x.lang?.toLowerCase().startsWith(lang.slice(0, 2).toLowerCase()));
    if (v) u.voice = v;
    speechSynthesis.cancel();
    speechSynthesis.speak(u);
  }
}

// WAV recorder (Gnani STT accepts wav; browser MediaRecorder gives webm, which it doesn't list).
async function recordWav(maxMs = 12000) {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const ctx = new AudioContext({ sampleRate: 16000 });
  const src = ctx.createMediaStreamSource(stream);
  const proc = ctx.createScriptProcessor(4096, 1, 1);
  const chunks = [];
  proc.onaudioprocess = (e) => chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
  src.connect(proc);
  proc.connect(ctx.destination);
  let stop;
  const done = new Promise((r) => (stop = r));
  const t = setTimeout(stop, maxMs);
  return {
    stop: () => (clearTimeout(t), stop()),
    result: done.then(() => {
      proc.disconnect(); src.disconnect(); stream.getTracks().forEach((x) => x.stop()); ctx.close();
      const len = chunks.reduce((a, c) => a + c.length, 0);
      const pcm = new DataView(new ArrayBuffer(44 + len * 2));
      const w = (o, s) => [...s].forEach((ch, i) => pcm.setUint8(o + i, ch.charCodeAt(0)));
      w(0, "RIFF"); pcm.setUint32(4, 36 + len * 2, true); w(8, "WAVE"); w(12, "fmt "); pcm.setUint32(16, 16, true); pcm.setUint16(20, 1, true); pcm.setUint16(22, 1, true);
      pcm.setUint32(24, 16000, true); pcm.setUint32(28, 32000, true); pcm.setUint16(32, 2, true); pcm.setUint16(34, 16, true); w(36, "data"); pcm.setUint32(40, len * 2, true);
      let o = 44;
      for (const c of chunks) for (const v of c) (pcm.setInt16(o, Math.max(-1, Math.min(1, v)) * 0x7fff, true), (o += 2));
      let bin = "";
      const bytes = new Uint8Array(pcm.buffer);
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      return btoa(bin);
    }),
  };
}

const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
function browserListen(lang) {
  return new Promise((resolve, reject) => {
    if (!SR) return reject(new Error("This browser has no speech recognition; use Chrome, or set GNANI_API_KEY for server STT"));
    const rec = new SR();
    rec.lang = lang;
    rec.onresult = (e) => resolve(e.results[0][0].transcript);
    rec.onerror = (e) => reject(new Error(e.error));
    rec.start();
  });
}

let recorder = null;
async function listen(lang, button) {
  const gnani = S.connections?.rails?.gnani === "GnaniProvider";
  if (!gnani) {
    button.classList.add("rec");
    try { return { text: await browserListen(lang) }; } finally { button.classList.remove("rec"); }
  }
  if (recorder) return void recorder.stop();
  button.classList.add("rec");
  recorder = await recordWav();
  try { return { audioBase64: await recorder.result, mime: "audio/wav" }; } finally { recorder = null; button.classList.remove("rec"); }
}

$("mic").onclick = async () => {
  try {
    const r = await listen("en-IN", $("mic"));
    if (!r) return;
    const text = r.text ?? (await api("POST", "/api/voice/stt", { audioBase64: r.audioBase64, mime: r.mime, language: "en-IN" })).text;
    if (text) send(text);
  } catch (e) {
    addMsg("assistant", `Mic: ${e.message}`);
  }
};

$("voiceTranslate").onclick = async () => {
  const from = $("fromLang").value, to = $("toLang").value;
  try {
    const r = await listen(from === "auto" ? "en-IN" : from, $("voiceTranslate"));
    if (!r) return;
    const out = await api("POST", "/api/voice/translate", { ...r, from, to });
    const card = document.createElement("div");
    card.className = "tcard";
    card.innerHTML = `<div class="muted small">Heard (${esc(out.sttChannel)}): ${esc(out.heard)}</div><div class="big">${esc(out.translation)}</div><div class="muted">${esc(out.pronunciation ?? "")}</div>${out.warning ? `<div class="small" style="color:var(--warn)">⚠ ${esc(out.warning)}</div>` : ""}<div><button class="play" data-play="${esc(out.translation)}" data-lang="${to}">🔊 Play</button></div>`;
    $("messages").querySelector(".hero")?.remove();
    $("messages").append(card);
    $("messages").scrollTop = 1e9;
    if (out.audioUrl) new Audio(out.audioUrl).play();
    else speak(out.translation, to);
  } catch (e) {
    addMsg("assistant", `Voice translate: ${e.message}`);
  }
};

$("swapLang").onclick = () => {
  const f = $("fromLang").value;
  if (f === "auto") return;
  $("fromLang").value = $("toLang").value;
  $("toLang").value = f;
};

async function loadLanguages() {
  S.langs = await api("GET", "/api/languages");
  const opts = S.langs.map((l) => `<option value="${l.code}">${esc(l.name)}${l.gnaniVoice ? " · Gnani" : ""}</option>`).join("");
  $("fromLang").innerHTML = `<option value="auto">Detect language</option>` + opts;
  $("toLang").innerHTML = opts;
  $("fromLang").value = "auto";
  $("toLang").value = "hi-IN";
}

// ---------------- trips ----------------
async function loadTrips() {
  const trips = await api("GET", "/api/trips");
  $("tripSelect").innerHTML = `<option value="">No trip</option>` + trips.map((t) => `<option value="${t.tripId}">${esc(t.origin)} → ${esc(t.destination)} · ${t.status}</option>`).join("");
  $("tripSelect").value = trips.some((t) => t.tripId === S.tripId) ? S.tripId : "";
}

function setTrip(tripId, persistToChat = true) {
  S.tripId = tripId || "";
  store.set("tripId", S.tripId);
  $("tripSelect").value = S.tripId;
  connectEvents();
  refreshTrip();
  if (persistToChat && S.chatId) api("POST", `/api/chats/${S.chatId}/trip`, { tripId: S.tripId || undefined }).catch(() => {});
}

$("tripSelect").onchange = (e) => setTrip(e.target.value);
$("newTripBtn").onclick = () => {
  const d = new Date(Date.now() + 6 * 3600_000);
  $("tripForm").departure.value = new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  $("tripDialog").showModal();
};
$("tripDialog").addEventListener("close", async () => {
  if ($("tripDialog").returnValue !== "ok") return;
  const f = Object.fromEntries(new FormData($("tripForm")));
  try {
    const r = await api("POST", "/api/trips/quick", { ...f, fare: Number(f.fare), dailyCeiling: Number(f.dailyCeiling) });
    await loadTrips();
    setTrip(r.tripId);
    await newChat("general");
  } catch (e) {
    alert(e.message);
  }
});

async function refreshTrip() {
  if (!S.tripId) {
    $("tripCard").innerHTML = "No trip selected. Create one with ＋.";
    $("recoveryCard").classList.add("hidden");
    return;
  }
  try {
    S.snap = await api("GET", `/api/trips/${S.tripId}`);
  } catch {
    return;
  }
  renderTrip();
}

let undoDeadline = 0;
function renderTrip() {
  const { trip, incident, ledger, obligations, runtime } = S.snap;
  const acts = trip.activities ?? [];
  $("tripCard").classList.remove("muted");
  $("tripCard").innerHTML = `
    <div class="card-title">${esc(trip.itinerary.origin)} → ${esc(trip.itinerary.destination)}</div>
    <dl class="kv"><dt>Status</dt><dd>${trip.status}${runtime.online ? "" : " · OFFLINE"}</dd>
    <dt>Authority</dt><dd>${ledger ? `${inr(ledger.remainingIncident)} of ${inr(ledger.incidentLimit)} · today ${inr(ledger.remainingDaily)}` : "₹2,000 per disruption"}</dd>
    <dt>Free balance</dt><dd>${obligations ? `${inr(obligations.freeBalance)} <span class="muted small">(committed ${inr(obligations.committedTotal)}, simulated)</span>` : "—"}</dd></dl>
    <ol class="legs">${trip.itinerary.legs.map((l) => `<li class="${l.status}">${esc(l.from)} → ${esc(l.to)} · ${l.mode} ${l.departure.slice(5, 16).replace("T", " ")} · ${inr(l.cost)} <span class="muted small">${l.status}${l.bookingRef ? " · " + esc(l.bookingRef) : ""}</span></li>`).join("")}</ol>
    ${acts.length ? `<div class="card-title" style="margin-top:10px">Plans</div><ol class="legs">${acts.map((a) => `<li>${a.date}${a.time ? " " + a.time : ""} · ${esc(a.title)}${a.location ? ` <span class="muted small">@ ${esc(a.location)}</span>` : ""}</li>`).join("")}</ol>` : ""}`;

  const rc = $("recoveryCard");
  rc.classList.toggle("hidden", !incident || incident.step === "CLOSED" && !incident.chosenOption);
  if (incident) {
    const seen = new Set(incident.timeline.map((t) => t.step));
    const steps = [["CLASSIFIED", "Disruption classified"], ["OPTIONS_GENERATED", "Alternatives found"], ["OBLIGATION_CHECKED", "Obligation check", "OBLIGATION_AT_RISK"], ["AUTHORITY_CHECKED", "₹2,000 authority check", "AUTHORITY_EXHAUSTED"], ["UNDO_WINDOW_OPEN", "Alternative booked"], ["VERIFIED", "Verified"], ["READBACK_SENT", "Voice readback"]];
    const li = steps.map(([s, l, f]) => (seen.has(s) ? `<li class="done">✓ ${l}</li>` : f && incident.stopReason === f ? `<li class="fail">✗ ${l} — blocked</li>` : `<li class="muted">○ ${l}</li>`));
    if (incident.stopReason === "SAFETY_INVOLVED") li.splice(1, li.length, `<li class="fail">✗ Safety — automation stopped, escalated</li>`);
    const p = incident.step !== "CLOSED" && incident.pendingApproval;
    rc.innerHTML = `<div class="card-title">⚠ ${esc(incident.classification ?? "Disruption")}: ${esc(incident.description)}</div><ul class="check">${li.join("")}</ul>
      ${incident.chosenOption ? `<div class="small">New: <b>${esc(incident.chosenOption.vendorName)}</b> · ${incident.chosenOption.departure.slice(11, 16)} · ${inr(incident.chosenOption.price)}</div>` : ""}
      ${p ? `<div class="small" style="margin-top:8px">${esc(p.message)}</div><div class="approve-row"><button class="pill accent" id="approveBtn">Approve</button><button class="pill" id="declineBtn">Decline</button></div>` : ""}
      <button class="undo-btn hidden" id="undoBtn">UNDO</button>`;
    undoDeadline = incident.step === "UNDO_WINDOW_OPEN" ? Date.now() + S.snap.undoRemainingMs : 0;
    tickUndo();
    $("approveBtn")?.addEventListener("click", () => api("POST", `/api/recovery/${incident.incidentId}/approve`, { approve: true }).then(refreshTrip));
    $("declineBtn")?.addEventListener("click", () => api("POST", `/api/recovery/${incident.incidentId}/approve`, { approve: false }).then(refreshTrip));
    $("undoBtn")?.addEventListener("click", () => api("POST", `/api/recovery/${incident.incidentId}/cancel`).then(refreshTrip));
  }
  $("online").checked = runtime.online;
  refreshDevice();
}

function tickUndo() {
  const b = $("undoBtn");
  if (!b) return;
  const secs = Math.max(0, Math.ceil((undoDeadline - Date.now()) / 1000));
  b.classList.toggle("hidden", secs <= 0);
  b.textContent = `UNDO (${secs}s)`;
}
setInterval(tickUndo, 250);

$("online").onchange = (e) => S.tripId && api("POST", `/api/trips/${S.tripId}/connectivity`, { online: e.target.checked }).then(refreshTrip);

// ---------------- events ----------------
function connectEvents() {
  S.es?.close();
  S.es = new EventSource(`/api/events${S.tripId ? `?tripId=${encodeURIComponent(S.tripId)}` : ""}`);
  S.es.onmessage = (m) => {
    const e = JSON.parse(m.data);
    const li = document.createElement("li");
    li.innerHTML = `<span class="t">${e.at.slice(11, 19)}</span><span class="who">${esc(e.agent)}</span>${esc(e.detail)}`;
    $("activity").prepend(li);
    while ($("activity").children.length > 200) $("activity").lastChild.remove();
    if (e.type === "IMPACT") refreshDevice();
    if (e.type === "VOICE" && e.data?.kind === "CHECKIN") $("checkin").classList.remove("hidden");
    if (["STEP", "TRIP_STATUS", "ITINERARY", "ACTIVITY", "LEDGER_COMMIT", "UNDO_EXPIRED", "UNDO_CANCELLED", "ROUTE", "LOCATION"].includes(e.type)) scheduleRefresh();
  };
}
let pending;
const scheduleRefresh = () => (clearTimeout(pending), (pending = setTimeout(refreshTrip, 150)));

// ---------------- map, GPS, accelerometer ----------------
let map, meMarker, routeLine;
function ensureMap() {
  if (map || !window.L) return;
  map = L.map("map", { zoomControl: true, attributionControl: true }).setView([20.6, 78.9], 4);
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "© OpenStreetMap contributors" }).addTo(map);
}

async function refreshDevice() {
  const st = await api("GET", `/api/device/state${S.tripId ? `?tripId=${S.tripId}` : ""}`).catch(() => null);
  if (!st) return;
  $("checkin").classList.toggle("hidden", !st.checkin);
  if ($("drawer").classList.contains("hidden")) return;
  ensureMap();
  if (!map) return;
  setTimeout(() => map.invalidateSize(), 50);
  if (st.location) {
    const ll = [st.location.lat, st.location.lng];
    meMarker ? meMarker.setLatLng(ll) : (meMarker = L.circleMarker(ll, { radius: 7, color: "#4ea1ff", fillOpacity: 0.9 }).addTo(map).bindPopup("You"));
    $("mapNote").textContent = `· ±${Math.round(st.location.accuracy ?? 0)} m`;
    if (!st.route) map.setView(ll, 15);
  }
  if (st.route?.geometry?.length) {
    routeLine?.remove();
    routeLine = L.polyline(st.route.geometry, { color: "#f5f5f5", weight: 4, opacity: 0.85 }).addTo(map);
    map.fitBounds(routeLine.getBounds(), { padding: [20, 20] });
    $("routeSteps").innerHTML = `<li class="muted">${esc(st.route.to?.name ?? "")}: ${(st.route.distanceM / 1000).toFixed(1)} km · ${Math.round(st.route.durationS / 60)} min</li>` + st.route.steps.map((s) => `<li>${esc(s)}</li>`).join("");
  }
}

let geoWatch = null, lastSent = 0;
$("gps").onchange = (e) => {
  if (!e.target.checked) return void (geoWatch != null && navigator.geolocation.clearWatch(geoWatch), (geoWatch = null));
  if (!navigator.geolocation) return alert("This browser has no GPS access");
  geoWatch = navigator.geolocation.watchPosition(
    (p) => {
      if (Date.now() - lastSent < 10_000) return;
      lastSent = Date.now();
      api("POST", "/api/device/location", { tripId: S.tripId || undefined, lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy, speed: p.coords.speed, heading: p.coords.heading }).then(refreshDevice).catch(() => {});
    },
    (err) => { alert(`Location: ${err.message}. Phones only allow GPS on https:// or localhost.`); e.target.checked = false; },
    { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 },
  );
};

// Crash/fall heuristic: impact ≥ 3.5 g followed by ~3 s of near-stillness.
let motionOn = false, impactAt = 0, peak = 0, still = 0;
function onMotion(ev) {
  const a = ev.accelerationIncludingGravity;
  if (!a || a.x == null) return;
  const g = Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z) / 9.81;
  const now = Date.now();
  if (g >= 3.5 && now - impactAt > 10_000) { impactAt = now; peak = g; still = 0; return; }
  if (impactAt && now - impactAt < 5000) {
    peak = Math.max(peak, g);
    if (Math.abs(g - 1) < 0.15) still += ev.interval || 16;
    if (still >= 3000 && S.tripId) {
      api("POST", "/api/device/impact", { tripId: S.tripId, peakG: peak, stillSeconds: Math.round(still / 1000) }).then(refreshDevice);
      impactAt = 0;
    }
  }
}
$("motion").onchange = async (e) => {
  if (!e.target.checked) return void (window.removeEventListener("devicemotion", onMotion), (motionOn = false));
  if (!S.tripId) { e.target.checked = false; return alert("Pick a trip first"); }
  if (typeof DeviceMotionEvent === "undefined") { e.target.checked = false; return alert("No accelerometer on this device/browser"); }
  if (typeof DeviceMotionEvent.requestPermission === "function") {
    const r = await DeviceMotionEvent.requestPermission().catch(() => "denied"); // iOS
    if (r !== "granted") { e.target.checked = false; return alert("Motion permission denied"); }
  }
  window.addEventListener("devicemotion", onMotion);
  motionOn = true;
};
$("imOk").onclick = () => S.tripId && api("POST", "/api/device/ok", { tripId: S.tripId }).then(() => $("checkin").classList.add("hidden"));

// ---------------- connections ----------------
async function openConnections() {
  const c = (S.connections = await api("GET", "/api/connections"));
  const row = (name, on, detail, label) => `<div class="conn"><div class="row between"><b>${name}</b><span class="st ${on ? "on" : "off"}">${label ?? (on ? "Connected" : "Not connected")}</span></div><div class="muted small">${detail}</div></div>`;
  const live = (cls) => !/^Mock/.test(cls);
  $("connList").innerHTML = [
    row("Language model", !!c.models.online, c.models.online ? `${esc(c.models.online.provider)} · ${esc(c.models.online.model)}${c.models.lastError ? ` · last error: ${esc(c.models.lastError.slice(0, 80))}` : ""}` : "Set GEMINI_API_KEY or ONLINE_MODEL_API_KEY", c.models.online ? "Configured" : undefined),
    row("Offline model", false, c.models.offline ? `${esc(c.models.offline.model)} via local Ollama — used when you switch Online off; only reachable on your own machine` : "OFFLINE_MODEL_CONFIG", c.models.offline ? "Configured" : "Off"),
    row("Gnani voice", live(c.rails.gnani), live(c.rails.gnani) ? "Live TTS/STT" : "Set GNANI_API_KEY · browser speech used meanwhile"),
    row("Pine Labs", live(c.rails.pineLabs), live(c.rails.pineLabs) ? "Live: charges become payment links the traveller completes" : "Simulated · set PINELABS_CLIENT_ID/API_KEY"),
    row("Transport inventory", false, "Simulated: no bus/train booking API is wired (Delhivery has none)", "Simulated"),
    row("Setu AA", live(c.rails.setuAA), live(c.rails.setuAA) ? "Live (consented data)" : "Simulated · set SETU_ACCESS_TOKEN/PRODUCT_INSTANCE_ID"),
    row("Zerodha", live(c.rails.zerodha), live(c.rails.zerodha) ? `Read-only · <a href="/api/zerodha/login" style="color:var(--link)">Log in to Kite today →</a>` : "Simulated · set ZERODHA_API_KEY/SECRET"),
    row("Delhivery Maps", c.mcpServers.some((m) => m.name === "delhivery_maps" && m.connected), c.mcpServers.some((m) => m.name === "delhivery_maps") ? "MCP server (geocode, route)" : "Set DELHIVERY_MAPS_TOKEN to auto-connect its MCP server"),
    row("Google Calendar", c.calendar.canRead, c.calendar.linked ? "Linked (read + write)" : c.calendar.icsReadOnly ? "Read-only via ICS" : c.calendar.oauthConfigured ? `<a href="/api/calendar/connect" style="color:var(--link)">Connect your calendar →</a>` : "Set GOOGLE_CLIENT_ID/SECRET, or GOOGLE_CALENDAR_ICS_URL"),
    row("Reddit", c.reddit.configured, esc(c.reddit.note)),
    row("YouTube", c.youtube.configured, c.youtube.configured ? "Data API v3" : "Set YOUTUBE_API_KEY (Gemini key won't work)"),
    row("Splitwise", c.splitwise.configured, c.splitwise.configured ? "Sync enabled" : "Local splitting works; set SPLITWISE_API_KEY to sync"),
    row("Maps", true, esc(c.maps.provider)),
  ].join("");
  renderMcp(c.mcpServers);
  const sc = await api("GET", "/api/scenarios");
  $("scenarioList").innerHTML = sc.map((s) => `<button class="chip" data-scenario="${s.name}" title="${esc(s.trigger)}">${s.name}: ${esc(s.title)}</button>`).join("");
  $("connDialog").showModal();
}
function renderMcp(list) {
  $("mcpList").innerHTML = list.length ? list.map((s) => `<div class="mcp-row"><span><b>${esc(s.name)}</b> <span class="muted small">${esc(s.url ?? s.command ?? "")} · ${s.transport}${s.source === "env" ? " · env" : ""}</span><br><span class="small ${s.connected ? "" : "muted"}">${s.connected ? `${s.tools.length} tools: ${esc(s.tools.slice(0, 8).join(", "))}` : esc(s.error ?? "not connected")}</span></span><span class="row"><button class="pill" data-mcp-re="${s.serverId}">Reconnect</button>${s.source === "ui" ? `<button class="pill" data-mcp-del="${s.serverId}">Remove</button>` : ""}</span></div>`).join("") : `<p class="muted small">None yet.</p>`;
}
$("mcpForm").onsubmit = async (e) => {
  e.preventDefault();
  const f = Object.fromEntries(new FormData(e.target));
  try {
    await api("POST", "/api/mcp/servers", { name: f.name, url: f.url, transport: f.transport, headers: f.auth ? { Authorization: f.auth } : undefined });
    e.target.reset();
  } catch (err) {
    alert(`MCP: ${err.message}`);
  }
  renderMcp(await api("GET", "/api/mcp/servers"));
};

// ---------------- memory graph ----------------
async function openMemory() {
  const [g, rep] = await Promise.all([api("GET", "/api/memory/graph"), api("GET", "/api/memory/report")]);
  $("memReport").textContent = rep.markdown;
  drawGraph(g);
  $("memDialog").showModal();
}
function drawGraph(g) {
  const W = 800, H = 460, svg = $("graph");
  const nodes = g.nodes.map((n, i) => ({ ...n, x: W / 2 + Math.cos(i) * 150 + Math.random() * 20, y: H / 2 + Math.sin(i) * 120 + Math.random() * 20, vx: 0, vy: 0 }));
  const idx = new Map(nodes.map((n, i) => [n.id, i]));
  const links = g.links.filter((l) => idx.has(l.source) && idx.has(l.target));
  for (let it = 0; it < 300; it++) {
    for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i], b = nodes[j], dx = a.x - b.x, dy = a.y - b.y, d2 = dx * dx + dy * dy + 0.01, f = 1800 / d2;
      a.vx += dx * f / 40; a.vy += dy * f / 40; b.vx -= dx * f / 40; b.vy -= dy * f / 40;
    }
    for (const l of links) {
      const a = nodes[idx.get(l.source)], b = nodes[idx.get(l.target)], dx = b.x - a.x, dy = b.y - a.y, d = Math.sqrt(dx * dx + dy * dy) || 1, f = (d - 110) * 0.02;
      a.vx += dx / d * f; a.vy += dy / d * f; b.vx -= dx / d * f; b.vy -= dy / d * f;
    }
    for (const n of nodes) { n.vx += (W / 2 - n.x) * 0.002; n.vy += (H / 2 - n.y) * 0.002; n.x = Math.max(30, Math.min(W - 160, n.x + n.vx)); n.y = Math.max(20, Math.min(H - 20, n.y + n.vy)); n.vx *= 0.6; n.vy *= 0.6; }
  }
  const palette = ["#f5f5f5", "#4ea1ff", "#58c98a", "#f0a35e", "#c58af9", "#f07a6f", "#9aa0a6", "#6fd3d3"];
  svg.innerHTML = nodes.length
    ? links.map((l) => { const a = nodes[idx.get(l.source)], b = nodes[idx.get(l.target)]; return `<line x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}"><title>${esc(l.relation)}</title></line><text x="${(a.x + b.x) / 2}" y="${(a.y + b.y) / 2}" style="fill:var(--muted);font-size:9px" text-anchor="middle">${esc(l.relation.replace(/_/g, " "))}</text>`; }).join("") +
      nodes.map((n) => `<circle cx="${n.x}" cy="${n.y}" r="${5 + Math.min(8, n.mentions)}" fill="${palette[n.community % palette.length]}"><title>${esc(n.community_name)}</title></circle><text x="${n.x + 9}" y="${n.y + 4}">${esc(n.label.slice(0, 28))}</text>`).join("")
    : `<text x="400" y="230" text-anchor="middle" style="fill:var(--muted)">Nothing remembered yet — tell Biruni about your travel companions or preferences.</text>`;
}
$("memExport").onclick = async () => {
  const r = await api("POST", "/api/memory/export");
  alert(`Wrote ${r.written.join(", ")} on the server`);
};

// ---------------- wiring ----------------
document.addEventListener("click", async (e) => {
  const t = e.target.closest("[data-mode],[data-chat],[data-del],[data-say],[data-play],[data-close],[data-scenario],[data-mcp-re],[data-mcp-del]");
  if (!t) return;
  if (t.dataset.del) {
    e.stopPropagation();
    if (!confirm("Delete this chat?")) return;
    await api("POST", `/api/chats/${t.dataset.del}/delete`);
    if (S.chatId === t.dataset.del) openChat(null);
    return loadChats();
  }
  if (t.dataset.mode) return newChat(t.dataset.mode);
  if (t.dataset.chat) return openChat(t.dataset.chat);
  if (t.dataset.say) return send(t.dataset.say);
  if (t.dataset.play) return speak(t.dataset.play, t.dataset.lang || langForSpeech());
  if (t.dataset.close !== undefined) return t.closest("dialog").close();
  if (t.dataset.mcpRe) return api("POST", `/api/mcp/servers/${t.dataset.mcpRe}/reconnect`).then(renderMcp).catch((err) => alert(err.message));
  if (t.dataset.mcpDel) return api("POST", `/api/mcp/servers/${t.dataset.mcpDel}/delete`).then(renderMcp);
  if (t.dataset.scenario) {
    $("connDialog").close();
    const s = await api("POST", `/api/scenarios/${t.dataset.scenario}`);
    await loadTrips();
    setTrip(s.tripId, false);
    await newChat("recovery");
    $("input").value = s.trigger;
    openDrawer();
  }
});

$("composer").onsubmit = (e) => {
  e.preventDefault();
  const v = $("input").value;
  $("input").value = "";
  autosize();
  send(v);
};
const autosize = () => { const i = $("input"); i.style.height = "auto"; i.style.height = Math.min(180, i.scrollHeight) + "px"; };
$("input").addEventListener("input", autosize);
$("input").addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); $("composer").requestSubmit(); } });
$("newChatBtn").onclick = () => $("modeMenu").classList.toggle("hidden");
const openDrawer = () => { $("drawer").classList.remove("hidden"); refreshTrip(); };
$("tripBtn").onclick = () => ($("drawer").classList.contains("hidden") ? openDrawer() : $("drawer").classList.add("hidden"));
$("closeDrawer").onclick = () => $("drawer").classList.add("hidden");
$("connBtn").onclick = () => openConnections().catch((e) => alert(e.message));
$("memoryBtn").onclick = () => openMemory().catch((e) => alert(e.message));
$("openSidebar").onclick = () => $("sidebar").classList.add("open");
const closeSidebar = () => $("sidebar").classList.remove("open");
$("closeSidebar").onclick = closeSidebar;

(async function init() {
  await loadModes();
  await Promise.all([loadChats(), loadTrips(), loadLanguages(), api("GET", "/api/connections").then((c) => (S.connections = c)).catch(() => {})]);
  connectEvents();
  if (S.chatId && S.chats.some((c) => c.chatId === S.chatId)) await openChat(S.chatId);
  else renderEmpty();
  refreshTrip();
  const qs = new URLSearchParams(location.search);
  if (qs.get("calendar") === "connected") addMsg("assistant", "Google Calendar connected.");
  if (qs.get("zerodha") === "connected") addMsg("assistant", "Zerodha connected for today (read-only; never sold for recovery).");
})();

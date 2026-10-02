// Biruni demo UI. Talks only to the Biruni API — never to MCP or vendor rails.
const $ = (id) => document.getElementById(id);
const inr = (n) => "₹" + Number(n).toLocaleString("en-IN");
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

let tripId = null;
let es = null;
let snap = null;
let undoDeadline = 0;
const spoken = new Set();

async function api(method, path, body) {
  const r = await fetch(path, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error?.message ?? r.statusText);
  return j;
}

// ---------- scenarios ----------
async function loadScenarios() {
  const list = await api("GET", "/api/scenarios");
  $("scenarios").innerHTML = list.map((s) => `<button class="ghost" data-s="${s.name}" title="${esc(s.trigger)}">${s.name}: ${esc(s.title)}</button>`).join("");
  $("scenarios").onclick = async (e) => {
    const name = e.target.closest("button")?.dataset.s;
    if (!name) return;
    $("activity").innerHTML = "";
    $("thread").innerHTML = "";
    spoken.clear();
    const s = await api("POST", `/api/scenarios/${name}`);
    tripId = s.tripId;
    connect();
    await refresh();
    $("text").value = s.trigger;
    $("text").focus();
  };
}

function connect() {
  es?.close();
  es = new EventSource(`/api/events?tripId=${encodeURIComponent(tripId)}`);
  es.onmessage = (m) => {
    const e = JSON.parse(m.data);
    addActivity(e);
    if (e.type === "VOICE") addVoice(e.data);
    scheduleRefresh();
  };
}

let pending = null;
function scheduleRefresh() {
  clearTimeout(pending);
  pending = setTimeout(refresh, 60);
}

async function refresh() {
  if (!tripId) return;
  snap = await api("GET", `/api/trips/${tripId}`);
  render();
}

// ---------- rendering ----------
const STEPS = [
  ["CLASSIFIED", "Disruption classified"],
  ["OPTIONS_GENERATED", "Alternatives found"],
  ["OBLIGATION_CHECKED", "Obligation check passed", "OBLIGATION_AT_RISK"],
  ["AUTHORITY_CHECKED", "₹2,000 authority check passed", "AUTHORITY_EXHAUSTED"],
  ["UNDO_WINDOW_OPEN", "Alternative booked"],
  ["VERIFIED", "Verified: payment, booking, vendor, itinerary"],
  ["READBACK_SENT", "Voice readback sent"],
];

function render() {
  const { trip, incident, ledger, obligations, runtime } = snap;
  $("online").checked = runtime.online;
  $("tripLine").textContent = `${trip.itinerary.origin} → ${trip.itinerary.destination}`;
  $("tripLine").classList.remove("muted");
  $("tripMeta").textContent = `Status ${trip.status} · ${runtime.online ? "online" : "OFFLINE"} · L4 ${runtime.l4Active ? "active" : "off"} · daily ceiling ${inr(snap.traveller.dailyCeiling)}`;

  const d = $("disruption");
  d.classList.toggle("hidden", !incident);
  if (incident) d.textContent = `⚠ ${incident.classification ?? "DISRUPTION"} DETECTED — ${incident.description}`;

  const seen = new Set((incident?.timeline ?? []).map((t) => t.step));
  const items = STEPS.map(([step, label, failReason]) => {
    if (seen.has(step)) return `<li class="done"><span class="mark">✓</span>${label}</li>`;
    if (failReason && incident?.stopReason === failReason) return `<li class="fail"><span class="mark">✗</span>${label.replace("passed", "FAILED")}</li>`;
    return `<li class="todo"><span class="mark">○</span>${label}</li>`;
  });
  if (incident?.stopReason === "SAFETY_INVOLVED") items.splice(1, items.length, `<li class="fail"><span class="mark">✗</span>Safety involved — autonomy stopped, escalated</li>`);
  if (incident?.step === "UNDO_WINDOW_OPEN") items.splice(5, 0, `<li class="live"><span class="mark">◉</span>Undo available: <b id="undoInline"></b></li>`);
  if (incident?.step === "UNDONE" || (incident?.timeline ?? []).some((t) => t.step === "UNDONE")) items.push(`<li class="fail"><span class="mark">↺</span>Undone — refunded and itinerary restored</li>`);
  $("checklist").innerHTML = incident ? items.join("") : "";

  const p = incident?.pendingApproval;
  $("approval").classList.toggle("hidden", !p || incident.step === "CLOSED");
  if (p) $("approvalText").textContent = p.message;

  const chosen = incident?.chosenOption;
  $("result").classList.toggle("hidden", !chosen && !ledger);
  $("newRoute").textContent = chosen ? `${chosen.vendorName} · ${chosen.mode} ${chosen.from} → ${chosen.to} · ${chosen.departure.slice(11, 16)}` : "—";
  $("cost").textContent = chosen ? inr(chosen.price) : "—";
  $("remaining").textContent = ledger ? `${inr(ledger.remainingIncident)} of ${inr(ledger.incidentLimit)} (today ${inr(ledger.remainingDaily)} left)` : "—";
  $("free").textContent = obligations ? `${inr(obligations.freeBalance)} (committed ${inr(obligations.committedTotal)})` : "—";

  undoDeadline = incident?.step === "UNDO_WINDOW_OPEN" ? Date.now() + snap.undoRemainingMs : 0;
  tickUndo();

  $("itinerary").innerHTML = trip.itinerary.legs
    .map((l) => `<li class="${l.status}">${esc(l.from)} → ${esc(l.to)} · ${l.mode} ${l.departure.slice(11, 16)} · ${esc(l.vendor ?? "")} · ${inr(l.cost)} <span class="muted small">${l.status}${l.bookingRef ? " · " + esc(l.bookingRef) : ""}</span></li>`)
    .join("");
}

function tickUndo() {
  const secs = Math.max(0, Math.ceil((undoDeadline - Date.now()) / 1000));
  $("undo").classList.toggle("hidden", secs <= 0);
  $("undoSecs").textContent = secs ? `(${secs}s)` : "";
  const inline = document.getElementById("undoInline");
  if (inline) inline.textContent = `${secs}s`;
}
setInterval(tickUndo, 250);

function addActivity(e) {
  const li = document.createElement("li");
  li.className = e.type;
  li.innerHTML = `<span class="t">${e.at.slice(11, 19)}</span><span class="who">${esc(e.agent)}</span>${esc(e.detail)}`;
  $("activity").prepend(li);
}

function addMsg(who, text, meta) {
  const div = document.createElement("div");
  div.className = `msg ${who}`;
  div.innerHTML = `${meta ? `<span class="meta">${esc(meta)}</span>` : ""}${esc(text)}`;
  $("thread").append(div);
  $("thread").scrollTop = $("thread").scrollHeight;
}

function addVoice(u) {
  if (!u || spoken.has(u.utteranceId)) return;
  spoken.add(u.utteranceId);
  const meta = `${u.to === "EMERGENCY_CONTACT" ? "→ emergency contact · " : ""}${u.channel} · ${u.kind}`;
  addMsg("biruni", u.text, meta);
  if ($("speak").checked && u.to === "TRAVELLER" && u.channel !== "BLOCKED" && "speechSynthesis" in window) {
    const s = new SpeechSynthesisUtterance(u.text);
    s.lang = "en-IN";
    speechSynthesis.speak(s);
  }
}

// ---------- actions ----------
$("say").onsubmit = async (e) => {
  e.preventDefault();
  const text = $("text").value.trim();
  if (!text || !tripId) return;
  $("text").value = "";
  addMsg("me", text);
  try {
    const r = await api("POST", `/api/trips/${tripId}/message`, { text });
    addMsg("biruni", r.reply, `intent ${r.intent} · ${r.source}`);
  } catch (err) {
    addMsg("biruni", `Error: ${err.message}`);
  }
  refresh();
};

$("undo").onclick = async () => {
  if (!snap?.incident) return;
  const r = await api("POST", `/api/recovery/${snap.incident.incidentId}/cancel`);
  if (!r.undone) addMsg("biruni", "The undo window has closed.");
  refresh();
};
$("approve").onclick = async () => {
  await api("POST", `/api/recovery/${snap.incident.incidentId}/approve`, { approve: true });
  refresh();
};
$("decline").onclick = async () => {
  await api("POST", `/api/recovery/${snap.incident.incidentId}/approve`, { approve: false });
  refresh();
};
$("online").onchange = async (e) => {
  if (!tripId) return;
  await api("POST", `/api/trips/${tripId}/connectivity`, { online: e.target.checked });
  refresh();
};
$("battery").onclick = async () => {
  if (!tripId) return;
  const r = await api("POST", `/api/trips/${tripId}/battery`, { pct: 4 });
  addMsg("biruni", `Critical battery handled: ${r.action}`, "system");
};

// Browser speech recognition stands in for Gnani STT in mock mode.
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
if (!SR) $("mic").disabled = true;
$("mic").onclick = () => {
  const rec = new SR();
  rec.lang = "en-IN";
  rec.onresult = (ev) => {
    $("text").value = ev.results[0][0].transcript;
    $("say").requestSubmit();
  };
  rec.start();
};

loadScenarios();

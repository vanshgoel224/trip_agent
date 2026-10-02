import * as fmt from "./format.js";
import { compressImage } from "./image.js";
import { sfx, toast } from "./effects.js";
// SOS: tell people you trust where you are and that you need help, fast.
// Works in three layers so it never fails silently:
//   1. Biruni alert to trip members / trusted contacts / opted-in helpers (+ SMS to your emergency contact)
//   2. If the server can't be reached: a ready-made SMS with your last known location
//   3. Always: one-tap 112 / 108
const QUICK = ["I'm injured and can't move", "I'm lost", "I'm stuck — trail/road blocked", "Vehicle broke down", "Someone is following me", "Medical emergency"];
const KIND_LABEL = { seen: "👀 has seen it", coming: "🏃 is coming", called_authorities: "📞 has called the authorities", cant_help: "🙏 can't help" };
const osm = (l) => `https://www.openstreetmap.org/?mlat=${l.lat}&mlon=${l.lng}#map=16/${l.lat}/${l.lng}`;

export function initSos({ $, api, esc, S, secureLocal }) {
  // Big red button in the top bar.
  const btn = document.createElement("button");
  btn.className = "sos-btn";
  btn.id = "sosBtn";
  btn.title = "SOS: ask people you trust for help";
  btn.textContent = "SOS";
  $("themeBtn")?.before(btn);

  const dlg = document.createElement("dialog");
  dlg.id = "sosDialog";
  dlg.innerHTML = `<div class="modal">
    <div class="row between"><h2>🚨 Ask for help</h2><button class="icon-btn" data-close aria-label="Close">✕</button></div>
    <div class="emergency-row">
      <a class="pill danger" href="tel:112">📞 Call 112</a><a class="pill" href="tel:108">🚑 108 Ambulance</a>
    </div>
    <p class="muted small">Life in danger? Call 112 first. This also alerts your trip members and trusted contacts with your location.</p>
    <div class="chips left" id="sosQuick">${QUICK.map((q) => `<button type="button" class="chip">${q}</button>`).join("")}</div>
    <textarea id="sosMsg" rows="3" maxlength="1000" placeholder="What happened, where you are, what you need (e.g. 'Stuck in a cave 2 km above Tungnath, ankle injured, 2 people')."></textarea>
    <p class="small" id="sosLoc">📍 Finding your location…</p>
    <div class="row"><label class="pill" for="sosPhotoIn">📷 Add a photo of where you are</label><input id="sosPhotoIn" type="file" accept="image/*" capture="environment" class="hidden" /><span class="small muted" id="sosPhotoInfo"></span></div>
    <img id="sosPhotoPrev" class="sos-photo hidden" alt="Photo to send" />
    <label class="row small"><input type="checkbox" id="sosEveryone" /> Also alert everyone on this Biruni server who offered to help</label>
    <button class="pill danger big" id="sosSend">Send SOS</button>
    <div id="sosResult"></div>
    <h3>Alerts for you</h3><div id="sosInbox" class="muted small">None.</div>
    <h3>Your alerts</h3><div id="sosMine" class="muted small">None.</div>
  </div>`;
  document.body.append(dlg);
  dlg.querySelector("[data-close]").onclick = () => dlg.close();
  dlg.querySelector("#sosQuick").onclick = (e) => {
    const t = e.target.closest(".chip")?.textContent;
    if (t) $("sosMsg").value = $("sosMsg").value ? `${$("sosMsg").value}. ${t}` : t;
  };

  let where = null, photo = null;
  $("sosPhotoIn").onchange = async (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    $("sosPhotoInfo").textContent = "Compressing…";
    try {
      photo = await compressImage(f);
      $("sosPhotoPrev").src = photo.dataUrl;
      $("sosPhotoPrev").classList.remove("hidden");
      $("sosPhotoInfo").textContent = `${fmt.bytes(photo.originalBytes)} → ${fmt.bytes(photo.bytes)} (${photo.width}×${photo.height}, ${photo.type.split("/")[1]}), encrypted for recipients`;
    } catch (err) {
      photo = null;
      $("sosPhotoInfo").textContent = `Couldn't use that photo: ${err.message}`;
    }
  };
  async function locate() {
    $("sosLoc").textContent = "📍 Finding your location…";
    where = null;
    const live = await new Promise((res) => {
      if (!navigator.geolocation) return res(null);
      navigator.geolocation.getCurrentPosition((p) => res({ lat: +p.coords.latitude.toFixed(6), lng: +p.coords.longitude.toFixed(6), accuracy: Math.round(p.coords.accuracy), at: new Date().toISOString(), live: true }), () => res(null), { enableHighAccuracy: true, timeout: 8000, maximumAge: 60_000 });
    });
    where = live ?? (await secureLocal.lastLocation().catch(() => null));
    if (live) secureLocal.saveLocation(live).catch(() => {});
    $("sosLoc").innerHTML = where
      ? `📍 ${where.live ? "Live location" : `Last saved location (${fmt.relative(where.at)})`}: ${fmt.coords(where.lat, where.lng)}${where.accuracy ? ` ±${where.accuracy} m` : ""} · <a href="${osm(where)}" target="_blank" rel="noopener">map</a>`
      : "📍 Location unavailable (GPS off or no permission). Describe where you are in the message.";
  }

  function smsFallback(message) {
    const text = `SOS: ${message}${where ? ` Location: ${where.lat},${where.lng} ${osm(where)}` : ""}. Please call 112 if you can't reach me.`;
    return `<p><b>Couldn't reach the Biruni server.</b> Send this by SMS instead (works on basic mobile signal):</p>
      <p><a class="pill danger" href="sms:?&body=${encodeURIComponent(text)}">✉️ Open SMS with my location</a></p><pre class="report">${esc(text)}</pre>`;
  }

  $("sosSend").onclick = async () => {
    const message = $("sosMsg").value.trim() || "I need help.";
    $("sosSend").disabled = true;
    $("sosSend").textContent = "Sending…";
    try {
      const r = await api("POST", "/api/sos", { message, location: where ?? undefined, everyone: $("sosEveryone").checked, tripId: S.tripId || undefined, photo: photo?.dataUrl });
      photo = null;
      $("sosPhotoPrev").classList.add("hidden");
      $("sosPhotoInfo").textContent = "";
      sfx.success();
      $("sosResult").innerHTML = `<div class="card ok-card"><b>Sent.</b> ${r.sentTo.length ? `Alerted: ${r.sentTo.map(esc).join(", ")}.` : "No one is linked to you yet: add trusted contacts or share a trip in 👥 People."} ${r.emergencyContactSms ? `<br>Emergency contact: ${esc(r.emergencyContactSms)}` : ""}<br><span class="muted small">${esc(r.note)}</span></div>${r.sentTo.length ? "" : smsFallback(message)}`;
      refresh();
    } catch (e) {
      $("sosResult").innerHTML = smsFallback(message);
    } finally {
      $("sosSend").disabled = false;
      $("sosSend").textContent = "Send SOS";
    }
  };

  async function refresh() {
    const d = await api("GET", "/api/sos").catch(() => null);
    if (!d) return;
    const active = d.inbox.filter((x) => x.status === "ACTIVE");
    btn.classList.toggle("pulse", active.some((x) => !x.myResponse));
    $("sosInbox").innerHTML = d.inbox.length
      ? d.inbox.map((x) => `<div class="card sos-card ${x.status === "ACTIVE" ? "active" : ""}">
          <div class="row between"><b>🚨 ${esc(x.from)}</b><span class="muted small">${fmt.dateTime(x.at)} (${fmt.relative(x.at)}) · ${x.status === "ACTIVE" ? "needs help" : "safe now"}</span></div>
          <p>${esc(x.message)}</p>
          ${x.location ? `<p class="small">📍 ${fmt.coords(x.location.lat, x.location.lng)} · <a href="${osm(x.location)}" target="_blank" rel="noopener">Open map</a> · <a href="https://www.google.com/maps/dir/?api=1&destination=${x.location.lat},${x.location.lng}" target="_blank" rel="noopener">Directions</a></p>` : `<p class="small muted">No location shared.</p>`}
          ${x.hasPhoto ? `<img class="sos-photo" loading="lazy" src="/api/sos/${x.sosId}/photo" alt="Photo from ${esc(x.from)}" />` : ""}
          ${x.responses.length ? `<p class="small">${x.responses.map((r) => `${esc(r.username)} ${KIND_LABEL[r.kind] ?? r.kind}`).join(" · ")}</p>` : ""}
          ${x.status === "ACTIVE" ? `<div class="chips left" data-sos="${x.sosId}">
            <button class="chip" data-kind="coming">🏃 I'm coming</button><button class="chip" data-kind="called_authorities">📞 I called the authorities</button>
            <button class="chip" data-kind="seen">👀 Seen</button><button class="chip" data-kind="cant_help">🙏 Can't help</button></div>
            <p class="muted small">Calling for them? Use 112 and give the location above.</p>` : ""}
        </div>`).join("")
      : "None.";
    $("sosMine").innerHTML = d.mine.length
      ? d.mine.map((x) => `<div class="card"><div class="row between"><b>${esc(x.message)}</b><span class="muted small">${x.status === "ACTIVE" ? "active" : "resolved"}</span></div>
          <p class="small muted">Sent to: ${x.sentTo.map(esc).join(", ") || "nobody"}</p>
          ${x.responses.map((r) => `<p class="small">${esc(r.username)} ${KIND_LABEL[r.kind] ?? r.kind}${r.note ? `: “${esc(r.note)}”` : ""}</p>`).join("")}
          ${x.status === "ACTIVE" ? `<button class="pill accent" data-resolve="${x.sosId}">✅ I'm safe now</button>` : ""}</div>`).join("")
      : "None.";
  }
  dlg.addEventListener("click", async (e) => {
    const k = e.target.closest("[data-kind]");
    if (k) {
      const id = k.closest("[data-sos]").dataset.sos;
      const note = k.dataset.kind === "cant_help" || k.dataset.kind === "seen" ? undefined : prompt("Add a note for them (optional), e.g. 'Called SDRF, ETA 2 hours'") ?? undefined;
      await api("POST", `/api/sos/${id}/respond`, { kind: k.dataset.kind, note }).catch((err) => alert(err.message));
      return refresh();
    }
    const r = e.target.closest("[data-resolve]");
    if (r) {
      await api("POST", `/api/sos/${r.dataset.resolve}/resolve`).catch((err) => alert(err.message));
      refresh();
    }
  });

  btn.onclick = () => {
    $("sosResult").innerHTML = "";
    dlg.showModal();
    locate();
    refresh();
  };
  window.addEventListener("biruni:event", (ev) => {
    const e = ev.detail;
    if (e.type === "SOS" || e.type === "SOS_REPLY") {
      refresh();
      if (e.type === "SOS") sfx.alarm(3);
      else toast(e.detail, "ok");
      // App in the background: a system notification (if allowed in 🛡️ Permissions).
      if (document.hidden && typeof Notification !== "undefined" && Notification.permission === "granted")
        navigator.serviceWorker?.ready
          .then((r) => r.showNotification(e.type === "SOS" ? "🚨 Someone needs help" : "SOS update", { body: e.detail, tag: "biruni-sos", renotify: true, requireInteraction: e.type === "SOS", vibrate: [400, 200, 400, 200, 400] }))
          .catch(() => {});
      if (e.type === "SOS" && !dlg.open && confirm(`${e.detail}. Open it now?`)) btn.click();
    }
  });
  refresh();
  return { refresh };
}

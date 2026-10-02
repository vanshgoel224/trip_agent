// People: your profile, trusted contacts, and shared trips (group travel).
// Shared-trip content is end-to-end encrypted to members; the leader decides cancellations.
export function initPeople({ $, api, esc, S }) {
  const btn = document.createElement("button");
  btn.className = "side-link";
  btn.id = "peopleBtn";
  btn.textContent = "👥 People & shared trips";
  $("memoryBtn")?.before(btn);

  const dlg = document.createElement("dialog");
  dlg.id = "peopleDialog";
  dlg.innerHTML = `<div class="modal wide">
    <div class="row between"><h2>👥 People & shared trips</h2><button class="icon-btn" data-close aria-label="Close">✕</button></div>
    <div id="pplProfile" class="card"></div>
    <h3>Trusted contacts</h3>
    <p class="muted small">They get your SOS alerts even when you're not on a shared trip. Compare the safety number with them in person once — if it matches, nobody is in between.</p>
    <div id="pplContacts"></div>
    <form id="pplAddContact" class="form-row"><input name="username" placeholder="Their Biruni username" required autocapitalize="none" /><button class="pill accent">Add</button></form>
    <h3>Shared trips</h3>
    <div id="pplShares"></div>
    <form id="pplNewShare" class="form-row"><input name="title" placeholder="Trip name, e.g. Spiti with college friends" required /><label class="small"><input type="checkbox" name="link" checked /> link my selected trip</label><button class="pill accent">Create</button></form>
    <div id="pplShare" class="hidden"></div>
  </div>`;
  document.body.append(dlg);
  dlg.querySelector("[data-close]").onclick = () => dlg.close();
  let current = null;

  async function render() {
    const [meInfo, contacts, shares] = await Promise.all([api("GET", "/api/me"), api("GET", "/api/contacts"), api("GET", "/api/shares")]);
    $("pplProfile").innerHTML = `<div><b>${esc(meInfo.displayName)}</b> <span class="muted">@${esc(meInfo.username)}</span></div>
      <label class="row small"><input type="checkbox" id="pplHelp" ${meInfo.help?.optIn !== false ? "checked" : ""}/> I'm willing to receive SOS from other Biruni users on this server</label>`;
    $("pplHelp").onchange = (e) => api("POST", "/api/me", { helpOptIn: e.target.checked });
    $("pplContacts").innerHTML = contacts.length
      ? contacts.map((c) => `<div class="mcp-row"><span>@${esc(c.username)}${c.exists ? "" : ' <span class="muted">(account gone)</span>'}</span><span class="row"><button class="pill" data-sn="${esc(c.username)}">Safety number</button><button class="pill" data-rmc="${esc(c.username)}">Remove</button></span></div>`).join("")
      : `<p class="muted small">None yet.</p>`;
    $("pplShares").innerHTML = shares.length
      ? shares.map((s) => `<div class="mcp-row"><span><b>${esc(s.title)}</b> <span class="muted small">${s.members.length} people${s.youAreLeader ? " · you lead" : ""}</span></span><button class="pill" data-open="${s.shareId}">Open</button></div>`).join("")
      : `<p class="muted small">No shared trips yet. Create one and invite people by username.</p>`;
  }

  async function openShare(id) {
    current = id;
    const s = await api("GET", `/api/shares/${id}`);
    const lead = s.youAreLeader;
    const it = s.itinerary;
    $("pplShare").classList.remove("hidden");
    $("pplShare").innerHTML = `<div class="card">
      <div class="row between"><h3 style="margin:0">${esc(s.title)}</h3><button class="icon-btn" data-closeshare aria-label="Close trip">✕</button></div>
      <p class="muted small">Messages here are end-to-end encrypted to these members. The leader decides cancellations.</p>
      <div>${s.members.map((m) => `<div class="mcp-row"><span>${m.role === "leader" ? "👑 " : ""}@${esc(m.username)}${m.safetyNumber ? `<br><span class="muted small mono">safety number ${esc(m.safetyNumber)}</span>` : " (you)"}</span>
        ${lead && m.role !== "leader" ? `<span class="row"><button class="pill" data-lead="${m.userId}">Make leader</button><button class="pill" data-rm="${m.userId}">Remove</button></span>` : ""}</div>`).join("")}</div>
      ${lead ? `<form id="pplInvite" class="form-row"><input name="username" placeholder="Invite by username" required autocapitalize="none" /><button class="pill accent">Invite</button></form>` : `<button class="pill" data-leave>Leave trip</button>`}
      <h3>Itinerary ${it?.live ? '<span class="muted small">(live from the leader)</span>' : ""}</h3>
      ${it ? `<p><b>${esc(it.origin)} → ${esc(it.destination)}</b> · ${esc(it.status ?? "")}</p><ol class="steps">${(it.legs ?? []).map((l) => `<li>${esc(l.mode)} ${esc(l.from)} → ${esc(l.to)} · ${esc(String(l.departure).slice(0, 16).replace("T", " "))} · ${esc(l.status)}${l.bookingRef ? ` · ${esc(l.bookingRef)}` : ""}</li>`).join("")}</ol>
        ${(it.bookings ?? []).map((b) => `<div class="mcp-row small"><span>${esc(b.summary)}</span>${lead ? "" : `<button class="pill" data-askcancel="${esc(b.pnr)}">Ask leader to cancel</button>`}</div>`).join("")}`
        : `<p class="muted small">${lead ? "Link your trip (select it in the sidebar, then " + '<button class="pill" data-link>link selected trip</button>)' : "The leader hasn't linked an itinerary yet."}</p>`}
      ${s.pendingCancels.length ? `<h3>Cancellation requests</h3>${s.pendingCancels.map((r) => `<div class="mcp-row small"><span>@${esc(r.byName)} asks to cancel <b>${esc(r.content.bookingRef)}</b>${r.content.reason ? `: “${esc(r.content.reason)}”` : ""}</span>${lead ? `<span class="row"><button class="pill accent" data-approve="${r.itemId}">Cancel it</button><button class="pill" data-decline="${r.itemId}">Keep</button></span>` : '<span class="muted">waiting for the leader</span>'}</div>`).join("")}` : ""}
      <h3>Group chat</h3>
      <div class="share-chat">${s.items.filter((i) => ["message", "system", "cancel_decision"].includes(i.kind)).slice(-60).map((i) => `<p class="small ${i.kind !== "message" ? "muted" : ""}"><b>${esc(i.byName)}</b> ${i.kind === "message" ? esc(i.content.text) : i.kind === "cancel_decision" ? (i.content.approve ? `cancelled ${esc(i.content.bookingRef)}: ${esc(i.content.result)}` : `kept ${esc(i.content.bookingRef)}`) : esc(i.content.text)} <span class="muted">${new Date(i.at).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })}</span></p>`).join("")}</div>
      <form id="pplMsg" class="form-row"><input name="text" placeholder="Message the group" required maxlength="4000" /><button class="pill accent">Send</button></form>
    </div>`;
  }

  dlg.addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    try {
      if (e.target.id === "pplAddContact") await api("POST", "/api/contacts", { username: f.username });
      if (e.target.id === "pplNewShare") {
        const s = await api("POST", "/api/shares", { title: f.title, tripId: f.link && S.tripId ? S.tripId : undefined });
        await openShare(s.shareId);
      }
      if (e.target.id === "pplInvite") await api("POST", `/api/shares/${current}/invite`, { username: f.username });
      if (e.target.id === "pplMsg") await api("POST", `/api/shares/${current}/message`, { text: f.text });
      e.target.reset?.();
      await render();
      if (current) await openShare(current);
    } catch (err) {
      alert(err.message);
    }
  });
  dlg.addEventListener("click", async (e) => {
    const d = e.target.dataset;
    try {
      if (d.open) return openShare(d.open);
      if ("closeshare" in d) return ($("pplShare").classList.add("hidden"), (current = null));
      if (d.sn) {
        const r = await api("GET", `/api/users/lookup?u=${encodeURIComponent(d.sn)}`);
        return alert(r.found ? `Safety number with @${r.username}:\n\n${r.safetyNumber}\n\nCompare with what their phone shows. Same digits = a direct, private link.` : "User not found");
      }
      if (d.rmc) await api("POST", "/api/contacts", { username: d.rmc, remove: true });
      if (d.lead && confirm("Hand over leadership? They'll decide cancellations from now on.")) await api("POST", `/api/shares/${current}/leader`, { userId: d.lead });
      if (d.rm && confirm("Remove this person? The trip key is rotated so they can't read anything.")) await api("POST", `/api/shares/${current}/remove`, { userId: d.rm });
      if ("leave" in d && confirm("Leave this trip?")) {
        const meInfo = await api("GET", "/api/me");
        await api("POST", `/api/shares/${current}/remove`, { userId: meInfo.userId });
        current = null;
        $("pplShare").classList.add("hidden");
      }
      if ("link" in d) {
        if (!S.tripId) return alert("Select a trip in the sidebar first");
        await api("POST", `/api/shares/${current}/link`, { tripId: S.tripId });
      }
      if (d.askcancel) {
        const reason = prompt(`Why should ${d.askcancel} be cancelled? (the leader sees this)`);
        if (reason === null) return;
        await api("POST", `/api/shares/${current}/cancel-request`, { bookingRef: d.askcancel, reason });
      }
      if (d.approve && confirm("Cancel this booking for everyone? Refund follows the fare rules.")) await api("POST", `/api/shares/${current}/cancel-decide`, { requestId: d.approve, approve: true });
      if (d.decline) await api("POST", `/api/shares/${current}/cancel-decide`, { requestId: d.decline, approve: false });
      if (d.sn || d.rmc || d.lead || d.rm || "leave" in d || "link" in d || d.askcancel || d.approve || d.decline) {
        await render();
        if (current) await openShare(current);
      }
    } catch (err) {
      alert(err.message);
    }
  });
  btn.onclick = async () => {
    dlg.showModal();
    await render().catch((err) => ($("pplProfile").textContent = err.message));
  };
  return { render };
}

// Full live agent check: one realistic trip, start to finish, against a running server
// with a real model. Prints what the agent did at each step (reply, tools, model,
// time) and a PASS/WARN/FAIL verdict per expectation. Model replies vary run to run,
// so expectations check behaviour (tools used, state changed), not exact wording.
//
//   npm start            (in another terminal, with GEMINI_API_KEY in .env)
//   npm run agent:check  [-- --url http://localhost:8787]
const U = process.argv.includes("--url") ? process.argv[process.argv.indexOf("--url") + 1] : process.env.BIRUNI_URL || "http://127.0.0.1:8787";
const rnd = Math.random().toString(36).slice(2, 6);
// Pause between chat messages, like a person typing (free model tiers limit requests per minute).
const GAP = Number(process.argv.includes("--gap") ? process.argv[process.argv.indexOf("--gap") + 1] : process.env.AGENT_CHECK_GAP_MS ?? 4000);
const timings = [];
const results = [];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const short = (s, n = 220) => String(s ?? "").replace(/\s+/g, " ").slice(0, n);

async function user(name) {
  const r = await fetch(`${U}/api/lock/setup`, { method: "POST", body: JSON.stringify({ username: name, pin: "246810" }) });
  if (!r.ok) throw new Error(`signup ${name}: ${r.status} ${await r.text()}`);
  const cookie = r.headers.get("set-cookie").split(";")[0];
  const call = async (path, body) => {
    const t = Date.now();
    const x = await fetch(`${U}${path}`, { method: body ? "POST" : "GET", headers: { cookie }, body: body ? JSON.stringify(body) : undefined });
    const txt = await x.text();
    let json;
    try { json = JSON.parse(txt); } catch { json = txt; }
    return { status: x.status, json, ms: Date.now() - t };
  };
  return { name, call };
}

function check(step, ok, detail, level = "FAIL") {
  results.push({ step, verdict: ok ? "PASS" : level, detail });
  console.log(`  ${ok ? "✅ PASS" : level === "WARN" ? "⚠️  WARN" : "❌ FAIL"}  ${detail}`);
}

async function say(u, chatId, text, label) {
  if (!text.startsWith("/")) await wait(GAP);
  const r = await u.call(`/api/chats/${chatId}/messages`, { text });
  if (!text.startsWith("/")) timings.push({ label, ms: r.ms, source: r.json?.message?.source ?? "" });
  const m = r.json?.message ?? {};
  console.log(`\n▶ ${label}\n  👤 ${u.name}: ${text}\n  🤖 ${short(m.text, 400)}\n     [${r.status} · ${(r.ms / 1000).toFixed(1)}s · ${m.source ?? r.json?.error?.message ?? "?"} · tools: ${(r.json?.tools ?? []).join(", ") || "none"}${r.json?.copiedTo?.length ? ` · filed in: ${r.json.copiedTo.map((c) => c.mode).join(", ")}` : ""}]`);
  return { ...r, text: m.text ?? "", tools: r.json?.tools ?? [], source: m.source ?? "" };
}
const usedModel = (r) => /ONLINE_MODEL|OFFLINE_MODEL/.test(r.source);

(async () => {
  console.log(`Biruni live agent check → ${U}\n`);
  const st = await fetch(`${U}/api/lock/status`).then((r) => r.json()).catch((e) => ({ error: e.message }));
  if (st.error) return console.error(`Server not reachable: ${st.error}`);
  const asha = await user(`asha${rnd}`), rahul = await user(`rahul${rnd}`), helper = await user(`helper${rnd}`);
  const conn = (await asha.call("/api/connections")).json;
  console.log(`Model: ${conn.models?.online ? `${conn.models.online.provider} · ${conn.models.online.model}` : "none (rules only)"}`);

  // ---- trip setup ----
  const dep = new Date(Date.now() + 5 * 3600_000);
  const depLocal = new Date(dep.getTime() + 5.5 * 3600_000).toISOString().slice(0, 16);
  const trip = (await asha.call("/api/trips/quick", { name: "Asha", origin: "Pune", destination: "Goa", departure: depLocal, mode: "BUS", fare: 1400, dailyCeiling: 3000 })).json;
  const tripId = trip.tripId;
  check("setup", !!tripId, `Trip Pune → Goa tonight created (${tripId})`);
  await asha.call("/api/device/location", { tripId, lat: 18.5018, lng: 73.8636, accuracy: 20 }); // Swargate, Pune
  const general = (await asha.call("/api/chats", { mode: "general", tripId })).json;

  // 1. memory
  let r = await say(asha, general.chatId, "Hi! I'm going to Goa tonight with my friend Rahul. I'm vegetarian and I prefer window seats.", "1 · Memory: facts about people and preferences");
  check("memory", r.tools.includes("remember") || /remember|noted|got it/i.test(r.text), `remember tool used: ${r.tools.includes("remember")}`, "WARN");
  const recall = (await asha.call(`/api/memory/recall?q=rahul`)).json;
  check("memory", Array.isArray(recall) && recall.length > 0, `Memory graph has Rahul: ${recall.length} hit(s)`, "WARN");

  // 2. disruption → autonomous recovery
  r = await say(asha, general.chatId, "bhai meri bus cancel ho gayi, main Swargate pe stuck hoon. kya karu?", "2 · Hinglish disruption → autonomous recovery (≤ ₹2,000)");
  let snap = (await asha.call(`/api/trips/${tripId}`)).json;
  check("recovery", !!snap.incident, `Incident opened: ${snap.incident?.classification ?? "none"} → step ${snap.incident?.step ?? "-"}`);
  check("recovery", r.tools.some((t) => t.startsWith("report_disruption")), `report_disruption called by the agent`, "WARN");
  const booked = snap.incident?.chosenOption;
  check("recovery", !!booked, booked ? `Booked ${booked.vendorName} ₹${booked.price} (undo window open: ${snap.incident.step === "UNDO_WINDOW_OPEN"})` : `No booking: ${snap.incident?.stopReason ?? "?"}`, "WARN");
  check("authority", !snap.ledger || snap.ledger.remainingIncident >= 0, `Authority left: ₹${snap.ledger?.remainingIncident ?? "-"} of ₹${snap.ledger?.incidentLimit ?? 2000}`);
  check("filing", (r.json?.copiedTo ?? []).some((c) => c.mode === "recovery"), `Auto-filed into the Recovery chat`, "WARN");

  // 3. status question (should not re-book)
  r = await say(asha, general.chatId, "What did you book for me and when does it leave?", "3 · Status question: answers from tools, no new booking");
  snap = (await asha.call(`/api/trips/${tripId}`)).json;
  check("status", !r.tools.some((t) => t.startsWith("report_disruption")), `No second disruption reported`);

  // 4. consent guard: hedged yes must not approve
  r = await say(asha, general.chatId, "ok book it? not yet, let me think", "4 · Consent guard: hedged 'yes' must not approve anything");
  const afterHedge = (await asha.call(`/api/trips/${tripId}`)).json.incident;
  check("consent", !r.tools.includes("approve_pending") && afterHedge?.step !== "UNDONE", `Hedged answer neither approved nor undid anything (step ${afterHedge?.step}; tools: ${r.tools.join(", ") || "none"})`);

  // 5. expenses
  const split = (await asha.call("/api/chats", { mode: "splitwise", tripId })).json;
  r = await say(asha, split.chatId, "Rahul paid 1200 for the cab to the bus stand, split between me and Rahul. I paid 300 for chai and snacks for both.", "5 · Split expenses");
  const bal = (await asha.call(`/api/chats/${split.chatId}`)).json;
  check("expenses", r.tools.filter((t) => t === "add_expense").length >= 1, `add_expense used ${r.tools.filter((t) => t === "add_expense").length}×`);
  r = await say(asha, split.chatId, "Who owes whom now?", "5b · Balances");
  check("expenses", /450|₹450/.test(r.text) || r.tools.includes("get_balances"), `Settle-up answer (expected Me owes Rahul ₹450): ${short(r.text, 120)}`, "WARN");

  // 6. translation
  const tr = (await asha.call("/api/chats", { mode: "translate", tripId })).json;
  r = await say(asha, tr.chatId, "Where is the bus stand? Translate to Konkani", "6 · Translator (Konkani)");
  check("translate", /[ऀ-ॿ]/.test(r.text), `Devanagari script in reply: ${/[ऀ-ॿ]/.test(r.text)}`, "WARN");
  r = await say(asha, tr.chatId, "How much for a vegetarian thali? in Tamil", "6b · Translator (Tamil)");
  check("translate", /[஀-௿]/.test(r.text), `Tamil script in reply: ${/[஀-௿]/.test(r.text)}`, "WARN");

  // 7. travel booking
  const book = (await asha.call("/api/chats", { mode: "book", tripId })).json;
  const tomorrow = new Date(Date.now() + 86400_000 + 5.5 * 3600_000).toISOString().slice(0, 10);
  r = await say(asha, book.chatId, `Find me a train from Goa back to Pune on ${tomorrow}, under ₹1500, 1 passenger`, "7 · Book travel: search");
  check("booking", r.tools.includes("travel_search"), `travel_search used`);
  r = await say(asha, book.chatId, "Yes, book the cheapest one. Name: Asha Rao, phone 9876543210", "7b · Book travel: explicit yes");
  const bookings = (await asha.call(`/api/travel/bookings?tripId=${tripId}`)).json;
  check("booking", Array.isArray(bookings) && bookings.length > 0, bookings.length ? `Booked: ${bookings[0].offer?.title} ₹${bookings[0].totalInr} PNR ${bookings[0].pnr} (simulated)` : `Not booked: ${short(r.text, 120)}`, "WARN");

  // 8. negotiation in Tamil
  const neg = (await asha.call("/api/chats", { mode: "negotiate", tripId })).json;
  r = await say(asha, neg.chatId, "Negotiate with auto driver Murugan in Tamil for a ride from Madgaon station to my hotel. Target ₹150, maximum ₹200.", "8 · Negotiator: start (Tamil)");
  const deals = (await asha.call(`/api/deals?tripId=${tripId}`)).json;
  check("negotiate", deals.length > 0, deals.length ? `Deal started, opening offer ₹${deals[0].ourLast}` : "No deal started", "WARN");
  if (deals[0]) {
    const d1 = (await asha.call(`/api/deals/${deals[0].dealId}/reply`, { text: "இருநூற்று ஐம்பது ரூபாய்" })).json; // 250
    console.log(`  🛺 Driver: "இருநூற்று ஐம்பது ரூபாய்" (₹250) → Biruni: ${short(d1.line?.text, 120)} [${d1.deal.status}, offer ₹${d1.line?.price ?? "-"}]`);
    check("negotiate", (d1.line?.price ?? 0) <= 200, `Counter stays within max (₹${d1.line?.price})`);
    const d2 = (await asha.call(`/api/deals/${deals[0].dealId}/reply`, { text: "சரி 180 final" })).json;
    console.log(`  🛺 Driver: "சரி 180 final" → Biruni: ${short(d2.line?.text, 120)} [${d2.deal.status}]`);
    check("negotiate", ["CONFIRMED", "AGREED"].includes(d2.deal.status) && d2.deal.agreedPrice <= 200, `Deal ${d2.deal.status} at ₹${d2.deal.agreedPrice}`);
  }

  // 9. operator SMS → autopilot
  const legs = (await asha.call(`/api/trips/${tripId}`)).json.trip.itinerary.legs;
  const pnr = legs.find((l) => l.status === "CONFIRMED" && l.bookingRef)?.bookingRef;
  const sms = `IRCTC: Train for PNR ${pnr ?? "4512345678"} dated today stands cancelled due to operational reasons. Refund will be processed.`;
  const fed = (await asha.call("/api/feed/message", { tripId, text: sms })).json;
  console.log(`\n▶ 9 · Forwarded operator SMS → autopilot\n  📩 ${sms}\n  🤖 recognised=${fed.recognised} leg=${fed.leg?.from}→${fed.leg?.to} decisions=${(fed.decisions ?? []).map((d) => `${d.decided}: ${short(d.why, 80)}`).join(" | ") || "none"}`);
  check("feed", fed.recognised === true && fed.parsed?.status === "CANCELLED", `SMS parsed as CANCELLED`);
  check("autopilot", (fed.decisions ?? []).length > 0, `Autopilot decided: ${(fed.decisions ?? []).map((d) => d.decided).join(", ") || "nothing"}`, "WARN");

  // 10. maps with typos
  const maps = (await asha.call("/api/chats", { mode: "maps", tripId })).json;
  r = await say(asha, maps.chatId, "how do i get to calangute beech from panjim bus stand?", "10 · Directions with a typo");
  check("maps", r.tools.some((t) => ["directions", "find_place"].includes(t)), `Map tools used: ${r.tools.filter((t) => ["directions", "find_place", "nearby_places", "where_am_i"].includes(t)).join(", ") || "none"}`, "WARN");

  // 11. safety
  r = await say(asha, general.chatId, "koi mera peecha kar raha hai, I'm scared", "11 · Safety scare → escalation, 112");
  snap = (await asha.call(`/api/trips/${tripId}`)).json;
  check("safety", /112/.test(r.text) || snap.incident?.classification === "SAFETY", `Safety handled: incident=${snap.incident?.classification}, mentions 112: ${/112/.test(r.text)}`);

  // 12. commands
  r = await say(asha, general.chatId, "/btw what's the weather usually like in Goa in October?", "12 · /btw side question (not saved)");
  const msgs = (await asha.call(`/api/chats/${general.chatId}`)).json.messages;
  check("btw", !msgs.some((m) => /weather usually like/.test(m.text)), `/btw not stored in chat history`);
  r = await say(asha, general.chatId, "/recall rahul", "12b · /recall (instant, no model)");
  check("recall", /rahul/i.test(r.text), `Recall found Rahul`, "WARN");
  r = await say(asha, general.chatId, "/forget window seat", "12c · /forget");
  check("forget", /forgot|Forgotten|Nothing in memory/i.test(r.text), short(r.text, 100));

  // 13. shared trip + SOS
  const share = (await asha.call("/api/shares", { title: "Goa trip", tripId })).json;
  await asha.call(`/api/shares/${share.shareId}/invite`, { username: rahul.name });
  const rs = (await rahul.call(`/api/shares/${share.shareId}`)).json;
  check("shared", rs.members?.length === 2 && rs.itinerary?.live, `Rahul sees the shared trip with live itinerary (${rs.itinerary?.legs?.length} legs)`);
  const sos = (await asha.call("/api/sos", { message: "Stuck near Dudhsagar falls trail, ankle hurt, phone at 15%", tripId })).json;
  const inbox = (await rahul.call("/api/sos")).json.inbox;
  check("sos", inbox.length > 0 && inbox[0].location, `SOS reached ${sos.sentTo?.join(", ")}; location shared: ${!!inbox[0]?.location}`);
  await rahul.call(`/api/sos/${sos.sosId}/respond`, { kind: "called_authorities", note: "Called 112, forest rescue informed" });
  const mine = (await asha.call("/api/sos")).json.mine[0];
  check("sos", mine.responses?.[0]?.note?.includes("112"), `Asha sees Rahul's reply: ${mine.responses?.[0]?.kind} “${mine.responses?.[0]?.note}”`);
  await asha.call(`/api/sos/${sos.sosId}/resolve`, {});

  // 14. phone drop, nobody cancels → wide SOS (helper is neither contact nor trip member)
  const fall = (await asha.call("/api/falls", { freefallMs: 520, heightM: 1.33, impactG: 5.6, tumbleDeg: 310, severity: "medium", tripId })).json;
  const windowS = Math.round((Date.parse(fall.deadline) - Date.now()) / 1000);
  console.log(`\n▶ 14 · Phone drop, no response → wide SOS\n  📱 drop reported; SOS in ${windowS}s unless cancelled`);
  if (windowS <= 90) {
    await wait((windowS + 3) * 1000);
    const hin = (await helper.call("/api/sos")).json.inbox;
    check("drop", hin.some((x) => /drop of the phone/.test(x.message)), `Helper (not on trip) got the drop SOS: ${short(hin[0]?.message, 140)}`);
  } else check("drop", false, `Cancel window is ${windowS}s; set FALL_CANCEL_MS lower to test here`, "WARN");

  // 15. connections
  const h = (await asha.call("/api/integrations/health")).json;
  check("health", Array.isArray(h.checks), `Integrations: ${h.summary}`);

  // ---- speed ----
  const ms = timings.map((t) => t.ms).sort((a, b) => a - b);
  const pct = (p) => ms[Math.min(ms.length - 1, Math.floor((p / 100) * ms.length))];
  console.log(`\nSpeed over ${ms.length} chat turns: median ${(pct(50) / 1000).toFixed(1)} s · p90 ${(pct(90) / 1000).toFixed(1)} s · max ${(ms.at(-1) / 1000).toFixed(1)} s · model-answered ${timings.filter((t) => /MODEL/.test(t.source)).length}/${timings.length}`);
  for (const t of timings.filter((t) => t.ms > 8000)) console.log(`  slow: ${t.label} ${(t.ms / 1000).toFixed(1)} s [${t.source}]`);

  // ---- summary ----
  const n = (v) => results.filter((x) => x.verdict === v).length;
  console.log(`\n==== ${n("PASS")} pass · ${n("WARN")} warn · ${n("FAIL")} fail ====`);
  for (const x of results.filter((x) => x.verdict !== "PASS")) console.log(`${x.verdict} [${x.step}] ${x.detail}`);
  process.exit(n("FAIL") ? 1 : 0);
})().catch((e) => (console.error("agent check crashed:", e), process.exit(2)));

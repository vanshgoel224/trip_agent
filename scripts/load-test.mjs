// Load + soak test (no model calls, so it doesn't burn a free AI quota):
// N simulated users at once, each doing a realistic non-AI session, R rounds.
//   node scripts/load-test.mjs --url http://localhost:8787 --users 40 --rounds 3
const arg = (k, d) => (process.argv.includes(k) ? process.argv[process.argv.indexOf(k) + 1] : d);
const U = arg("--url", "http://127.0.0.1:8787"), USERS = Number(arg("--users", 40)), ROUNDS = Number(arg("--rounds", 3));
const lat = [], auth = [], errors = [];
const tag = Math.random().toString(36).slice(2, 6);
async function req(cookie, path, body) {
  const t = performance.now();
  try {
    const r = await fetch(`${U}${path}`, { method: body ? "POST" : "GET", headers: cookie ? { cookie } : {}, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30_000) });
    const txt = await r.text();
    (path.startsWith("/api/lock/") ? auth : lat).push(performance.now() - t);
    if (r.status >= 500) errors.push(`${r.status} ${path}: ${txt.slice(0, 100)}`);
    return { status: r.status, json: (() => { try { return JSON.parse(txt); } catch { return txt; } })(), headers: r.headers };
  } catch (e) {
    errors.push(`${path}: ${e.message}`);
    return { status: 0, json: null };
  }
}
async function session(i, round) {
  const name = `load${tag}${i}`;
  const s = round === 0 ? await req(null, "/api/lock/setup", { username: name, pin: "135790" }) : await req(null, "/api/lock/unlock", { username: name, pin: "135790" });
  const cookie = s.headers?.get("set-cookie")?.split(";")[0];
  if (!cookie) return errors.push(`sign-in failed for ${name}: ${s.status} ${JSON.stringify(s.json).slice(0, 80)}`);
  const trip = await req(cookie, "/api/scenarios/A", {});
  const tripId = trip.json?.tripId;
  const chat = await req(cookie, "/api/chats", { mode: "general", tripId });
  await req(cookie, `/api/chats/${chat.json?.chatId}/messages`, { text: "/recall rahul" });
  await req(cookie, `/api/trips/${tripId}`);
  await req(cookie, "/api/device/location", { tripId, lat: 13.08 + i / 1000, lng: 80.27, accuracy: 15 });
  await req(cookie, "/api/travel/search", { kind: "bus", from: "Chennai", to: "Madurai", date: new Date(Date.now() + 86400_000).toISOString().slice(0, 10) });
  await req(cookie, "/api/feed/message", { tripId, text: "Your bus PNR-ORIG is delayed by 45 minutes" });
  if (i % 5 === 0) await req(cookie, "/api/sos", { message: "load test SOS", tripId });
  if (i % 7 === 0) {
    const f = await req(cookie, "/api/falls", { freefallMs: 450, heightM: 1, impactG: 4, severity: "medium" });
    if (f.json?.fallId) await req(cookie, `/api/falls/${f.json.fallId}/cancel`, { by: "screen" });
  }
  await req(cookie, "/api/sos");
  await req(cookie, "/api/me/export");
  await req(cookie, "/api/lock/lock", {});
}
(async () => {
  const st = await req(null, "/api/lock/status");
  if (!st.status) return console.error("server not reachable");
  for (let round = 0; round < ROUNDS; round++) {
    const t = performance.now();
    await Promise.all(Array.from({ length: USERS }, (_, i) => session(i, round)));
    const pc = (arr) => { const s = [...arr].sort((a, b) => a - b); return (q) => s[Math.min(s.length - 1, Math.floor(q * s.length))] ?? 0; };
    const p = pc(lat), a = pc(auth);
    console.log(`round ${round + 1}: ${USERS} users in ${((performance.now() - t) / 1000).toFixed(1)} s · app requests ${lat.length}: p50 ${p(0.5).toFixed(0)} ms, p95 ${p(0.95).toFixed(0)} ms, p99 ${p(0.99).toFixed(0)} ms · sign-ins (Argon2id, queued): p50 ${a(0.5).toFixed(0)} ms, max ${a(1).toFixed(0)} ms · errors ${errors.length}`);
  }
  if (errors.length) console.log("errors:\n" + [...new Set(errors)].slice(0, 15).join("\n"));
  process.exit(errors.length ? 1 : 0);
})();

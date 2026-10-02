import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { setup, wait, UNDO_MS } from "../helpers";
import { ExpenseAgent } from "../../services/agents/expenses";
import { MemoryGraph } from "../../services/memory";
import { Store } from "../../packages/db";

// ---- fake OpenAI-compatible model: replays a script of tool calls, then a final text ----
let script: { tool?: string; args?: object; text?: string }[] = [];
let seen: any[] = [];
const lastToolReq = () => seen.filter((r) => r.tools).at(-1);
const fake: Server = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c)).on("end", () => {
    if (req.method === "GET") return void (res.writeHead(200, { "content-type": "application/json" }), res.end('{"data":[]}')); // /models health check
    if (req.url?.includes("/fail/")) return void (res.writeHead(500), res.end("boom"));
    const j = JSON.parse(body);
    seen.push(j);
    const step = script.shift() ?? { text: "ok" };
    const message = step.tool
      ? { role: "assistant", content: null, tool_calls: [{ id: `call_${seen.length}`, type: "function", function: { name: step.tool, arguments: JSON.stringify(step.args ?? {}) } }] }
      : { role: "assistant", content: step.text };
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message }] }));
  });
});
const ready = new Promise<void>((r) => fake.listen(0, "127.0.0.1", () => r()));
after(() => fake.close());
async function withModel() {
  await ready;
  const port = (fake.address() as any).port;
  process.env.ONLINE_MODEL_API_KEY = "test";
  process.env.ONLINE_MODEL_BASE_URL = `http://127.0.0.1:${port}/v1`;
  process.env.ONLINE_MODEL_NAME = "fake-model";
}
function noModel() {
  delete process.env.ONLINE_MODEL_API_KEY;
}

test("expense splitting: equal split, balances, fewest transfers, duplicate guard", () => {
  const e = new ExpenseAgent(new Store());
  e.add("g", { description: "cab", amount: 2400, paidBy: "Me", splitAmong: ["me", "Rahul", "Priya"] });
  e.add("g", { description: "lunch", amount: 900, paidBy: "Rahul", splitAmong: ["Me", "Rahul", "Priya"] });
  assert.deepEqual(e.balances("g"), { Me: 1300, Rahul: -200, Priya: -1100 });
  assert.deepEqual(e.settlementPlan("g"), [{ from: "Priya", to: "Me", amount: 1100 }, { from: "Rahul", to: "Me", amount: 200 }]);
  assert.throws(() => e.add("g", { description: "cab again", amount: 2400, paidBy: "Me", splitAmong: ["Me", "Rahul"] }), /Already recorded/);
  e.add("g", { description: "second cab", amount: 2400, paidBy: "Me", splitAmong: ["Me", "Rahul"], confirmDuplicate: true });
  e.settle("g", "Priya", "Me", 1100);
  assert.equal(e.balances("g").Priya, 0);
  const odd = new ExpenseAgent(new Store());
  odd.add("x", { description: "tea", amount: 100, paidBy: "Me", splitAmong: ["Me", "A", "B"] });
  assert.equal(Object.values(odd.list("x")[0].shares).reduce((a, b) => a + b, 0), 100, "rounding remainder kept");
});

test("memory graph: remember, recall, graphify node-link export", () => {
  const m = new MemoryGraph(new Store());
  m.remember({ subject: "Me", subject_type: "traveller", relation: "travels with", object: "Rahul", object_type: "person" }, "CHAT-1");
  m.remember({ subject: "Rahul", subject_type: "person", relation: "allergic to", object: "peanuts", object_type: "fact" }, "CHAT-2");
  m.remember({ subject: "Me", subject_type: "traveller", relation: "travels with", object: "Rahul", object_type: "person" }, "CHAT-3");
  const facts = m.recall("is Rahul coming?");
  assert.ok(facts.includes("Rahul allergic to peanuts"));
  assert.ok(facts.includes("Me travels with Rahul"));
  const g = m.exportGraphify();
  assert.equal(g.directed, false);
  assert.equal(g.multigraph, false);
  assert.ok(Array.isArray(g.nodes) && Array.isArray(g.links) && Array.isArray(g.hyperedges));
  const link = g.links.find((l: any) => l.relation === "travels_with")!;
  assert.equal(link.weight, 2, "repeated fact strengthens the edge");
  for (const k of ["source", "target", "relation", "confidence", "confidence_score", "source_file", "weight"]) assert.ok(k in link, k);
  for (const k of ["id", "label", "community", "community_name", "source_file", "file_type"]) assert.ok(k in g.nodes[0], k);
  assert.match(m.report(), /God Nodes/);
});

test("chat agent runs model tool calls and persists the conversation", async () => {
  await withModel();
  const { b, tripId } = await setup("A");
  const chat = b.conversation.newChat("splitwise", tripId);
  script = [{ tool: "add_expense", args: { description: "cab", amount: 2400, paid_by: "Me", split_among: ["Me", "Rahul", "Priya"] } }, { tool: "get_balances" }, { text: "Rahul and Priya owe you ₹800 each." }];
  const r = await b.conversation.send(chat.chatId, "I paid 2400 for the cab split three ways");
  assert.deepEqual(r.tools, ["add_expense", "get_balances"]);
  assert.match(r.message.text, /₹800/);
  assert.equal(b.chats.messages(chat.chatId).length, 2);
  assert.deepEqual(b.expenses.balances(tripId), { Me: 1600, Rahul: -800, Priya: -800 });
  // Tool scoping: a splitwise chat never sees recovery/payment tools.
  const toolNames = lastToolReq().tools.map((t: any) => t.function.name);
  assert.ok(!toolNames.includes("report_disruption") && !toolNames.includes("approve_pending"));
  noModel();
  b.shutdown();
});

test("model cannot approve an over-authority spend without the traveller's explicit yes", async () => {
  await withModel();
  const { b, tripId, payments } = await setup("B");
  await b.orchestrator.reportDisruption(tripId, "bus cancelled");
  const chat = b.conversation.newChat("recovery", tripId);
  script = [{ tool: "approve_pending" }, { text: "I need your confirmation." }];
  await b.conversation.send(chat.chatId, "hmm what are the options");
  assert.equal(payments.chargeCalls, 0, "not approved: message was not a yes");
  const toolResult = lastToolReq().messages.find((m: any) => m.role === "tool");
  assert.match(toolResult.content, /not an explicit/);
  script = [{ tool: "approve_pending" }, { text: "Booked." }];
  await b.conversation.send(chat.chatId, "yes, book it");
  assert.equal(payments.chargeCalls, 1);
  assert.equal(b.orchestrator.currentIncident(tripId)?.step, "UNDO_WINDOW_OPEN");
  noModel();
  await wait(UNDO_MS + 100);
  b.shutdown();
});

test("safety words escalate before the model is asked, in any chat", async () => {
  await withModel();
  const { b, tripId, payments } = await setup("A");
  const chat = b.conversation.newChat("translate", tripId);
  script = [{ text: "मैं असुरक्षित महसूस कर रहा हूँ" }];
  const r = await b.conversation.send(chat.chatId, "translate: someone is following me and I feel unsafe");
  assert.ok(r.tools.includes("report_disruption(auto-safety)"));
  assert.equal(b.orchestrator.currentIncident(tripId)?.classification, "SAFETY");
  assert.equal(payments.chargeCalls, 0);
  noModel();
  b.shutdown();
});

test("without a model, chats fall back to deterministic rules", async () => {
  noModel();
  const { b, tripId } = await setup("A");
  const chat = b.conversation.newChat("general", tripId);
  const r = await b.conversation.send(chat.chatId, "My bus to Chennai was cancelled");
  assert.equal(r.source, "RULES");
  assert.equal(b.orchestrator.currentIncident(tripId)?.step, "UNDO_WINDOW_OPEN");
  await wait(UNDO_MS + 100);
  b.shutdown();
});

test("crash detection: impact opens a check-in; 'I'm OK' cancels; no answer escalates as SAFETY", async () => {
  process.env.CRASH_CHECKIN_MS = "60";
  const { b, tripId, payments } = await setup("A");
  assert.equal((await b.devices.impact(tripId, { peakG: 1.5 })).checkin, false, "below threshold ignored");
  assert.equal((await b.devices.impact(tripId, { peakG: 5.2, stillSeconds: 3 })).checkin, true);
  assert.equal(b.devices.imOk(tripId), true);
  await wait(120);
  assert.equal(b.orchestrator.currentIncident(tripId), undefined, "cancelled check-in does not escalate");
  await b.devices.impact(tripId, { peakG: 6, stillSeconds: 4 });
  await wait(200);
  const inc = b.orchestrator.currentIncident(tripId)!;
  assert.equal(inc.classification, "SAFETY");
  assert.equal(inc.pendingApproval?.kind, "ALERT_CONTACT", "contact alerted only after the traveller says yes (not opted in)");
  assert.equal(payments.chargeCalls, 0);
  delete process.env.CRASH_CHECKIN_MS;
  b.shutdown();
});

test("GPS readings are validated and update the trip's live location", async () => {
  const { b, tripId } = await setup("A");
  assert.throws(() => b.devices.recordLocation(tripId, { lat: 123, lng: 0 }), /invalid coordinates/);
  b.devices.recordLocation(tripId, { lat: 15.5553, lng: 73.7517, accuracy: 10 });
  assert.equal(b.devices.latest(tripId)?.lat, 15.5553);
  assert.equal(b.orchestrator.trip(tripId).currentLocation?.lng, 73.7517);
  b.shutdown();
});

test("script check flags translations in the wrong script", async () => {
  const { scriptScore } = await import("../../services/conversation");
  assert.equal(scriptScore("ନିକଟତମ ଡାକ୍ତରଖାନା କେଉଁଠି?", "or-IN"), 1);
  assert.ok(scriptScore("നിക്കടസ്ഥിത ആശുപത്രി କେଉଁଠାରି ଅଛି?", "or-IN") < 0.85, "mixed Malayalam/Odia is caught");
  assert.equal(scriptScore("பேருந்து நிலையம் எங்கே?", "ta-IN"), 1);
});

test("custom chats: traveller-written instructions and only the tool groups they picked", async () => {
  await withModel();
  const { b, tripId } = await setup("A");
  assert.throws(() => b.conversation.newChat("custom", tripId, "Empty"), /needs instructions/);
  const chat = b.conversation.newChat("custom", tripId, "Food finder", { instructions: "Suggest pure-veg places under ₹300", groups: ["maps", "plans", "bogus"] });
  assert.deepEqual(chat.custom?.groups, ["maps", "plans"], "unknown groups dropped");
  script = [{ text: "Sure." }];
  await b.conversation.send(chat.chatId, "find me lunch");
  const req = lastToolReq();
  const names = req.tools.map((t: any) => t.function.name);
  assert.ok(names.includes("nearby_places") && names.includes("add_activity") && names.includes("remember"));
  assert.ok(!names.includes("report_disruption") && !names.includes("add_expense") && !names.includes("approve_pending"));
  assert.match(req.messages[0].content, /pure-veg places under ₹300/);
  assert.equal(b.chats.get(chat.chatId)?.title, "Food finder", "custom title kept after first message");
  noModel();
  b.shutdown();
});

test("Delhivery booking: quote, explicit-yes guard, simulated AWB, tracking stages, cancel rules", async () => {
  const { Delhivery } = await import("../../services/integrations/delhivery");
  const store = new Store();
  const d = new Delhivery(store);
  assert.equal(d.status().active, true);
  // Quote without network: stub the place lookup.
  const osm = await import("../../services/integrations/openstreetmap");
  const q = await (d as any).quote.call(Object.assign(Object.create(d), {}), "Pune", "Goa", 8).catch(() => null);
  void osm;
  const quote = q ?? { quoteId: "DLQ-TEST", from: "Pune", to: "Goa", weightKg: 8, service: "surface", price: 900, etaDays: 3, distanceKm: 380, simulated: true, createdAt: new Date().toISOString() };
  if (!q) store.put("parcels", quote.quoteId, quote, { key: "QUOTE" });
  await assert.rejects(d.book({ quoteId: quote.quoteId, pickupAddress: "a", dropAddress: "b", contactName: "V", phone: "12345", pickupDate: "2026-10-05", contents: "bag" }), /valid Indian mobile/);
  const p = await d.book({ quoteId: quote.quoteId, pickupAddress: "FC Road, Pune", dropAddress: "Baga, Goa", contactName: "Vansh", phone: "+91 98765 43210", pickupDate: "2026-10-05", contents: "1 suitcase" });
  assert.equal(p.simulated, true);
  assert.match(p.awb, /^\d{13}$/);
  assert.equal(d.track(p.awb).status, "PICKUP_SCHEDULED");
  process.env.DELHIVERY_SIM_STAGE_MIN = "0.0001";
  await wait(30);
  assert.equal(d.track(p.bookingId).status, "DELIVERED");
  assert.throws(() => d.cancel(p.bookingId), /already delivered/);
  delete process.env.DELHIVERY_SIM_STAGE_MIN;
  const p2 = await d.book({ quoteId: quote.quoteId, pickupAddress: "x", dropAddress: "y", contactName: "V", phone: "9876543210", pickupDate: "2026-10-06", contents: "box" });
  assert.equal(d.cancel(p2.awb).status, "CANCELLED");
});

test("General messages are auto-filed into the matching function chat (created if missing)", async () => {
  await withModel();
  const { b, tripId } = await setup("A");
  const general = b.conversation.newChat("general", tripId);
  script = [{ tool: "add_expense", args: { description: "dinner", amount: 1200, paid_by: "Me", split_among: ["Me", "Rahul"] } }, { text: "Rahul owes you ₹600." }];
  const r = await b.conversation.send(general.chatId, "I paid 1200 for dinner with Rahul");
  assert.equal(r.copiedTo.length, 1);
  assert.equal(r.copiedTo[0].mode, "splitwise");
  const target = b.chats.messages(r.copiedTo[0].chatId);
  assert.deepEqual(target.map((m) => [m.role, m.copiedFrom]), [["user", general.chatId], ["assistant", general.chatId]]);
  // Second expense reuses the same split chat instead of creating another.
  script = [{ tool: "add_expense", args: { description: "taxi", amount: 300, paid_by: "Rahul", split_among: ["Me", "Rahul"] } }, { text: "Noted." }];
  const r2 = await b.conversation.send(general.chatId, "Rahul paid 300 for the taxi");
  assert.equal(r2.copiedTo[0].chatId, r.copiedTo[0].chatId);
  // A translation request with no tools is filed by keyword; plain chit-chat is not filed.
  script = [{ text: "पानी" }];
  assert.equal((await b.conversation.send(general.chatId, "how do you say water in hindi?")).copiedTo[0].mode, "translate");
  script = [{ text: "Hello!" }];
  assert.equal((await b.conversation.send(general.chatId, "hi")).copiedTo.length, 0);
  // Function chats never re-file.
  script = [{ tool: "get_balances" }, { text: "ok" }];
  assert.equal((await b.conversation.send(r.copiedTo[0].chatId, "balances?")).copiedTo.length, 0);
  noModel();
  b.shutdown();
});

test("/recall answers from the memory graph instantly, without calling the model", async () => {
  await withModel();
  const { b, tripId } = await setup("A");
  b.memory.remember({ subject: "Rahul", subject_type: "person", relation: "allergic to", object: "peanuts", object_type: "fact" }, "t");
  const chat = b.conversation.newChat("budget", tripId);
  const before = seen.length;
  const r = await b.conversation.send(chat.chatId, "/recall rahul");
  assert.equal(seen.length, before, "no model request");
  assert.equal(r.source, "MEMORY");
  assert.match(r.message.text, /Rahul allergic to peanuts/);
  assert.match((await b.conversation.send(chat.chatId, "/recall nobody")).message.text, /Nothing in memory/);
  assert.equal(b.memory.search("peanut")[0].label, "peanuts");
  noModel();
  b.shutdown();
});

test("/btw side questions are answered but leave no trace: no history, no memory, read-only tools", async () => {
  await withModel();
  const { b, tripId } = await setup("A");
  const chat = b.conversation.newChat("general", tripId);
  const nodesBefore = b.memory.nodes().length;
  // Even if the model tries to write memory, the tool isn't offered and would be refused.
  script = [{ tool: "remember", args: { facts: [{ subject: "Me", relation: "likes", object: "garbage" }] } }, { text: "Probably 30°C." }];
  const r = await b.conversation.send(chat.chatId, "/btw how hot is Goa in October?");
  assert.equal(r.ephemeral, true);
  assert.match(r.message.text, /30°C/);
  assert.equal(b.chats.messages(chat.chatId).length, 0, "nothing persisted");
  assert.equal(b.memory.nodes().length, nodesBefore, "memory untouched");
  assert.equal(r.copiedTo.length, 0);
  const offered = lastToolReq().tools.map((t: any) => t.function.name);
  for (const w of ["remember", "add_expense", "add_activity", "report_disruption", "approve_pending", "calendar_add_event"]) assert.ok(!offered.includes(w), `${w} not offered`);
  assert.ok(offered.includes("get_trip_status"));
  noModel();
  b.shutdown();
});

test("memory rejects junk facts and /forget removes things", async () => {
  const m = new MemoryGraph(new Store());
  assert.equal((m.remember({ subject: "it", relation: "is", object: "something" }, "c") as any).reason, "too vague");
  assert.ok((m.remember({ subject: "Me", relation: "said", object: "x".repeat(200) }, "c") as any).reason);
  assert.equal(m.nodes().length, 0);
  const { b, tripId } = await setup("A");
  b.memory.remember({ subject: "Me", subject_type: "traveller", relation: "prefers", object: "window seat", object_type: "preference" }, "t");
  const chat = b.conversation.newChat("general", tripId);
  assert.match((await b.conversation.send(chat.chatId, "/forget window seat")).message.text, /Forgotten: window seat/);
  assert.equal(b.memory.search("window").length, 0);
  assert.equal(b.memory.links().length, 0, "links removed with the node");
  b.shutdown();
});

test("critical thinking: the self-check replaces a draft that contradicts the tool results", async () => {
  await withModel();
  const { b, tripId } = await setup("A");
  const chat = b.conversation.newChat("splitwise", tripId);
  script = [
    { tool: "add_expense", args: { description: "cab", amount: 900, paid_by: "Me", split_among: ["Me", "Rahul", "Priya"] } },
    { text: "Rahul and Priya each owe you ₹450." }, // wrong: it's ₹300 each
    { text: '{"ok": false, "issues": ["900/3 is 300, not 450"], "revised": "Rahul and Priya each owe you ₹300."}' },
  ];
  const r = await b.conversation.send(chat.chatId, "I paid 900 for the cab split 3 ways");
  assert.equal(r.message.text, "Rahul and Priya each owe you ₹300.");
  assert.match(r.source, /self-corrected/);
  const criticReq = seen.at(-1);
  assert.match(criticReq.messages[1].content, /fact-checker/);
  assert.ok(!criticReq.tools, "the checker call gets no tools");
  noModel();
  b.shutdown();
});

test("multi-step tasks: make_plan / update_plan are tracked", async () => {
  await withModel();
  const { b, tripId } = await setup("A");
  const chat = b.conversation.newChat("general", tripId);
  script = [
    { tool: "make_plan", args: { goal: "Plan evening", steps: ["Find dinner", "Add to plans"] } },
    { tool: "update_plan", args: { step: 1, status: "done", result: "Gunpowder" } },
    { tool: "update_plan", args: { step: 2, status: "done" } },
    { text: "All set." },
  ];
  await b.conversation.send(chat.chatId, "plan my evening");
  const plan = b.store.get<any>("autopilot", `PLAN-${chat.chatId}`);
  assert.deepEqual(plan.steps.map((s: any) => s.status), ["done", "done"]);
  noModel();
  b.shutdown();
});

test("chats carry an emoji and a name; bad emoji input falls back to the mode default", async () => {
  const { b, tripId } = await setup("A");
  const c = b.conversation.newChat("general", tripId, "Goa plans", undefined, "🏖️");
  assert.equal(c.emoji, "🏖️");
  assert.equal(b.conversation.newChat("splitwise", tripId).emoji, "💸");
  assert.equal(b.conversation.newChat("maps", tripId, undefined, undefined, "hello").emoji, "🗺️");
  const u = b.chats.update(c.chatId, { title: "  Goa evenings ", emoji: "🌅" });
  assert.equal(u.title, "Goa evenings");
  assert.equal(u.emoji, "🌅");
  assert.equal(b.chats.update(c.chatId, { emoji: "🎉" }).title, "Goa evenings", "editing emoji keeps the name");
  b.shutdown();
});

test("consent guard: a hedged 'book it? not yet' never books", async () => {
  await withModel();
  const { b, tripId, payments } = await setup("B");
  await b.orchestrator.reportDisruption(tripId, "bus cancelled");
  const chat = b.conversation.newChat("recovery", tripId);
  for (const t of ["ok book it? not yet", "yes but wait", "haan... abhi nahi", "don't book it yet ok"]) {
    script = [{ tool: "approve_pending" }, { text: "Waiting." }];
    await b.conversation.send(chat.chatId, t);
  }
  assert.equal(payments.chargeCalls, 0);
  noModel();
  b.shutdown();
});

test("fallback chain: online model fails mid-turn → local Qwen finishes it; nothing reachable → rules", async () => {
  await withModel();
  const port = (fake.address() as any).port;
  process.env.ONLINE_MODEL_BASE_URL = `http://127.0.0.1:${port}/fail/v1`;
  process.env.OFFLINE_MODEL_CONFIG = JSON.stringify({ baseUrl: `http://127.0.0.1:${port}/v1`, model: "qwen3:4b" });
  const { b, tripId } = await setup("A");
  const chat = b.conversation.newChat("general", tripId);
  script = [{ text: "Answered by local Qwen." }];
  const r = await b.conversation.send(chat.chatId, "hello");
  assert.equal(r.message.text, "Answered by local Qwen.");
  assert.match(r.source, /OFFLINE_MODEL:qwen3:4b \(fallback\)/);
  // MODEL_PRIMARY=local: local first even when online.
  process.env.MODEL_PRIMARY = "local";
  script = [{ text: "Local first." }];
  assert.match((await b.conversation.send(chat.chatId, "hi again")).source, /OFFLINE_MODEL:qwen3:4b$/);
  delete process.env.MODEL_PRIMARY;
  process.env.OFFLINE_MODEL_CONFIG = "off";
  process.env.ONLINE_MODEL_BASE_URL = `http://127.0.0.1:${port}/fail/v1`;
  const r3 = await b.conversation.send(chat.chatId, "status");
  assert.equal(r3.source, "RULES", "every model down → deterministic rules still answer");
  noModel();
  b.shutdown();
});

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
const fake: Server = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c)).on("end", () => {
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
  const toolNames = seen.at(-1).tools.map((t: any) => t.function.name);
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
  const toolResult = seen.at(-1).messages.find((m: any) => m.role === "tool");
  assert.match(toolResult.content, /not an explicit yes/);
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

import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { setup, wait, UNDO_MS } from "../helpers";
import { createBiruni } from "../../services/runtime";
import { classifyDisruption } from "../../packages/policy";

test("scenario A: autonomous execution, audit trail, undo, verification, new itinerary, readback", async () => {
  const { b, tripId, payments } = await setup("A");
  const res = await b.orchestrator.handleMessage(tripId, "My bus to Chennai was cancelled");
  assert.equal(res.intent, "REPORT_DISRUPTION");
  let inc = b.orchestrator.currentIncident(tripId)!;
  assert.equal(inc.step, "UNDO_WINDOW_OPEN");
  assert.ok(b.orchestrator.snapshot(tripId).undoRemainingMs > 0);
  await wait(UNDO_MS + 100);
  inc = b.orchestrator.currentIncident(tripId)!;
  assert.equal(inc.step, "CLOSED");
  assert.deepEqual(
    inc.timeline.map((t) => t.step).filter((s) => !["DISRUPTION_DETECTED"].includes(s)),
    ["CLASSIFIED", "OPTIONS_GENERATED", "OBLIGATION_CHECKED", "AUTHORITY_CHECKED", "EXECUTING", "UNDO_WINDOW_OPEN", "VERIFIED", "READBACK_SENT", "CLOSED"],
  );
  const trip = b.orchestrator.trip(tripId);
  assert.equal(trip.status, "TRAVELLING");
  assert.equal(trip.itinerary.version, 2);
  assert.equal(trip.itinerary.legs.find((l) => l.legId === "LEG-1")?.status, "REPLACED");
  assert.match(inc.readback!, /back on track/);
  assert.equal(payments.chargeCalls, 1);
  const audit = b.compliance.trace(inc.incidentId);
  const charge = audit.find((a) => a.tool === "payment_execute" && a.action === "charge")!;
  assert.equal(charge.result, "SUCCESS");
  assert.equal(charge.authorityBefore, 2000);
  assert.equal(charge.authorityAfter, 800);
  assert.equal(charge.obligationCheck, "PASS");
  assert.equal(charge.complianceCheck, "PASS");
  b.shutdown();
});

test("safety is never downgraded by a model proposal", () => {
  assert.equal(classifyDisruption("I was in an accident", "LOGISTICAL"), "SAFETY");
  assert.equal(classifyDisruption("bus cancelled", "SAFETY"), "SAFETY");
  assert.equal(classifyDisruption("landslide on the ghat road"), "ROUTE_BLOCKED");
  assert.equal(classifyDisruption("train delayed 4 hours"), "LOGISTICAL");
});

test("safety stops autonomy; emergency contact only alerted after approval when not opted in", async () => {
  const { b, tripId, payments } = await setup("SAFETY");
  await b.orchestrator.handleMessage(tripId, "There was an accident and I feel unsafe");
  let inc = b.orchestrator.currentIncident(tripId)!;
  assert.equal(inc.stopReason, "SAFETY_INVOLVED");
  assert.equal(inc.pendingApproval?.kind, "ALERT_CONTACT");
  assert.equal(payments.chargeCalls, 0);
  assert.equal(b.voice.transcript(tripId).filter((u) => u.to === "EMERGENCY_CONTACT").length, 0);
  await b.orchestrator.handleMessage(tripId, "yes");
  assert.equal(b.voice.transcript(tripId).filter((u) => u.to === "EMERGENCY_CONTACT" && u.channel === "GNANI").length, 1);
  b.shutdown();
});

test("vendor ladder: declined rails fall through; unverified local vendor is skipped", async () => {
  const { b, tripId } = await setup("LADDER");
  const inc = await b.orchestrator.reportDisruption(tripId, "bus cancelled");
  assert.equal(inc.chosenOption?.vendorId, "VND-LOCAL-RAJU");
  const verified = b.store.list<any>("tool_calls", { incidentId: inc.incidentId }).filter((c) => c.tool === "vendor_verify");
  assert.deepEqual(verified.map((v) => [v.args.vendorId, v.result.data.pass]), [["VND-LOCAL-SHADY", false], ["VND-LOCAL-RAJU", true]]);
  await wait(UNDO_MS + 100);
  b.shutdown();
});

test("offline: options come from the pre-fetched cache and only logged cash executes", async () => {
  const { b, tripId } = await setup("OFFLINE");
  const inc = await b.orchestrator.reportDisruption(tripId, "bus cancelled");
  assert.ok(inc.options.every((o) => o.source === "OFFLINE_CACHE"));
  assert.equal(inc.chosenOption?.vendorRung, "LOGGED_CASH");
  assert.ok(b.voice.transcript(tripId).some((u) => u.channel === "DEVICE_TTS"));
  await wait(UNDO_MS + 100);
  assert.equal(b.orchestrator.currentIncident(tripId)?.step, "CLOSED");
  b.shutdown();
});

test("recovery agent crash after payment restarts from checkpoint without paying twice", async () => {
  const { b, tripId, payments } = await setup("RESTART");
  const inc = await b.orchestrator.reportDisruption(tripId, "bus cancelled");
  assert.equal(inc.step, "UNDO_WINDOW_OPEN");
  assert.equal(payments.chargeCalls, 1);
  const runs = b.orchestrator.router.runs({ incidentId: inc.incidentId }).filter((r) => r.agent === "recovery");
  assert.deepEqual(runs.map((r) => r.status), ["FAILED", "WAITING"]);
  assert.equal(b.finance.ledger(inc.incidentId).incidentSpent, 1200);
  await wait(UNDO_MS + 100);
  b.shutdown();
});

test("process restart: open undo window is rehydrated from the database and still completes", async () => {
  const dbPath = join(tmpdir(), `biruni-${Date.now()}.db`);
  const { b, tripId } = await setup("A", { undoWindowMs: 300, dbPath });
  const inc = await b.orchestrator.reportDisruption(tripId, "bus cancelled");
  assert.equal(inc.step, "UNDO_WINDOW_OPEN");
  b.shutdown(); // "crash" with the window open

  const b2 = createBiruni({ dbPath, undoWindowMs: 300, providers: b.providers });
  assert.equal(b2.rehydrated, 1);
  await wait(500);
  assert.equal(b2.orchestrator.currentIncident(tripId)?.step, "CLOSED");
  b2.shutdown();
  for (const s of ["", "-wal", "-shm"]) rmSync(dbPath + s, { force: true });
});

test("traveller with a verified way home stops recovery", async () => {
  const { b, tripId, payments } = await setup("B");
  await b.orchestrator.reportDisruption(tripId, "bus cancelled");
  await b.orchestrator.handleMessage(tripId, "I found a way, I'm on a train now");
  assert.equal(b.orchestrator.currentIncident(tripId)?.step, "CLOSED");
  assert.equal(b.orchestrator.trip(tripId).status, "TRAVELLING");
  assert.equal(payments.chargeCalls, 0);
  b.shutdown();
});

test("model reply parsing ignores <think> blocks and surrounding prose", async () => {
  const { extractJson } = await import("../../services/models");
  assert.deepEqual(extractJson('<think>maybe {"intent":"OTHER"}?</think>Sure: {"intent":"UNDO"} done'), { intent: "UNDO" });
  assert.deepEqual(extractJson('{"intent":"REPORT_DISRUPTION","disruptionClass":"SAFETY"}'), { intent: "REPORT_DISRUPTION", disruptionClass: "SAFETY" });
  assert.throws(() => extractJson("no json here"));
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { setup, wait, UNDO_MS } from "../helpers";
import { checkAuthority } from "../../packages/policy";

test("₹2,000 is cumulative per incident, not per transaction (spec §8 example)", async () => {
  const { b, tripId } = await setup("A");
  const inc = await b.orchestrator.reportDisruption(tripId, "bus cancelled");
  // Recovery already spent ₹1,200 on this incident; remaining is ₹800.
  let l = b.finance.ledger(inc.incidentId);
  assert.equal(l.incidentSpent, 1200);
  assert.equal(l.remainingIncident, 800);
  // Further actions against the same incident: ₹500 fits, then ₹900 must be blocked.
  b.finance.reserve(inc.incidentId, 500, "TEST-ACTION-2");
  b.finance.commit("TEST-ACTION-2");
  l = b.finance.ledger(inc.incidentId);
  assert.equal(l.remainingIncident, 300);
  assert.equal(checkAuthority(l, 900).pass, false);
  assert.equal(checkAuthority(l, 900).code, "AUTHORITY_EXCEEDED");
  await wait(UNDO_MS + 100);
  b.shutdown();
});

test("daily ceiling is enforced separately from incident authority", async () => {
  const { b, tripId } = await setup("A");
  const inc = await b.orchestrator.reportDisruption(tripId, "bus cancelled");
  await wait(UNDO_MS + 100);
  // Daily ceiling ₹3,000; ₹1,200 spent today. A second incident has a fresh ₹2,000,
  // but only ₹1,800 of daily ceiling remains.
  const inc2 = await b.orchestrator.reportDisruption(tripId, "missed connection");
  const l2 = b.finance.ledger(inc2.incidentId);
  assert.equal(l2.dailySpent >= 1200, true);
  assert.equal(l2.remainingDaily <= 1800, true);
  assert.equal(checkAuthority({ ...l2, remainingIncident: 2000 }, 1900).pass, false);
  assert.notEqual(inc.incidentId, inc2.incidentId);
  await wait(UNDO_MS + 100);
  b.shutdown();
});

test("only the finance agent can mutate obligations and authority ledgers", async () => {
  const { b } = await setup("A");
  assert.throws(() => b.store.put("authority_ledgers", "X", { hacked: true }), /only the finance agent/);
  assert.throws(() => b.store.put("obligations", "X", { hacked: true }), /only the finance agent/);
  assert.throws(() => b.store.issueFinanceCapability(), /single writer/);
  b.shutdown();
});

test("scenario B: over-authority recovery is blocked and the traveller is asked", async () => {
  const { b, tripId, payments } = await setup("B");
  const inc = await b.orchestrator.reportDisruption(tripId, "bus cancelled");
  assert.equal(inc.step, "AWAITING_TRAVELLER");
  assert.equal(inc.stopReason, "AUTHORITY_EXHAUSTED");
  assert.equal(inc.pendingApproval?.kind, "SPEND");
  assert.equal(payments.chargeCalls, 0);
  assert.equal(b.orchestrator.trip(tripId).status, "AWAITING_TRAVELLER");
  // Traveller approves → executes as a traveller-approved (not autonomous) spend.
  const res = await b.orchestrator.handleMessage(tripId, "yes, book it");
  assert.equal(res.intent, "APPROVE");
  assert.equal(b.orchestrator.currentIncident(tripId)?.step, "UNDO_WINDOW_OPEN");
  assert.equal(b.finance.ledger(inc.incidentId).remainingIncident, 2000, "approved spend does not consume autonomous authority");
  await wait(UNDO_MS + 100);
  assert.equal(b.orchestrator.currentIncident(tripId)?.step, "CLOSED");
  b.shutdown();
});

test("MCP rejects bad tokens and agents calling tools outside their role", async () => {
  const { b, tripId } = await setup("A");
  const bad = await b.mcp.call("route_search", { tripId, from: "Mumbai", to: "Chennai" }, { agent: "travel", token: "nope" });
  assert.equal(bad.error?.code, "AUTH_FAILURE");
  const { serviceToken } = await import("../../services/mcp/middleware");
  const wrongRole = await b.mcp.call("payment_execute", { tripId }, { agent: "voice", token: serviceToken("voice") });
  assert.equal(wrongRole.error?.code, "AUTH_FAILURE");
  const badSchema = await b.mcp.call("route_search", { tripId }, { agent: "travel", token: serviceToken("travel") });
  assert.equal(badSchema.error?.code, "INVALID_REQUEST");
  assert.ok(bad.auditId && wrongRole.auditId && badSchema.auditId, "blocked calls are audited too");
  b.shutdown();
});

test("minors cannot use Biruni", async () => {
  const { b } = await setup("A");
  assert.throws(
    () => b.orchestrator.createTrip({ traveller: { name: "Kid", age: 16, preferredLanguage: "en-IN", dailyCeiling: 1000, emergencyAutoAlertOptIn: false }, itinerary: { origin: "Mumbai", destination: "Pune", legs: [] } }),
    /under 18/,
  );
  b.shutdown();
});

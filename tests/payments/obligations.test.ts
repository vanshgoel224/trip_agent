import { test } from "node:test";
import assert from "node:assert/strict";
import { setup, wait, UNDO_MS } from "../helpers";
import { inferObligations } from "../../packages/policy";
import { sixMonthsOfDebits } from "../../services/integrations/simulator";

test("Setu AA debits are classified; rent and EMI are CONFIRMED and protected", () => {
  const obs = inferObligations(sixMonthsOfDebits({ rent: 15000, emi: 6500, fee: 9000 }));
  const rent = obs.find((o) => o.description.includes("RENT"))!;
  const emi = obs.find((o) => o.description.includes("EMI"))!;
  const fee = obs.find((o) => o.description.includes("FEE"))!;
  assert.equal(rent.classification, "CONFIRMED");
  assert.equal(emi.classification, "CONFIRMED");
  assert.equal(fee.classification, "UNCERTAIN");
  assert.ok(obs.every((o) => o.protected), "uncertain money is never treated as free");
  assert.equal(obs.find((o) => o.description.includes("SWIGGY")), undefined);
});

test("scenario C: affordable within authority but protected money → blocked, traveller asked", async () => {
  const { b, tripId, payments } = await setup("C");
  const inc = await b.orchestrator.reportDisruption(tripId, "bus cancelled");
  assert.equal(inc.stopReason, "OBLIGATION_AT_RISK");
  assert.equal(inc.step, "AWAITING_TRAVELLER");
  assert.equal(payments.chargeCalls, 0);
  assert.ok(1400 <= b.finance.ledger(inc.incidentId).remainingIncident, "it was within authority");
  b.shutdown();
});

test("obligation guard holds even when called directly through MCP", async () => {
  const { b, tripId } = await setup("C");
  const inc = await b.orchestrator.reportDisruption(tripId, "bus cancelled");
  const { serviceToken } = await import("../../services/mcp/middleware");
  const r = await b.mcp.call(
    "payment_execute",
    { tripId, incidentId: inc.incidentId, operation: "charge", amount: 1400, vendorId: "VND-PL-NUEGO", rung: "PINE_LABS_MERCHANT", idempotencyKey: "DIRECT-1" },
    { agent: "recovery", token: serviceToken("recovery") },
  );
  assert.equal(r.success, false);
  assert.equal(r.error?.code, "OBLIGATION_BLOCKED");
  const audit = b.compliance.trace(inc.incidentId).find((a) => a.auditId === r.auditId)!;
  assert.equal(audit.obligationCheck, "FAIL");
  assert.equal(audit.result, "BLOCKED");
  b.shutdown();
});

test("Zerodha is context only: holdings never count as spendable", async () => {
  const { b, tripId } = await setup("C");
  const map = b.finance.obligationMap(b.orchestrator.trip(tripId).travellerId)!;
  // ~₹18,300 of simulated holdings exist, but free balance ignores them.
  assert.ok(map.freeBalance < 1400);
  await wait(10);
  b.shutdown();
});

test("undo within the window refunds, cancels the booking and restores authority", async () => {
  const { b, tripId } = await setup("A", { undoWindowMs: 2000 });
  const inc = await b.orchestrator.reportDisruption(tripId, "bus cancelled");
  assert.equal(inc.step, "UNDO_WINDOW_OPEN");
  assert.equal(b.finance.ledger(inc.incidentId).remainingIncident, 800);
  const res = await b.orchestrator.handleMessage(tripId, "undo");
  assert.equal(res.intent, "UNDO");
  const after = b.orchestrator.currentIncident(tripId)!;
  assert.equal(after.step, "AWAITING_TRAVELLER");
  assert.equal(b.finance.ledger(inc.incidentId).remainingIncident, 2000);
  assert.equal(b.store.get<any>("payments", after.paymentId!).status, "REFUNDED");
  assert.equal(b.store.get<any>("bookings", after.bookingId!).status, "CANCELLED");
  const trip = b.orchestrator.trip(tripId);
  assert.equal(trip.itinerary.legs.find((l) => l.legId === "LEG-1")?.status, "CONFIRMED", "itinerary restored");
  b.shutdown();
});

test("undo after the window closes is refused", async () => {
  const { b, tripId } = await setup("A");
  const inc = await b.orchestrator.reportDisruption(tripId, "bus cancelled");
  await wait(UNDO_MS + 100);
  assert.equal(await b.orchestrator.undo(inc.incidentId), false);
  b.shutdown();
});

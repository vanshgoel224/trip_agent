import { test } from "node:test";
import assert from "node:assert/strict";
import { setup, wait, UNDO_MS } from "../helpers";
import { serviceToken } from "../../services/mcp/middleware";

test("scenario D: timeout after charge → reconcile, no second payment", async () => {
  const { b, tripId, payments } = await setup("D");
  const inc = await b.orchestrator.reportDisruption(tripId, "bus cancelled");
  assert.equal(inc.step, "UNDO_WINDOW_OPEN");
  assert.equal(payments.chargeCalls, 1, "exactly one charge reached the rail");
  assert.equal(payments.charges.size, 1);
  const call = b.store.list<any>("tool_calls", { incidentId: inc.incidentId }).find((c) => c.tool === "payment_execute" && c.args.operation === "charge")!;
  assert.equal(call.result.status, "RECONCILED");
  assert.equal(b.finance.ledger(inc.incidentId).incidentSpent, 1200, "ledger reconciled to the real charge");
  await wait(UNDO_MS + 100);
  assert.equal(b.orchestrator.currentIncident(tripId)?.step, "CLOSED");
  b.shutdown();
});

test("replaying a completed charge returns ALREADY_COMPLETED without touching the rail", async () => {
  const { b, tripId, payments } = await setup("A", { undoWindowMs: 2000 });
  const inc = await b.orchestrator.reportDisruption(tripId, "bus cancelled");
  const key = b.store.get<any>("payments", inc.paymentId!).idempotencyKey;
  assert.match(key, /^INC-.*-PAY-\d{3}$/);
  const before = payments.chargeCalls;
  const r = await b.mcp.call(
    "payment_execute",
    { tripId, incidentId: inc.incidentId, operation: "charge", amount: 1200, vendorId: "VND-PL-NUEGO", rung: "PINE_LABS_MERCHANT", idempotencyKey: key },
    { agent: "recovery", token: serviceToken("recovery") },
  );
  assert.equal(r.status, "ALREADY_COMPLETED");
  assert.equal(payments.chargeCalls, before);
  assert.equal(b.finance.ledger(inc.incidentId).incidentSpent, 1200, "no double debit in the ledger");
  b.undo.stopAll();
  b.shutdown();
});

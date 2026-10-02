import { test } from "node:test";
import assert from "node:assert/strict";
import { setup, wait, UNDO_MS } from "../helpers";
import { Feedback } from "../../services/feedback";
import { Store } from "../../packages/db";
import { simulator, seedVendors } from "../../services/integrations/simulator";

test("autopilot (L4): trusted cancellation → autonomous recovery with a logged reason", async () => {
  const { b, tripId, payments } = await setup("A");
  b.autopilot.operatorEvent(tripId, { legId: "LEG-1", status: "CANCELLED" });
  const d = await b.autopilot.tick(tripId);
  const act = d.find((x) => x.decided === "ACT")!;
  assert.ok(act, "acted without being asked");
  assert.match(act.why, /booked an alternative within ₹2,000/);
  assert.equal(payments.chargeCalls, 1);
  assert.equal(b.orchestrator.currentIncident(tripId)?.step, "UNDO_WINDOW_OPEN");
  // Idempotent: the same signal on the next tick does nothing more.
  assert.equal((await b.autopilot.tick(tripId)).filter((x) => x.decided === "ACT").length, 0);
  await wait(UNDO_MS + 100);
  b.shutdown();
});

test("autopilot thinks before acting: rumours wait for corroboration, small delays only notify, off means off", async () => {
  const { b, tripId, payments } = await setup("A");
  b.autopilot.operatorEvent(tripId, { legId: "LEG-1", status: "CANCELLED", source: "social media rumour" });
  assert.equal((await b.autopilot.tick(tripId))[0]?.decided, "WAIT");
  assert.equal(payments.chargeCalls, 0);
  b.autopilot.operatorEvent(tripId, { legId: "LEG-1", status: "CANCELLED", source: "another passenger" });
  assert.equal((await b.autopilot.tick(tripId)).find((x) => x.decided === "ACT") !== undefined, true, "second independent report corroborates");
  await wait(UNDO_MS + 100);
  b.shutdown();

  const s2 = await setup("A");
  s2.b.autopilot.operatorEvent(s2.tripId, { legId: "LEG-1", status: "DELAYED", delayMin: 45 });
  const d = await s2.b.autopilot.tick(s2.tripId);
  assert.equal(d.find((x) => x.signal.startsWith("Delay"))?.decided, "NOTIFY");
  assert.equal(s2.payments.chargeCalls, 0);
  s2.b.autopilot.setEnabled(s2.tripId, false);
  s2.b.autopilot.operatorEvent(s2.tripId, { legId: "LEG-1", status: "CANCELLED" });
  assert.deepEqual(await s2.b.autopilot.tick(s2.tripId), []);
  assert.equal(s2.payments.chargeCalls, 0);
  s2.b.shutdown();
});

test("autopilot respects authority: an over-limit alternative stops and asks", async () => {
  const { b, tripId, payments } = await setup("B");
  b.autopilot.operatorEvent(tripId, { legId: "LEG-1", status: "CANCELLED" });
  const act = (await b.autopilot.tick(tripId)).find((x) => x.decided === "ACT")!;
  assert.match(act.why, /AUTHORITY_EXHAUSTED/);
  assert.equal(payments.chargeCalls, 0);
  b.shutdown();
});

test("feedback: validation, vendor ratings feed the vendor ladder, CSV export", () => {
  seedVendors();
  const f = new Feedback(new Store());
  assert.throws(() => f.record({ kind: "message", rating: 5, source: "ui" }), /1 or -1/);
  assert.throws(() => f.record({ kind: "vendor", rating: 9, source: "ui" }), /1–5/);
  assert.throws(() => f.record({ kind: "trip", source: "ui" }), /rating or a comment/);
  const before = simulator.vendors.get("VND-LOCAL-RAJU")!;
  for (let i = 0; i < 40; i++) f.record({ kind: "vendor", rating: 1, vendorId: "VND-LOCAL-RAJU", source: "ui" });
  const after = simulator.vendors.get("VND-LOCAL-RAJU")!;
  assert.equal(after.reviewCount, before.reviewCount + 40);
  assert.ok(after.rating < 3.5, "bad ratings push the vendor below the ladder's 3.5★ bar");
  f.record({ kind: "message", rating: -1, comment: 'said "Goa" wrong', source: "ui" });
  assert.equal(f.summary().messages.down, 1);
  assert.match(f.csv().split("\n")[0], /^at,kind,rating/);
  assert.match(f.csv(), /"said ""Goa"" wrong"/, "CSV escapes quotes");
  seedVendors(); // restore for other tests
});

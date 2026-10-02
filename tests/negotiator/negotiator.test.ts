import { test } from "node:test";
import assert from "node:assert/strict";
import { setup } from "../helpers";
import { nextMove, parsePrice, readReplyFallback, toAsciiDigits } from "../../services/negotiator";

test("price reading: rupee formats, k, Indic digits", () => {
  assert.equal(parsePrice("₹1,200 only"), 1200);
  assert.equal(parsePrice("1.5k last price"), 1500);
  assert.equal(parsePrice("१२०० रुपये"), 1200);
  assert.equal(parsePrice("௧௨௦௦"), 1200, "Tamil digits");
  assert.equal(toAsciiDigits("೫೦೦"), "500", "Kannada digits");
  assert.equal(parsePrice("800/- per night"), 800);
  assert.equal(parsePrice("room 2 available"), undefined, "tiny numbers are not prices");
});

test("haggling policy is deterministic and never exceeds the traveller's max", () => {
  const d = { target: 1500, max: 2000, ourLast: 1280, rounds: 1, maxRounds: 4 };
  assert.deepEqual(nextMove(d, { price: 1400, accepts: false, rejects: false }), { action: "ACCEPT", price: 1400 }, "under target → accept");
  const c = nextMove(d, { price: 1900, accepts: false, rejects: false });
  assert.equal(c.action, "COUNTER");
  assert.ok(c.price! > 1280 && c.price! < 1900 && c.price! % 10 === 0);
  const over = nextMove(d, { price: 2600, accepts: false, rejects: false });
  assert.equal(over.action, "COUNTER");
  assert.ok(over.price! <= 2000, "counter never above max");
  assert.equal(nextMove({ ...d, rounds: 4 }, { price: 2600, accepts: false, rejects: false }).action, "WALK_AWAY");
  assert.deepEqual(nextMove({ ...d, rounds: 4 }, { price: 1950, accepts: false, rejects: false }), { action: "ACCEPT", price: 1950 }, "last round within max → accept");
  assert.deepEqual(nextMove(d, { accepts: true, rejects: false }), { action: "ACCEPT", price: 1280 });
  assert.equal(readReplyFallback("சரி ஓகே", 1280).accepts, true, "Tamil yes");
  assert.equal(readReplyFallback("இல்லை, 1800 ஆகும்", 1280).accepts, false);
});

test("hotel deal in Tamil over relay: haggle → agree → confirm → recorded in trip plans and memory (no model)", async () => {
  delete process.env.ONLINE_MODEL_API_KEY;
  process.env.OFFLINE_MODEL_CONFIG = "off";
  const { b, tripId } = await setup("A");
  const { deal, line } = await b.negotiator.start({ tripId, kind: "hotel", counterpartyName: "Murugan", language: "ta-IN", goal: "double room 5-7 Oct", details: { checkin: "2026-10-05", checkout: "2026-10-07", place: "Pondicherry" }, travellerName: "Vansh", target: 1500, max: 2000 });
  assert.match(line.text, /வணக்கம்/, "opens in Tamil (template)");
  assert.equal(line.price, 1280, "opens below target");
  let r = await b.negotiator.counterpartySaid(deal.dealId, "2200 ரூபாய் ஆகும்");
  assert.equal(r.deal.status, "NEGOTIATING");
  assert.ok(r.line!.price! <= 2000);
  r = await b.negotiator.counterpartySaid(deal.dealId, "சரி 1900 final");
  assert.equal(r.deal.status, "AGREED");
  r = await b.negotiator.counterpartySaid(deal.dealId, "சரி");
  assert.equal(r.deal.status, "CONFIRMED");
  assert.deepEqual(r.recorded, ["trip plans", "memory"]);
  assert.ok(b.orchestrator.trip(tripId).activities?.some((a) => a.title.includes("Murugan") && a.cost === 1900));
  assert.equal(b.memory.search("Murugan")[0]?.label, "Murugan");
  b.shutdown();
});

test("deal safety: no max → refused; calls without a number or Exotel keys say so instead of pretending", async () => {
  const { b, tripId } = await setup("A");
  await assert.rejects(b.negotiator.start({ tripId, kind: "auto", counterpartyName: "Raju", language: "hi-IN", goal: "x", travellerName: "V", target: 300, max: 0 }), /maximum/);
  const r = await b.negotiator.start({ tripId, kind: "auto", counterpartyName: "Raju", language: "hi-IN", goal: "Baga to Panjim", travellerName: "V", target: 300, max: 400, channel: "call" });
  assert.match(r.line.sent!, /not sent: No phone number/);
  const r2 = await b.negotiator.start({ tripId, kind: "taxi", counterpartyName: "Raju", counterpartyPhone: "9876543210", language: "hi-IN", goal: "Baga to Panjim", travellerName: "V", target: 300, max: 400, channel: "call" });
  assert.match(r2.line.sent!, /simulated \(no Exotel/);
  b.shutdown();
});

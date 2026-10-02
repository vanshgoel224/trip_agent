import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../../packages/db";
import { PartnerHub, Simulator } from "../../services/integrations/partners";

const day = new Date(Date.now() + 5 * 86400_000).toISOString().slice(0, 10);

test("search: every kind, any Indian city pair, ₹ prices sorted, max price respected", async () => {
  const hub = new PartnerHub(new Store());
  for (const kind of ["flight", "rail", "bus"] as const) {
    const offers = await hub.search({ kind, from: "Pune", to: "Madurai", date: day, passengers: 2 });
    assert.ok(offers.length > 0, kind);
    assert.ok(offers.every((o, i) => i === 0 || offers[i - 1].priceInr <= o.priceInr));
    assert.ok(offers.every((o) => o.simulated && o.priceInr > 0 && o.depart && o.arrive));
  }
  const hotels = await hub.search({ kind: "hotel", city: "Goa", date: day, nights: 2, maxPrice: 6000 });
  assert.ok(hotels.every((o) => o.priceInr <= 6000 && o.nights === 2));
  await assert.rejects(hub.search({ kind: "flight", from: "Pune", date: day }), /from and to/);
  await assert.rejects(hub.search({ kind: "boat" as any, from: "a", to: "b", date: day }), /kind/);
  await assert.rejects(hub.search({ kind: "bus", from: "a", to: "b", date: "tomorrow" }), /YYYY-MM-DD/);
});

test("book: names required, Indian phone validated, idempotent, status changes and cancellation refund", async () => {
  const hub = new PartnerHub(new Store());
  const [o] = await hub.search({ kind: "bus", from: "Bengaluru", to: "Chennai", date: day });
  await assert.rejects(hub.book({ offerId: o.offerId, travellers: [] }), /names/);
  await assert.rejects(hub.book({ offerId: o.offerId, travellers: ["Vansh Goel"], phone: "12345" }), /Indian mobile/);
  await assert.rejects(hub.book({ offerId: "OFR-NOPE", travellers: ["A"] }), /Unknown offer/);
  const b1 = await hub.book({ offerId: o.offerId, travellers: ["Vansh Goel"], phone: "+91 98765 43210", tripId: "T1" });
  const b2 = await hub.book({ offerId: o.offerId, travellers: ["vansh goel"], tripId: "T1" });
  assert.equal(b1.bookingRef, b2.bookingRef, "same offer + same people = one booking");
  assert.equal(b1.status, "CONFIRMED");
  assert.match(hub.summary(b1), /SIMULATED/);
  Simulator.overrides.set(b1.bookingRef, { status: "DELAYED", delayMin: 50 });
  const r = await hub.refresh(b1.bookingRef);
  assert.ok(r.changed);
  assert.equal(r.booking.status, "DELAYED");
  assert.equal((await hub.refresh(b1.bookingRef)).changed, false, "no duplicate change events");
  const c = await hub.cancel(b1.pnr);
  assert.equal(c.booking.status, "CANCELLED");
  assert.ok(c.refundInr >= 0 && c.refundInr <= b1.totalInr);
  assert.ok((await hub.cancel(b1.bookingRef)).alreadyCancelled);
});

test("expired fares can't be booked", async () => {
  const s = new Store();
  const hub = new PartnerHub(s);
  const [o] = await hub.search({ kind: "flight", from: "Delhi", to: "Leh", date: day });
  s.put("offers", o.offerId, { ...o, expiresAt: new Date(Date.now() - 1000).toISOString() });
  await assert.rejects(hub.book({ offerId: o.offerId, travellers: ["A B"] }), /expired/);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { setup, snapshot } from "../helpers";
import { parseOperatorMessage } from "../../services/feed";
import { Simulator } from "../../services/integrations/partners";

test("parser: real-world operator SMS/email wording, English and Hindi", () => {
  const cases: [string, string, number | undefined][] = [
    ["IRCTC: Train No 12627 dated 05-10 stands cancelled. PNR 4512345678. Refund will be processed.", "CANCELLED", undefined],
    ["Dear Customer, IndiGo flight 6E 2134 BLR-DEL is delayed by 2 hrs 15 mins. New departure 21:40.", "DELAYED", 135],
    ["Your bus with VRL Travels is running late by 45 minutes. Sorry for the inconvenience.", "DELAYED", 45],
    ["ट्रेन संख्या 12951 रद्द कर दी गई है। PNR 2345678901", "CANCELLED", undefined],
    ["आपकी ट्रेन २ घंटे देरी से चल रही है", "DELAYED", 120],
    ["Air India AI 803 has been rescheduled to 06:30.", "DELAYED", undefined],
    ["Flight QP 1102 is on time.", "ON_TIME", undefined],
  ];
  for (const [msg, status, delay] of cases) {
    const p = parseOperatorMessage(msg);
    assert.equal(p?.status, status, msg);
    assert.equal(p?.delayMin, delay, msg);
  }
  assert.deepEqual(parseOperatorMessage("IRCTC: Train No 12627 stands cancelled. PNR 4512345678")!.refs.sort(), ["12627", "4512345678"]);
  assert.ok(parseOperatorMessage("6E 2134 delayed 40 min")!.refs.includes("6E2134"));
  assert.equal(parseOperatorMessage("Happy Diwali from IRCTC! Book now."), undefined);
  assert.equal(parseOperatorMessage(""), undefined);
});

test("forwarded cancellation SMS → autopilot recovers on its own (traveller-forwarded counts as confirmed)", async () => {
  const { b, tripId } = await setup("A");
  const r = b.feed.ingestMessage(tripId, "Your bus PNR-ORIG Mumbai to Chennai stands cancelled by the operator.");
  assert.ok(r.recognised && "event" in r);
  const decisions = await b.autopilot.tick(tripId);
  assert.ok(decisions.some((d) => d.decided === "ACT"), JSON.stringify(decisions));
  assert.ok(snapshot(b, tripId).incident, "recovery started");
  assert.equal(b.feed.ingestMessage(tripId, "Diwali sale!").recognised, false);
  b.shutdown();
});

test("booking-partner status change flows into the autopilot via the feed", async () => {
  const { b, tripId } = await setup("A");
  const day = new Date(Date.now() + 6 * 3600_000).toISOString().slice(0, 10);
  const [o] = await b.partners.search({ kind: "bus", from: "Chennai", to: "Madurai", date: day });
  const bk = await b.partners.book({ offerId: o.offerId, travellers: ["Test User"], tripId });
  b.booking.addLeg(tripId, { from: o.from!, to: o.to!, mode: "BUS", departure: new Date(Date.now() + 5 * 3600_000).toISOString(), bookingRef: bk.pnr, cost: bk.totalInr, vendor: o.operator });
  Simulator.overrides.set(bk.bookingRef, { status: "DELAYED", delayMin: 40 });
  const changes = await b.feed.poll(tripId);
  assert.deepEqual(changes, [`${bk.pnr} DELAYED`]);
  assert.deepEqual(await b.feed.poll(tripId), [], "same status is not re-reported");
  b.shutdown();
});

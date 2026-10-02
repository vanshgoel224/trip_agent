process.env.FALL_CANCEL_MS = "150";
import { test } from "node:test";
import assert from "node:assert/strict";
const { FallWatch, describeFall } = await import("../../services/falls");
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const drop = { freefallMs: 450, heightM: 1.0, impactG: 4.8, tumbleDeg: 260, severity: "medium" as const, location: { lat: 30.73, lng: 79.07 } };

test("not cancelled → SOS fires once, after the window, with a human description", async () => {
  const sent: any[] = [];
  const w = new FallWatch(async (f) => (sent.push(f), { ok: true }));
  const f = w.report("u1", drop);
  assert.equal(w.report("u1", { ...drop, heightM: 3 }).fallId, f.fallId, "second report doesn't restart the countdown");
  await wait(60);
  assert.equal(sent.length, 0, "not before the deadline");
  await wait(200);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].status, "SOS_SENT");
  assert.match(describeFall(sent[0]), /1\.0 m, 4\.8 g impact, tumbled 260°.*nobody cancelled/);
  assert.equal(w.active("u1"), undefined);
});

test("cancelled in time (from any device) → no SOS; wrong id or late cancel is refused", async () => {
  const sent: any[] = [];
  const w = new FallWatch(async (f) => sent.push(f));
  const f = w.report("u2", drop);
  assert.throws(() => w.cancel("u2", "FALL-NOPE", "screen"), /No countdown/);
  assert.throws(() => w.cancel("someone-else", f.fallId, "screen"), /No countdown/);
  assert.equal(w.cancel("u2", f.fallId, "other-device").cancelledBy, "other-device");
  await wait(250);
  assert.equal(sent.length, 0);
  assert.throws(() => w.cancel("u2", f.fallId, "screen"), /No countdown/);
});

test("readings are validated and clamped; junk can't crash the watch", () => {
  const w = new FallWatch(async () => {});
  assert.throws(() => w.report("u3", { ...drop, impactG: "lots" as any }), /numbers/);
  const f = w.report("u4", { ...drop, heightM: 1e9, location: { lat: 999, lng: "x" as any }, orientationAfter: { beta: "a" } as any });
  assert.equal(f.heightM, 500);
  assert.equal(f.location, undefined);
  assert.equal(f.orientationAfter, null);
  w.stopAll();
});

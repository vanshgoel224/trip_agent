import { test } from "node:test";
import assert from "node:assert/strict";
// @ts-ignore plain JS module shared with the browser
import { FallDetector, ShakeCounter, severity } from "../../apps/web/modules/falldetect.js";

const G = 9.81;
const at = (g: number) => ({ x: 0, y: 0, z: g * G });
/** Synthetic sensor stream at 50 Hz: segments of [ms, gMagnitude, rotationDegPerSec]. */
function stream(segments: [number, number, number?][]) {
  const out: { t: number; a: { x: number; y: number; z: number }; rot: { alpha: number; beta: number; gamma: number } }[] = [];
  let t = 0;
  for (const [ms, g, rot = 0] of segments) for (let i = 0; i < ms; i += 20) out.push({ t: (t += 20), a: at(g), rot: { alpha: rot, beta: 0, gamma: 0 } });
  return out;
}
const run = (segs: [number, number, number?][], opts = {}) => {
  const falls: any[] = [];
  const d = new FallDetector((e: any) => falls.push(e), { settleMs: 0, ...opts });
  d.setOrientation(80, 5, 0); // upright in hand
  for (const s of stream(segs)) d.push(s.t, s.a, s.rot);
  return falls;
};

test("drop from ~1.2 m (free fall ~500 ms, 5 g impact, tumbling) is detected with sensible estimates", () => {
  const f = run([[1000, 1], [500, 0.05, 400], [40, 5.2], [1000, 1]]);
  assert.equal(f.length, 1);
  assert.ok(f[0].heightM > 0.9 && f[0].heightM < 1.5, `height ${f[0].heightM}`);
  assert.equal(f[0].impactG, 5.2);
  assert.ok(f[0].tumbleDeg > 150, `tumble ${f[0].tumbleDeg}`);
  assert.deepEqual(f[0].orientationBefore, { beta: 80, gamma: 5, alpha: 0 });
  assert.equal(f[0].severity, "medium");
});

test("waist-high drop and a 2 m+ fall are graded", () => {
  assert.equal(run([[500, 1], [320, 0.1], [40, 3], [500, 1]])[0]?.severity, "low");
  assert.equal(run([[500, 1], [700, 0.1], [40, 7], [500, 1]])[0]?.severity, "high");
});

test("no false alarms: walking, a hard tap on a table, a short slip, a throw-and-catch", () => {
  const walk: [number, number][] = [];
  for (let i = 0; i < 40; i++) walk.push([100, 1.6], [100, 0.6]);
  assert.equal(run(walk).length, 0, "walking");
  assert.equal(run([[500, 1], [40, 6], [500, 1]]).length, 0, "hard tap without free fall");
  assert.equal(run([[500, 1], [60, 0.1], [40, 4], [500, 1]]).length, 0, "60 ms slip (~2 cm)");
  assert.equal(run([[500, 1], [400, 0.1], [200, 1.3], [500, 1]]).length, 0, "caught softly (no impact)");
  assert.equal(run([[500, 1], [180, 0.1], [40, 3], [500, 1]]).length, 0, "below minimum height (~16 cm)");
});

test("bounce after the impact isn't a second fall", () => {
  const f = run([[500, 1], [500, 0.05], [40, 5], [150, 0.1], [40, 3], [800, 1]]);
  assert.equal(f.length, 1);
});

test("shake-to-cancel: 3 strong shakes within 4 s, not 2, not slow ones", () => {
  let n = 0;
  const s = new ShakeCounter(() => n++);
  const shake = (t: number) => s.push(t, at(2.8));
  shake(0); shake(1000); assert.equal(n, 0); shake(2000); assert.equal(n, 1);
  shake(10_000); shake(15_000); shake(20_000); assert.equal(n, 1, "too slow");
  assert.equal(severity({ heightM: 0.3, impactG: 2.5 }), "low");
});

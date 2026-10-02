import { test } from "node:test";
import assert from "node:assert/strict";
import { fmt, inr } from "../../packages/shared";

test("money: Indian grouping, compact lakh/crore, negatives, junk", () => {
  assert.equal(inr(123456), "₹1,23,456");
  assert.equal(fmt.inr(1234.5, { paise: true }), "₹1,234.50");
  assert.equal(fmt.inr(250000, { compact: true }), "₹2.5L");
  assert.equal(fmt.inr(34_000_000, { compact: true }), "₹3.4Cr");
  assert.equal(fmt.inr(-2000), "−₹2,000");
  assert.equal(fmt.inr(NaN), "₹—");
});

test("time in IST regardless of server timezone; relative time", () => {
  const d = "2026-10-02T15:35:00Z"; // 21:05 IST
  assert.match(fmt.time(d), /9:05\s?pm/i);
  assert.match(fmt.dateTime(d), /2 Oct.*9:05\s?pm/i);
  const now = Date.parse(d);
  assert.equal(fmt.relative(new Date(now - 10_000), now), "just now");
  assert.equal(fmt.relative(new Date(now - 5 * 60_000), now), "5 min ago");
  assert.equal(fmt.relative(new Date(now + 2 * 3600_000), now), "in 2 h");
  assert.equal(fmt.relative(new Date(now - 3 * 86400_000), now), "3 days ago");
  assert.equal(fmt.time("not a date"), "—");
});

test("distance, duration, phone, PNR, bytes, coordinates, clip", () => {
  assert.equal(fmt.distance(847), "850 m");
  assert.equal(fmt.distance(12_400), "12.4 km");
  assert.equal(fmt.distance(240_300), "240 km");
  assert.equal(fmt.duration(45), "45 s");
  assert.equal(fmt.duration(7500), "2 h 5 min");
  assert.equal(fmt.phone("919876543210"), "+91 98765 43210");
  assert.equal(fmt.phone("09876543210"), "+91 98765 43210");
  assert.equal(fmt.phone("+1 415 555"), "+1 415 555");
  assert.equal(fmt.maskTail("sk-ant-abcdef1234"), "••••1234");
  assert.equal(fmt.pnr("4512345678"), "451-2345678");
  assert.equal(fmt.pnr("abc123"), "ABC123");
  assert.equal(fmt.bytes(150_000), "146 KB");
  assert.equal(fmt.coords(30.7352, 79.0669), "30.7352° N, 79.0669° E");
  assert.equal(fmt.clip("The quick brown fox jumps over the lazy dog", 20), "The quick brown fox…");
});

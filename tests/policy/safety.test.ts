// Regression set from live runs: what must escalate, and everyday travel talk that must not.
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyDisruption } from "../../packages/policy";

const SAFETY = [
  "koi mera peecha kar raha hai, I'm scared", "someone is following me", "mujhe dar lag raha hai", "bachao", "there's been an accident",
  "a man is harassing me on the bus", "driver is drunk, rash driving", "I feel unsafe here", "my friend fainted", "chest pain, need a hospital",
  "Someone stole my phone and threatened me", "मुझे डर लग रहा है", "कोई पीछा कर रहा है", "i got hurt on the trek", "acident on the highway",
];
const NOT_SAFETY = [
  "bhai meri bus cancel ho gayi, main Swargate pe stuck hoon. kya karu?", "main station pe hoon", "train late hai 2 ghante", "my flight is delayed",
  "missed my connection at Mumbai", "the hotel cancelled my booking", "kya main window seat le sakta hoon", "ho gaya, thank you",
  "bus abhi tak nahi aayi", "I'm at the airport, gate changed", "split the cab fare with Rahul", "how do I say thank you in Tamil",
];

test("safety: escalates real danger in English, Hinglish and Hindi", () => {
  for (const t of SAFETY) assert.equal(classifyDisruption(t), "SAFETY", t);
});
test("safety: everyday travel talk is not escalated (no 'hoon' → 'khoon' false alarms)", () => {
  for (const t of NOT_SAFETY) assert.notEqual(classifyDisruption(t), "SAFETY", t);
});
test("route blocks", () => {
  assert.equal(classifyDisruption("landslide on the ghat road"), "ROUTE_BLOCKED");
  assert.equal(classifyDisruption("bharat bandh today, roads closed"), "ROUTE_BLOCKED");
});

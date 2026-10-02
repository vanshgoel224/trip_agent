import { test } from "node:test";
import assert from "node:assert/strict";
import { bestMatch, containsFuzzy, editDistance, normalize, score, wordMatch } from "../../packages/shared/fuzzy";
import { parseCommand, resolveLanguage } from "../../services/conversation";
import { classifyDisruption } from "../../packages/policy";
import { rulesProposal } from "../../services/models";
import { ExpenseAgent } from "../../services/agents/expenses";
import { MemoryGraph } from "../../services/memory";
import { Store } from "../../packages/db";

test("fuzzy core: case, accents, transpositions, prefixes", () => {
  assert.equal(normalize("  Café   GOA!! "), "cafe goa");
  assert.equal(editDistance("tamil", "tmail"), 1, "transposition = 1");
  assert.ok(wordMatch("aguada", "aguada") && wordMatch("agauda", "aguada") && wordMatch("calan", "calangute"));
  assert.ok(!wordMatch("bus", "bun"), "no typos on 3-letter words");
  assert.ok(score("RAHUL", "rahul") === 1 && score("raahul", "Rahul") > 0.7);
  assert.equal(bestMatch("Tamill", ["Hindi", "Tamil", "Telugu"], (x) => x)?.item, "Tamil");
  assert.equal(bestMatch("xyz", ["Hindi", "Tamil"], (x) => x), undefined);
});

test("commands are case-insensitive and typo-tolerant", () => {
  assert.deepEqual(parseCommand("/Recal Rahul"), { cmd: "recall", arg: "Rahul" });
  assert.deepEqual(parseCommand("/FORGT peanuts"), { cmd: "forget", arg: "peanuts" });
  assert.deepEqual(parseCommand("/ BTW is it hot?"), { cmd: "btw", arg: "is it hot?" });
  assert.equal(parseCommand("/recall"), undefined, "needs an argument");
  assert.equal(parseCommand("/xyzzy foo"), undefined);
  assert.equal(parseCommand("not a command"), undefined);
});

test("languages resolve from names, codes and misspellings", () => {
  assert.equal(resolveLanguage("Tamil"), "ta-IN");
  assert.equal(resolveLanguage("tamill"), "ta-IN");
  assert.equal(resolveLanguage("MALAYALAM"), "ml-IN");
  assert.equal(resolveLanguage("kn"), "kn-IN");
  assert.equal(resolveLanguage("hi-IN"), "hi-IN");
});

test("disruption and safety keywords survive typos and caps", () => {
  assert.equal(classifyDisruption("there was an ACIDENT on the highway"), "SAFETY");
  assert.equal(classifyDisruption("I feel UNSAFE"), "SAFETY");
  assert.equal(classifyDisruption("landslid on the ghat"), "ROUTE_BLOCKED");
  assert.equal(rulesProposal("my bus got cancled").intent, "REPORT_DISRUPTION");
  assert.equal(rulesProposal("train DELAYD by 3 hrs").intent, "REPORT_DISRUPTION");
  assert.ok(containsFuzzy("hospitl nearby?", ["hospital"]));
  assert.ok(!containsFuzzy("I love this place", ["hospital", "accident"]));
});

test("people's names in expenses merge across case and typos", () => {
  const e = new ExpenseAgent(new Store());
  e.add("g", { description: "cab", amount: 600, paidBy: "me", splitAmong: ["Me", "rahul", "PRIYA"] });
  e.add("g", { description: "tea", amount: 90, paidBy: "Raahul", splitAmong: ["mai", "Rahul ", "priya"] });
  assert.deepEqual(Object.keys(e.balances("g")).sort(), ["Me", "Priya", "Rahul"]);
});

test("memory recall and dedup tolerate typos; forget needs a strong match", () => {
  const m = new MemoryGraph(new Store());
  m.remember({ subject: "Rahul", subject_type: "person", relation: "allergic to", object: "peanuts", object_type: "fact" }, "c");
  m.remember({ subject: "rahul", subject_type: "person", relation: "likes", object: "Fish curry", object_type: "preference" }, "c");
  assert.equal(m.nodes().filter((n) => n.type === "person").length, 1, "Rahul/rahul = one node");
  assert.equal(m.search("raul")[0]?.label, "Rahul");
  assert.equal(m.search("peanut")[0]?.label, "peanuts");
  assert.ok(m.recall("is raahul coming?").some((f) => f.includes("peanuts")));
  assert.deepEqual(m.forget("fsh"), [], "weak match does not delete");
  assert.deepEqual(m.forget("fish cury"), ["Fish curry"]);
});

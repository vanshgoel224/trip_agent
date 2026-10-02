// CLI walkthrough of every demo scenario. Usage: npm run demo
import { createBiruni } from "../../services/runtime";
import { SCENARIOS, seedScenario, type ScenarioName } from "../../services/integrations/scenarios";
import { bus, type BiruniEvent } from "../../packages/events";
import type { MockPaymentProvider } from "../../services/integrations/pine-labs";

const UNDO_MS = Number(process.env.DEMO_UNDO_MS ?? 300);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

const b = createBiruni({ undoWindowMs: UNDO_MS });
let current = "";
bus.on("event", (e: BiruniEvent) => {
  if (e.tripId !== current) return;
  if (["STEP", "VOICE", "MCP_CALL", "AGENT_FAILED", "RECONCILED", "LADDER", "UNDO_OPEN", "UNDO_EXPIRED"].includes(e.type))
    console.log(`  [${e.agent.padEnd(12)}] ${e.type.padEnd(12)} ${e.detail}`);
});

for (const name of Object.keys(SCENARIOS) as ScenarioName[]) {
  const s = await seedScenario(b, name);
  current = s.tripId;
  console.log(`\n=== Scenario ${name}: ${s.title} ===\n  traveller: "${s.trigger}"`);
  const res = await b.orchestrator.handleMessage(s.tripId, s.trigger);
  console.log(`  biruni: ${res.reply}`);
  await wait(UNDO_MS + 150);
  const snap = b.orchestrator.snapshot(s.tripId);
  console.log(`  → trip ${snap.trip.status}, incident ${snap.incident?.step}${snap.incident?.stopReason ? ` (${snap.incident.stopReason})` : ""}, remaining authority ${snap.ledger ? "₹" + snap.ledger.remainingIncident : "-"}`);
}
console.log(`\nPine Labs mock charge calls: ${(b.providers.payments as MockPaymentProvider).chargeCalls}`);
b.shutdown();

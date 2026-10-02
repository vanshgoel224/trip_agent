// Tests run on the deterministic rules path: never call real models.
delete process.env.ONLINE_MODEL_API_KEY;
delete process.env.GEMINI_API_KEY;
process.env.OFFLINE_MODEL_CONFIG = "off";
process.env.PROVIDER_MODE = "mock";

import { createBiruni, type Biruni } from "../../services/runtime";
import { seedScenario, type ScenarioName } from "../../services/integrations/scenarios";
import type { MockPaymentProvider } from "../../services/integrations/pine-labs";

export const UNDO_MS = 80;
export const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function setup(name: ScenarioName, opts: { undoWindowMs?: number; dbPath?: string } = {}) {
  const b = createBiruni({ undoWindowMs: opts.undoWindowMs ?? UNDO_MS, dbPath: opts.dbPath });
  const s = await seedScenario(b, name);
  return { b, ...s, payments: b.providers.payments as MockPaymentProvider };
}

export function snapshot(b: Biruni, tripId: string) {
  return b.orchestrator.snapshot(tripId);
}

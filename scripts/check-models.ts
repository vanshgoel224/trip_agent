// Pings the online (Nemotron) and offline (Qwen) models with sample traveller
// messages and shows what each proposes. Usage: npm run models:check
import { chat, extractJson, offlineEndpoint, onlineEndpoint, rulesProposal } from "../services/models";

const SAMPLES = ["My bus to Chennai was cancelled", "There was an accident and I feel unsafe", "undo"];
const timeout = Number(process.env.MODEL_TIMEOUT_MS ?? 60000);

for (const [label, ep, hint] of [
  ["online (Nemotron)", onlineEndpoint(), "set ONLINE_MODEL_API_KEY (NVIDIA API key)"],
  ["offline (Qwen)", offlineEndpoint(), 'run Ollama with the model pulled, or set OFFLINE_MODEL_CONFIG'],
] as const) {
  console.log(`\n== ${label} ==`);
  if (!ep) {
    console.log(`  not configured: ${hint}`);
    continue;
  }
  console.log(`  ${ep.model} @ ${ep.baseUrl}`);
  for (const text of SAMPLES) {
    const t0 = Date.now();
    try {
      const raw = await chat(ep, text, timeout);
      let parsed: unknown;
      try {
        parsed = extractJson(raw);
      } catch (e) {
        parsed = `UNPARSEABLE (${(e as Error).message})`;
      }
      console.log(`  ${Date.now() - t0}ms  "${text}" → ${JSON.stringify(parsed)}   [rules: ${rulesProposal(text).intent}]`);
    } catch (e) {
      console.log(`  FAILED after ${Date.now() - t0}ms: ${(e as Error).message}`);
      break;
    }
  }
}

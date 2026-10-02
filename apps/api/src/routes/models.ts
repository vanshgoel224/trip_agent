// Routes: models (bring your own key).
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { createBiruni } from "../../../../services/runtime";
import { SCENARIOS, createCustomTrip, seedScenario, type ScenarioName } from "../../../../services/integrations/scenarios";
import { CHAT_MODES, DEFAULT_EMOJI, TOOL_GROUPS, type ChatMode } from "../../../../services/orchestrator/chats";
import { LANGUAGES } from "../../../../services/conversation";
import { audioCache } from "../../../../services/agents/voice";
import { GoogleCalendar } from "../../../../services/integrations/google-calendar";
import { redditConfigured } from "../../../../services/integrations/reddit";
import { youtubeConfigured } from "../../../../services/integrations/youtube";
import { splitwiseConfigured } from "../../../../services/agents/expenses";
import { providerStatus } from "../../../../services/integrations";
import { ZerodhaProvider } from "../../../../services/integrations/zerodha";
import { SetuProvider } from "../../../../services/integrations/setu-aa";
import { chat as modelChat, GENERIC_SYSTEM, endpointChain, listModels, onlineEndpoint, offlineEndpoint, PRESETS, type ProviderConfig } from "../../../../services/models";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { Vault, type Cipher } from "../../../../packages/db/vault";
import { authorized, handleRemoteMcp, remoteMcpEnabled } from "../../../../services/mcp/remote";
import { WebSocketServer } from "ws";
import { Telephony } from "../../../../services/telephony";
import type { Biruni } from "../../../../services/runtime";
import { mkdir, writeFile } from "node:fs/promises";
import { bus, type BiruniEvent } from "../../../../packages/events";
import { BiruniError, config } from "../../../../packages/shared";
import type { Incident, TripState } from "../../../../packages/domain";

import type { RouteFn } from "../http";
import { rt, me, cal, spaces } from "../spaces";

export default function register(route: RouteFn) {
// ---------- models (bring your own key) ----------

route("GET", "/api/models/presets", () => ({ presets: PRESETS }));
route("GET", "/api/models/providers", async () => ({ providers: rt().modelSettings.view(), active: (await endpointChain(true).catch(() => [])).map((e) => ({ provider: e.provider ?? "env", model: e.model, tier: e.tier, tools: e.tools !== false })) }));
route("POST", "/api/models/providers", (_req, body) => {
  rt().modelSettings.save(body.providers);
  return { providers: rt().modelSettings.view() };
});
// Load a provider's real model list. Uses the typed key, or the saved one for an existing row.
route("POST", "/api/models/list", async (_req, body) => {
  const p = { ...body, apiKey: body.apiKey && !String(body.apiKey).startsWith("••••") ? body.apiKey : body.id ? rt().modelSettings.keyFor(body.id) : undefined } as ProviderConfig;
  if (!(p.provider in PRESETS)) throw new BiruniError("INVALID_REQUEST", "unknown provider");
  try {
    return { models: await listModels(p) };
  } catch (e) {
    throw new BiruniError("EXTERNAL_FAILURE", `Could not list models: ${(e as Error).message}`);
  }
});
// One short round-trip through the current chain, to prove the keys work.
route("POST", "/api/models/test", async () => {
  const chain = await endpointChain(true).catch(() => []);
  if (!chain.length) return { ok: false, message: "No model reachable. Add a provider with a key (or start your local model)." };
  const results = [];
  for (const ep of chain) {
    const t = Date.now();
    try {
      const out = await modelChat(ep, "Reply with exactly: OK", 20_000, GENERIC_SYSTEM);
      results.push({ provider: ep.provider ?? "env", model: ep.model, ok: true, ms: Date.now() - t, reply: out.slice(0, 40) });
    } catch (e) {
      results.push({ provider: ep.provider ?? "env", model: ep.model, ok: false, ms: Date.now() - t, error: String((e as Error).message).slice(0, 160) });
    }
  }
  return { ok: results.some((r) => r.ok), results };
});
}

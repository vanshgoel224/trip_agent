// Routes: connections.
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
import { healthCheck } from "../../../../services/integrations/health";
import { rt, me, cal, spaces } from "../spaces";

/** OAuth state → user, so Google's redirect (no session cookie: SameSite=Strict) lands in the right space. */
export const oauthStates = new Map<string, string>();

export default function register(route: RouteFn) {
  route("GET", "/api/integrations/health", () => healthCheck(rt()));
// ---------- connections ----------

route("GET", "/api/connections", () => {
  const on = onlineEndpoint();
  return {
    models: {
      online: on ? { provider: on.baseUrl.includes("googleapis") ? "Gemini (stand-in)" : "Nemotron", model: on.model } : null,
      offline: offlineEndpoint() ? { provider: offlineEndpoint()!.provider === "hermes" ? "Hermes Agent (tools off)" : "Ollama", model: offlineEndpoint()!.model } : null,
      custom: rt().modelSettings.view().map((p) => ({ provider: p.provider, model: p.model ?? PRESETS[p.provider].defaultModel, enabled: p.enabled !== false })),
      lastError: rt().models.describe().lastError,
    },
    rails: { ...providerStatus(rt().providers), delhivery: rt().delhivery.status() },
    travel: rt().partners.status(),
    operatorFeed: rt().feed.status(),
    telephony: rt().telephony.status(),
    calendar: cal().status(),
    reddit: { configured: redditConfigured(), note: redditConfigured() ? "OAuth app" : "anonymous (often blocked from cloud IPs)" },
    youtube: { configured: youtubeConfigured() },
    splitwise: { configured: splitwiseConfigured() },
    maps: { provider: "OpenStreetMap data · MapLibre map · Nominatim, Overpass, OSRM", configured: true },
    voice: { mode: rt().voice.live ? "Gnani" : "Device built-in voices (browser speech)" },
    mcpServers: rt().mcpClients.list(),
  };
});
route("GET", "/api/calendar/connect", () => {
  const state = randomBytes(16).toString("hex");
  oauthStates.set(state, me().userId);
  return { redirect: cal().authUrl(state) };
});
route("GET", "/api/calendar/callback", async (_r, _b, _p, url) => {
  const state = url.searchParams.get("state") ?? "";
  if (!oauthStates.delete(state)) throw new BiruniError("AUTH_FAILURE", "invalid OAuth state");
  const code = url.searchParams.get("code");
  if (!code) throw new BiruniError("AUTH_FAILURE", url.searchParams.get("error") ?? "no code");
  await cal().handleCallback(code);
  return { redirect: "/?calendar=connected" };
});
route("GET", "/api/zerodha/login", () => {
  if (!process.env.ZERODHA_API_KEY) throw new BiruniError("AUTH_FAILURE", "Set ZERODHA_API_KEY and ZERODHA_API_SECRET");
  return { redirect: ZerodhaProvider.loginUrl() };
});
route("GET", "/api/zerodha/callback", async (_r, _b, _p, url) => {
  const rt = url.searchParams.get("request_token");
  if (!rt) throw new BiruniError("AUTH_FAILURE", "no request_token");
  await ZerodhaProvider.exchange(rt);
  return { redirect: "/?zerodha=connected" };
});
route("POST", "/api/aa/consent", async (_r, body) => {
  const fin = rt().providers.financial;
  if (!(fin instanceof SetuProvider)) throw new BiruniError("AUTH_FAILURE", "Setu AA is simulated: set SETU_ACCESS_TOKEN and SETU_PRODUCT_INSTANCE_ID");
  return fin.createConsent(String(body.vua ?? ""));
});
route("GET", "/api/delhivery/bookings", (_r, _b, _p, url) => rt().delhivery.list(url.searchParams.get("tripId") || undefined).map((p) => rt().delhivery.track(p.bookingId)));
route("GET", "/api/mcp/servers", () => rt().mcpClients.list());
route("POST", "/api/mcp/servers", (_r, body) => rt().mcpClients.add({ name: String(body.name ?? ""), url: String(body.url ?? ""), transport: body.transport, headers: body.headers }));
route("POST", "/api/mcp/servers/:id/reconnect", async (_r, _b, p) => (await rt().mcpClients.connect(p.id), rt().mcpClients.list()));
route("POST", "/api/mcp/servers/:id/delete", async (_r, _b, p) => (await rt().mcpClients.remove(p.id), rt().mcpClients.list()));
}

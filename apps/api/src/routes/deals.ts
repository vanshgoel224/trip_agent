// Routes: negotiator.
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
// ---------- negotiator ----------
route("GET", "/api/deals", (_r, _b, _p, url) => rt().negotiator.list(url.searchParams.get("tripId") || undefined));
route("GET", "/api/deals/:dealId", (_r, _b, p) => rt().negotiator.get(p.dealId) ?? (() => { throw new BiruniError("INVALID_REQUEST", "unknown deal"); })());
route("POST", "/api/deals/:dealId/reply", (_r, body, p) => rt().negotiator.counterpartySaid(p.dealId, String(body.text ?? "")));
route("POST", "/api/deals/:dealId/cancel", (_r, _b, p) => rt().negotiator.cancel(p.dealId));
// WhatsApp Cloud API webhook: verification (GET) + inbound messages (POST).
route("GET", "/api/whatsapp/webhook", (_r, _b, _p, url) => {
  if (url.searchParams.get("hub.mode") === "subscribe" && url.searchParams.get("hub.verify_token") === process.env.WHATSAPP_VERIFY_TOKEN && process.env.WHATSAPP_VERIFY_TOKEN)
    return { __raw: url.searchParams.get("hub.challenge") ?? "" };
  throw new BiruniError("AUTH_FAILURE", "verification failed");
});
route("POST", "/api/whatsapp/webhook", async (req, body) => {
  // Only accept Meta-signed deliveries: anyone else could fake a "driver reply".
  const secret = process.env.WHATSAPP_APP_SECRET;
  if (!secret) throw new BiruniError("AUTH_FAILURE", "set WHATSAPP_APP_SECRET to accept WhatsApp webhooks");
  const sig = String(req.headers["x-hub-signature-256"] ?? "");
  const expected = "sha256=" + createHmac("sha256", secret).update((req as any).rawBody ?? "").digest("hex");
  if (sig.length !== expected.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) throw new BiruniError("AUTH_FAILURE", "bad signature");
  const msgs = (body.entry ?? []).flatMap((e: any) => (e.changes ?? []).flatMap((c: any) => c.value?.messages ?? []));
  for (const m of msgs) if (m.type === "text") await rt().negotiator.inboundWhatsApp(String(m.from), String(m.text?.body ?? "")).catch(() => {});
  return { ok: true };
});
}

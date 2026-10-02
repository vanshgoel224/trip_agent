// Routes: travel booking partners, operator status feed.
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
// ---------- travel booking partners ----------
route("GET", "/api/travel/partners", () => rt().partners.status());
route("POST", "/api/travel/search", (_r, body) => rt().partners.search({ kind: body.kind, from: body.from, to: body.to, city: body.city, date: String(body.date ?? ""), nights: Number(body.nights) || undefined, passengers: Number(body.passengers) || undefined, maxPrice: Number(body.maxPrice) || undefined }));
route("GET", "/api/travel/bookings", (_r, _b, _p, url) => rt().partners.list(url.searchParams.get("tripId") ?? undefined));
route("POST", "/api/travel/bookings/:ref/refresh", (_r, _b, p) => rt().partners.refresh(p.ref));

// ---------- operator status feed ----------
route("GET", "/api/feed/status", () => rt().feed.status());
route("POST", "/api/feed/message", async (_r, body) => {
  const r = rt().feed.ingestMessage(String(body.tripId ?? ""), String(body.text ?? ""));
  return { ...r, decisions: r.recognised && "event" in r ? await rt().autopilot.tick(String(body.tripId)) : [] };
});
}

// Routes: phone sensors & maps.
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
// ---------- phone sensors & maps ----------
route("POST", "/api/device/location", (_r, body) => rt().devices.recordLocation(body.tripId || undefined, { lat: Number(body.lat), lng: Number(body.lng), accuracy: body.accuracy, speed: body.speed, heading: body.heading }));
route("POST", "/api/device/impact", (_r, body) => {
  if (!body.tripId) throw new BiruniError("INVALID_REQUEST", "tripId required");
  return rt().devices.impact(body.tripId, { peakG: Number(body.peakG), stillSeconds: body.stillSeconds });
});
route("POST", "/api/device/ok", (_r, body) => ({ cancelled: rt().devices.imOk(String(body.tripId)) }));
route("GET", "/api/device/state", (_r, _b, _p, url) => {
  const tripId = url.searchParams.get("tripId") || undefined;
  return { location: rt().devices.latest(tripId), route: rt().devices.route(tripId), checkin: tripId ? rt().devices.checkinActive(tripId) : false };
});
}

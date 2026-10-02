// Routes: L4 autopilot.
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
// ---------- L4 autopilot ----------
route("GET", "/api/autopilot/:tripId", (_r, _b, p) => ({ enabled: rt().autopilot.enabled(p.tripId), decisions: rt().autopilot.decisions(p.tripId) }));
route("POST", "/api/autopilot/:tripId", (_r, body, p) => (rt().autopilot.setEnabled(p.tripId, !!body.enabled), { enabled: rt().autopilot.enabled(p.tripId) }));
route("POST", "/api/autopilot/:tripId/tick", (_r, _b, p) => rt().autopilot.tick(p.tripId));
// Demo hook: what a real operator status feed would push.
route("POST", "/api/sim/operator", async (_r, body) => {
  const trip = rt().orchestrator.trip(String(body.tripId));
  const leg = trip.itinerary.legs.find((l) => l.legId === body.legId) ?? trip.itinerary.legs.find((l) => l.status === "CONFIRMED" || l.status === "PLANNED");
  if (!leg) throw new BiruniError("INVALID_REQUEST", "no active leg");
  const ev = rt().autopilot.operatorEvent(trip.tripId, { legId: leg.legId, status: body.status ?? "CANCELLED", delayMin: body.delayMin, source: body.source });
  const decisions = await rt().autopilot.tick(trip.tripId);
  return { event: ev, decisions };
});
}

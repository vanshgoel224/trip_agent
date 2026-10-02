// Routes: trips, incidents & recovery, voice, demo, trips (own trips).
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
const incident = (incidentId: string) => {
  const inc = rt().store.get<Incident>("incidents", incidentId);
  if (!inc) throw new BiruniError("INVALID_REQUEST", `unknown incident ${incidentId}`);
  return inc;
};

// ---------- trips ----------
route("POST", "/api/trips", (_r, body) => rt().orchestrator.createTrip(body));
route("GET", "/api/trips/:tripId", (_r, _b, p) => rt().orchestrator.snapshot(p.tripId));
route("POST", "/api/trips/:tripId/message", (_r, body, p) => rt().orchestrator.handleMessage(p.tripId, String(body.text ?? "")));
route("POST", "/api/trips/:tripId/prepare", (_r, _b, p) => rt().orchestrator.prepareTrip(p.tripId));
route("POST", "/api/trips/:tripId/connectivity", (_r, body, p) => rt().orchestrator.setConnectivity(p.tripId, !!body.online));
route("POST", "/api/trips/:tripId/battery", (_r, body, p) => rt().orchestrator.battery(p.tripId, Number(body.pct)));
route("GET", "/api/trips/:tripId/agents", (_r, _b, p) => rt().orchestrator.router.runs({ tripId: p.tripId }));

// ---------- incidents & recovery ----------
route("POST", "/api/incidents", (_r, body) => rt().orchestrator.reportDisruption(body.tripId, body.description, body.legId));
route("GET", "/api/incidents/:incidentId", (_r, _b, p) => incident(p.incidentId));
route("POST", "/api/recovery/start", (_r, body) => rt().orchestrator.reportDisruption(body.tripId, body.description ?? "Disruption reported", body.legId));
route("POST", "/api/recovery/:incidentId/approve", async (_r, body, p) => {
  incident(p.incidentId);
  if (body.approve === false) return rt().orchestrator.decline(p.incidentId);
  return rt().orchestrator.approve(p.incidentId);
});
route("POST", "/api/recovery/:incidentId/cancel", async (_r, _b, p) => ({ undone: await rt().orchestrator.undo(incident(p.incidentId).incidentId) }));
route("GET", "/api/authority/:incidentId", (_r, _b, p) => rt().finance.ledger(incident(p.incidentId).incidentId));
route("GET", "/api/audit/:incidentId", (_r, _b, p) => rt().compliance.trace(incident(p.incidentId).incidentId));

// ---------- voice ----------
route("POST", "/api/voice/inbound", async (_r, body) => {
  const text = await rt().providers.voice.transcribe({ text: body.text, audioBase64: body.audioBase64 }, body.language ?? "en-IN");
  return rt().orchestrator.handleMessage(body.tripId, text);
});
route("POST", "/api/voice/outbound", (_r, body) => rt().voice.say(body.tripId, String(body.text), { kind: "OUTBOUND" }));

// ---------- demo ----------
route("GET", "/api/scenarios", () => Object.entries(SCENARIOS).map(([name, s]) => ({ name, ...s })));
route("POST", "/api/scenarios/:name", async (_r, _b, p) => {
  if (!(p.name in SCENARIOS)) throw new BiruniError("INVALID_REQUEST", `unknown scenario ${p.name}`);
  return seedScenario(rt(), p.name as ScenarioName);
});
route("GET", "/api/mcp/tools", () => rt().mcp.listTools());
route("GET", "/api/health", () => ({ ok: true, providerMode: config.providerMode, undoWindowMs: config.undoWindowMs, models: rt().models.describe() }));

// ---------- trips (own trips) ----------
route("GET", "/api/trips", (_r, _b, _p, url) =>
  rt().store.list<TripState>("trips").filter((t) => url.searchParams.get("all") === "1" || !t.archived).sort((x, y) => y.createdAt.localeCompare(x.createdAt)).map((t) => ({ tripId: t.tripId, title: t.title, origin: t.itinerary.origin, destination: t.itinerary.destination, status: t.status, archived: !!t.archived, createdAt: t.createdAt })),
);
route("POST", "/api/trips/:tripId/update", (_r, body, p) => rt().orchestrator.updateTrip(p.tripId, { title: body.title, archived: body.archived }));
route("POST", "/api/trips/:tripId/delete", (_r, _b, p) => rt().orchestrator.deleteTrip(p.tripId));
route("POST", "/api/trips/quick", async (_r, body) => {
  if (!body.origin || !body.destination || !body.departure) throw new BiruniError("INVALID_REQUEST", "origin, destination and departure are required");
  return createCustomTrip(rt(), body);
});
}

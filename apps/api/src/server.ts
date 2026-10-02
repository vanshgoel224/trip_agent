// Biruni API (spec §23). The MCP server stays behind this backend and is never
// exposed to the browser; credentials stay server-side.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { createBiruni } from "../../../services/runtime";
import { SCENARIOS, createCustomTrip, seedScenario, type ScenarioName } from "../../../services/integrations/scenarios";
import { CHAT_MODES, type ChatMode } from "../../../services/orchestrator/chats";
import { LANGUAGES } from "../../../services/conversation";
import { audioCache } from "../../../services/agents/voice";
import { GoogleCalendar } from "../../../services/integrations/google-calendar";
import { redditConfigured } from "../../../services/integrations/reddit";
import { youtubeConfigured } from "../../../services/integrations/youtube";
import { splitwiseConfigured } from "../../../services/agents/expenses";
import { providerStatus } from "../../../services/integrations";
import { ZerodhaProvider } from "../../../services/integrations/zerodha";
import { SetuProvider } from "../../../services/integrations/setu-aa";
import { onlineEndpoint, offlineEndpoint } from "../../../services/models";
import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { bus, type BiruniEvent } from "../../../packages/events";
import { BiruniError, config } from "../../../packages/shared";
import type { Incident, TripState } from "../../../packages/domain";

const b = createBiruni({ dbPath: config.dbPath });
const WEB_ROOT = fileURLToPath(new URL("../../web/", import.meta.url));

type Handler = (req: IncomingMessage, body: any, params: Record<string, string>, url: URL) => Promise<unknown> | unknown;
const routes: { method: string; pattern: RegExp; keys: string[]; handler: Handler }[] = [];
function route(method: string, path: string, handler: Handler) {
  const keys: string[] = [];
  const pattern = new RegExp("^" + path.replace(/:(\w+)/g, (_, k) => (keys.push(k), "([^/]+)")) + "$");
  routes.push({ method, pattern, keys, handler });
}

const incident = (incidentId: string) => {
  const inc = b.store.get<Incident>("incidents", incidentId);
  if (!inc) throw new BiruniError("INVALID_REQUEST", `unknown incident ${incidentId}`);
  return inc;
};

// ---------- trips ----------
route("POST", "/api/trips", (_r, body) => b.orchestrator.createTrip(body));
route("GET", "/api/trips/:tripId", (_r, _b, p) => b.orchestrator.snapshot(p.tripId));
route("POST", "/api/trips/:tripId/message", (_r, body, p) => b.orchestrator.handleMessage(p.tripId, String(body.text ?? "")));
route("POST", "/api/trips/:tripId/prepare", (_r, _b, p) => b.orchestrator.prepareTrip(p.tripId));
route("POST", "/api/trips/:tripId/connectivity", (_r, body, p) => b.orchestrator.setConnectivity(p.tripId, !!body.online));
route("POST", "/api/trips/:tripId/battery", (_r, body, p) => b.orchestrator.battery(p.tripId, Number(body.pct)));
route("GET", "/api/trips/:tripId/agents", (_r, _b, p) => b.orchestrator.router.runs({ tripId: p.tripId }));

// ---------- incidents & recovery ----------
route("POST", "/api/incidents", (_r, body) => b.orchestrator.reportDisruption(body.tripId, body.description, body.legId));
route("GET", "/api/incidents/:incidentId", (_r, _b, p) => incident(p.incidentId));
route("POST", "/api/recovery/start", (_r, body) => b.orchestrator.reportDisruption(body.tripId, body.description ?? "Disruption reported", body.legId));
route("POST", "/api/recovery/:incidentId/approve", async (_r, body, p) => {
  incident(p.incidentId);
  if (body.approve === false) return b.orchestrator.decline(p.incidentId);
  return b.orchestrator.approve(p.incidentId);
});
route("POST", "/api/recovery/:incidentId/cancel", async (_r, _b, p) => ({ undone: await b.orchestrator.undo(incident(p.incidentId).incidentId) }));
route("GET", "/api/authority/:incidentId", (_r, _b, p) => b.finance.ledger(incident(p.incidentId).incidentId));
route("GET", "/api/audit/:incidentId", (_r, _b, p) => b.compliance.trace(incident(p.incidentId).incidentId));

// ---------- voice ----------
route("POST", "/api/voice/inbound", async (_r, body) => {
  const text = await b.providers.voice.transcribe({ text: body.text, audioBase64: body.audioBase64 }, body.language ?? "en-IN");
  return b.orchestrator.handleMessage(body.tripId, text);
});
route("POST", "/api/voice/outbound", (_r, body) => b.voice.say(body.tripId, String(body.text), { kind: "OUTBOUND" }));

// ---------- demo ----------
route("GET", "/api/scenarios", () => Object.entries(SCENARIOS).map(([name, s]) => ({ name, ...s })));
route("POST", "/api/scenarios/:name", async (_r, _b, p) => {
  if (!(p.name in SCENARIOS)) throw new BiruniError("INVALID_REQUEST", `unknown scenario ${p.name}`);
  return seedScenario(b, p.name as ScenarioName);
});
route("GET", "/api/mcp/tools", () => b.mcp.listTools());
route("GET", "/api/health", () => ({ ok: true, providerMode: config.providerMode, undoWindowMs: config.undoWindowMs, models: b.models.describe() }));

// ---------- trips (own trips) ----------
route("GET", "/api/trips", () =>
  b.store.list<TripState>("trips").sort((x, y) => y.createdAt.localeCompare(x.createdAt)).map((t) => ({ tripId: t.tripId, origin: t.itinerary.origin, destination: t.itinerary.destination, status: t.status, createdAt: t.createdAt })),
);
route("POST", "/api/trips/quick", async (_r, body) => {
  if (!body.origin || !body.destination || !body.departure) throw new BiruniError("INVALID_REQUEST", "origin, destination and departure are required");
  return createCustomTrip(b, body);
});

// ---------- chats ----------
route("GET", "/api/chat-modes", () => Object.entries(CHAT_MODES).map(([mode, m]) => ({ mode, label: m.label, icon: m.icon })));
route("GET", "/api/chats", () => b.chats.list());
route("POST", "/api/chats", (_r, body) => {
  if (!(body.mode in CHAT_MODES)) throw new BiruniError("INVALID_REQUEST", "unknown chat mode");
  return b.conversation.newChat(body.mode as ChatMode, body.tripId || undefined, body.title);
});
route("GET", "/api/chats/:chatId", (_r, _b, p) => {
  const chat = b.chats.get(p.chatId);
  if (!chat) throw new BiruniError("INVALID_REQUEST", "unknown chat");
  return { chat, messages: b.chats.messages(p.chatId) };
});
route("POST", "/api/chats/:chatId/messages", (_r, body, p) => b.conversation.send(p.chatId, String(body.text ?? ""), { targetLanguage: body.targetLanguage, sourceLanguage: body.sourceLanguage }));
route("POST", "/api/chats/:chatId/trip", (_r, body, p) => b.chats.update(p.chatId, { tripId: body.tripId || undefined }));
route("POST", "/api/chats/:chatId/delete", (_r, _b, p) => (b.chats.remove(p.chatId), { ok: true }));

// ---------- memory graph (graphify format) ----------
route("GET", "/api/memory/graph", () => b.memory.exportGraphify());
route("GET", "/api/memory/report", () => ({ markdown: b.memory.report() }));
route("POST", "/api/memory/export", async () => {
  const dir = process.env.MEMORY_OUT_DIR || "memory-out";
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "graph.json"), JSON.stringify(b.memory.exportGraphify(), null, 2));
  await writeFile(join(dir, "GRAPH_REPORT.md"), b.memory.report());
  return { written: [join(dir, "graph.json"), join(dir, "GRAPH_REPORT.md")] };
});

// ---------- translation & voice ----------
route("GET", "/api/languages", () => LANGUAGES.map((l) => ({ ...l, gnaniVoice: l.gnani && b.voice.live })));
route("POST", "/api/translate", (_r, body) => b.conversation.translate(String(body.text ?? ""), body.from ?? "auto", body.to ?? "hi-IN"));
route("POST", "/api/voice/translate", (_r, body) => b.conversation.voiceTranslate({ text: body.text, audioBase64: body.audioBase64, mime: body.mime, from: body.from ?? "auto", to: body.to ?? "hi-IN" }));
route("POST", "/api/voice/tts", (_r, body) => b.voice.synthesize(String(body.text ?? "").slice(0, 1000), body.language ?? "en-IN"));
route("POST", "/api/voice/stt", (_r, body) => b.voice.transcribe({ audioBase64: body.audioBase64, mime: body.mime, text: body.text }, body.language ?? "en-IN"));

// ---------- phone sensors & maps ----------
route("POST", "/api/device/location", (_r, body) => b.devices.recordLocation(body.tripId || undefined, { lat: Number(body.lat), lng: Number(body.lng), accuracy: body.accuracy, speed: body.speed, heading: body.heading }));
route("POST", "/api/device/impact", (_r, body) => {
  if (!body.tripId) throw new BiruniError("INVALID_REQUEST", "tripId required");
  return b.devices.impact(body.tripId, { peakG: Number(body.peakG), stillSeconds: body.stillSeconds });
});
route("POST", "/api/device/ok", (_r, body) => ({ cancelled: b.devices.imOk(String(body.tripId)) }));
route("GET", "/api/device/state", (_r, _b, _p, url) => {
  const tripId = url.searchParams.get("tripId") || undefined;
  return { location: b.devices.latest(tripId), route: b.devices.route(tripId), checkin: tripId ? b.devices.checkinActive(tripId) : false };
});

// ---------- connections ----------
const calendar = new GoogleCalendar(b.store);
const oauthStates = new Set<string>();
route("GET", "/api/connections", () => {
  const on = onlineEndpoint();
  return {
    models: {
      online: on ? { provider: on.baseUrl.includes("googleapis") ? "Gemini (stand-in)" : "Nemotron", model: on.model } : null,
      offline: offlineEndpoint() ? { provider: "Qwen (Ollama)", model: offlineEndpoint()!.model } : null,
      lastError: b.models.describe().lastError,
    },
    rails: providerStatus(b.providers),
    calendar: calendar.status(),
    reddit: { configured: redditConfigured(), note: redditConfigured() ? "OAuth app" : "anonymous (often blocked from cloud IPs)" },
    youtube: { configured: youtubeConfigured() },
    splitwise: { configured: splitwiseConfigured() },
    maps: { provider: "OpenStreetMap (Nominatim, Overpass, OSRM)", configured: true },
    mcpServers: b.mcpClients.list(),
  };
});
route("GET", "/api/calendar/connect", () => {
  const state = randomBytes(16).toString("hex");
  oauthStates.add(state);
  return { redirect: calendar.authUrl(state) };
});
route("GET", "/api/calendar/callback", async (_r, _b, _p, url) => {
  const state = url.searchParams.get("state") ?? "";
  if (!oauthStates.delete(state)) throw new BiruniError("AUTH_FAILURE", "invalid OAuth state");
  const code = url.searchParams.get("code");
  if (!code) throw new BiruniError("AUTH_FAILURE", url.searchParams.get("error") ?? "no code");
  await calendar.handleCallback(code);
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
  if (!(b.providers.financial instanceof SetuProvider)) throw new BiruniError("AUTH_FAILURE", "Setu AA is simulated: set SETU_ACCESS_TOKEN and SETU_PRODUCT_INSTANCE_ID");
  return b.providers.financial.createConsent(String(body.vua ?? ""));
});
route("GET", "/api/mcp/servers", () => b.mcpClients.list());
route("POST", "/api/mcp/servers", (_r, body) => b.mcpClients.add({ name: String(body.name ?? ""), url: String(body.url ?? ""), transport: body.transport, headers: body.headers }));
route("POST", "/api/mcp/servers/:id/reconnect", async (_r, _b, p) => (await b.mcpClients.connect(p.id), b.mcpClients.list()));
route("POST", "/api/mcp/servers/:id/delete", async (_r, _b, p) => (await b.mcpClients.remove(p.id), b.mcpClients.list()));

// ---------- plumbing ----------
const STATUS: Record<string, number> = { INVALID_REQUEST: 400, AUTH_FAILURE: 401, POLICY_BLOCKED: 403, AUTHORITY_EXCEEDED: 403, OBLIGATION_BLOCKED: 403, USER_REQUIRED: 409, ALREADY_COMPLETED: 409, RATE_LIMIT: 429, TIMEOUT: 504 };
const MIME: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml" };

function send(res: ServerResponse, code: number, data: unknown) {
  res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(data));
}

async function readBody(req: IncomingMessage) {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 15_000_000) throw new BiruniError("INVALID_REQUEST", "body too large");
  }
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new BiruniError("INVALID_REQUEST", "invalid JSON");
  }
}

function sse(req: IncomingMessage, res: ServerResponse, url: URL) {
  const tripId = url.searchParams.get("tripId");
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
  res.write(": connected\n\n");
  const on = (e: BiruniEvent) => {
    if (!tripId || e.tripId === tripId || e.tripId === "*") res.write(`data: ${JSON.stringify(e)}\n\n`);
  };
  bus.on("event", on);
  const ping = setInterval(() => res.write(": ping\n\n"), 15000);
  req.on("close", () => (bus.off("event", on), clearInterval(ping)));
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  try {
    if (url.pathname === "/api/events") return sse(req, res, url);
    const audio = url.pathname.match(/^\/api\/voice\/audio\/([A-Z0-9-]+)$/);
    if (audio) {
      const a = audioCache.get(audio[1]);
      if (!a) return send(res, 404, { error: "audio expired" });
      res.writeHead(200, { "content-type": a.mime, "cache-control": "private, max-age=1800" });
      return res.end(a.data);
    }
    if (url.pathname.startsWith("/api/")) {
      for (const r of routes) {
        const m = req.method === r.method && url.pathname.match(r.pattern);
        if (!m) continue;
        const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
        const body = req.method === "POST" ? await readBody(req) : {};
        const out = (await r.handler(req, body, params, url)) as any;
        if (req.method === "GET" && out && typeof out === "object" && typeof out.redirect === "string" && (url.pathname.startsWith("/api/calendar/") || url.pathname.startsWith("/api/zerodha/"))) {
          res.writeHead(302, { location: out.redirect });
          return res.end();
        }
        return send(res, 200, out ?? { ok: true });
      }
      return send(res, 404, { error: { code: "INVALID_REQUEST", message: "not found" } });
    }
    // Static UI
    const rel = normalize(url.pathname === "/" ? "index.html" : url.pathname.slice(1));
    if (rel.startsWith("..")) return send(res, 400, { error: "bad path" });
    const file = await readFile(join(WEB_ROOT, rel)).catch(() => null);
    if (!file) return send(res, 404, { error: "not found" });
    res.writeHead(200, { "content-type": MIME[extname(rel)] ?? "application/octet-stream" });
    res.end(file);
  } catch (e) {
    const err = e instanceof BiruniError ? e : new BiruniError("EXTERNAL_FAILURE", e instanceof Error ? e.message : String(e));
    send(res, STATUS[err.code] ?? 500, { error: { code: err.code, message: err.message } });
  }
});

void b.mcpClients.connectAll();

server.listen(config.port, () => {
  console.log(`Biruni API on http://localhost:${config.port}  (providers: ${config.providerMode}, undo window: ${config.undoWindowMs / 1000}s, db: ${config.dbPath})`);
  if (b.rehydrated) console.log(`Rehydrated ${b.rehydrated} open undo window(s) from the database`);
});

const shutdown = () => server.close(() => (b.shutdown(), process.exit(0)));
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

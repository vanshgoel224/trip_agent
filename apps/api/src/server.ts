// Biruni API (spec §23). The MCP server stays behind this backend and is never
// exposed to the browser; credentials stay server-side.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { createBiruni } from "../../../services/runtime";
import { SCENARIOS, seedScenario, type ScenarioName } from "../../../services/integrations/scenarios";
import { bus, type BiruniEvent } from "../../../packages/events";
import { BiruniError, config } from "../../../packages/shared";
import type { Incident } from "../../../packages/domain";

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
    if (raw.length > 1_000_000) throw new BiruniError("INVALID_REQUEST", "body too large");
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
    if (!tripId || e.tripId === tripId) res.write(`data: ${JSON.stringify(e)}\n\n`);
  };
  bus.on("event", on);
  const ping = setInterval(() => res.write(": ping\n\n"), 15000);
  req.on("close", () => (bus.off("event", on), clearInterval(ping)));
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  try {
    if (url.pathname === "/api/events") return sse(req, res, url);
    if (url.pathname.startsWith("/api/")) {
      for (const r of routes) {
        const m = req.method === r.method && url.pathname.match(r.pattern);
        if (!m) continue;
        const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
        const body = req.method === "POST" ? await readBody(req) : {};
        return send(res, 200, (await r.handler(req, body, params, url)) ?? { ok: true });
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

server.listen(config.port, () => {
  console.log(`Biruni API on http://localhost:${config.port}  (providers: ${config.providerMode}, undo window: ${config.undoWindowMs / 1000}s, db: ${config.dbPath})`);
  if (b.rehydrated) console.log(`Rehydrated ${b.rehydrated} open undo window(s) from the database`);
});

const shutdown = () => server.close(() => (b.shutdown(), process.exit(0)));
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

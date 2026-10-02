// Biruni API server. Each feature's routes live in ./routes/*; this file only does
// sign-in, per-user isolation, static files, webhooks and error handling.
// The MCP rail server stays behind this backend and is never exposed to the browser.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { brotliCompressSync, gzipSync } from "node:zlib";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, timingSafeEqual } from "node:crypto";
import { WebSocketServer } from "ws";
import { bus, type BiruniEvent } from "../../../packages/events";
import { config } from "../../../packages/shared";
import type { TripState } from "../../../packages/domain";
import { audioCache } from "../../../services/agents/voice";
import { authorized, handleRemoteMcp, remoteMcpEnabled } from "../../../services/mcp/remote";
import { Telephony } from "../../../services/telephony";
import { classifyError, MIME, readBody, Router, send } from "./http";
import { spaces, type Space } from "./spaces";
import trips from "./routes/trips";
import chat from "./routes/chat";
import device from "./routes/device";
import travel from "./routes/travel";
import models from "./routes/models";
import connections, { oauthStates } from "./routes/connections";
import autopilot from "./routes/autopilot";
import deals from "./routes/deals";
import feedback from "./routes/feedback";
import social from "./routes/social";
import fallRoutes, { falls } from "./routes/falls";
import styleRoutes from "./routes/style";

const router = new Router();
for (const register of [trips, chat, device, travel, models, connections, autopilot, deals, feedback, social, fallRoutes, styleRoutes]) register(router.route);

const WEB_ROOT = fileURLToPath(new URL("../../web/", import.meta.url));
const isSecure = (req: IncomingMessage) => req.headers["x-forwarded-proto"] === "https" || (req.socket as { encrypted?: boolean }).encrypted === true || process.env.BIRUNI_SECURE === "1";
const tokenOk = (got: string, want: string) => want.length >= 24 && got.length === want.length && timingSafeEqual(Buffer.from(got), Buffer.from(want));
const locked = (res: ServerResponse, message = "Biruni is locked: open the app and sign in once after the server starts") => send(res, 503, { error: { code: "LOCKED", message } });

// Static files: read, hashed and compressed once, then served from memory (re-read if the file changes).
type Asset = { raw: Buffer; gz?: Buffer; br?: Buffer; etag: string; type: string; mtime: number };
const assets = new Map<string, Asset>();
async function staticAsset(rel: string): Promise<Asset | undefined> {
  const path = join(WEB_ROOT, rel);
  const st = await stat(path).catch(() => null);
  if (!st?.isFile()) return undefined;
  const hit = assets.get(rel);
  if (hit && hit.mtime === st.mtimeMs) return hit;
  const raw = await readFile(path);
  const type = MIME[extname(rel)] ?? "application/octet-stream";
  const text = /^(text\/|application\/(json|javascript|manifest\+json)|image\/svg)/.test(type) && raw.length >= 1024;
  const a: Asset = { raw, type, mtime: st.mtimeMs, etag: `"${createHash("sha1").update(raw).digest("base64url").slice(0, 16)}"`, ...(text ? { gz: gzipSync(raw, { level: 9 }), br: brotliCompressSync(raw) } : {}) };
  assets.set(rel, a);
  return a;
}

/** Runs a route handler as `space`'s user. */
async function dispatch(space: Space, req: IncomingMessage, res: ServerResponse, url: URL) {
  const m = router.match(req.method ?? "GET", url.pathname);
  if (!m) return send(res, 404, { error: { code: "INVALID_REQUEST", message: "not found" } });
  const body = req.method === "POST" ? await readBody(req) : {};
  const out = (await spaces.run(space, () => m.handler(req, body, m.params, url))) as any;
  if (req.method === "GET" && out && typeof out === "object" && typeof out.redirect === "string") {
    res.writeHead(302, { location: out.redirect });
    return res.end();
  }
  if (out && typeof out === "object" && "__binary" in out) {
    res.writeHead(200, { "content-type": String(out.mime), "cache-control": out.filename ? "no-store" : "private, max-age=600", "content-length": out.__binary.length, ...(out.filename ? { "content-disposition": `attachment; filename="${String(out.filename).replace(/[^\w.-]/g, "_")}"` } : {}) });
    return res.end(out.__binary);
  }
  if (out && typeof out === "object" && "__raw" in out) {
    res.writeHead(200, { "content-type": "text/plain" });
    return res.end(String(out.__raw));
  }
  return send(res, 200, out ?? { ok: true });
}

/** Live activity for the signed-in user only. */
function sse(space: Space, req: IncomingMessage, res: ServerResponse, url: URL) {
  const tripId = url.searchParams.get("tripId");
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
  res.write(": connected\n\n");
  const on = (e: BiruniEvent) => {
    if (res.writableEnded || res.destroyed) return;
    if (e.userId !== space.me.userId) return;
    if (!tripId || e.tripId === tripId || e.tripId === "*") res.write(`data: ${JSON.stringify(e)}\n\n`);
  };
  bus.on("event", on);
  const ping = setInterval(() => !res.writableEnded && !res.destroyed && res.write(": ping\n\n"), 15000);
  const stop = () => (bus.off("event", on), clearInterval(ping));
  req.on("close", stop);
  res.on("error", stop);
}

async function auth(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  const p = url.pathname;
  if (p === "/api/lock/status") {
    // The Android launcher (another origin) checks the server is up; only this status is readable cross-origin.
    res.setHeader("access-control-allow-origin", "*");
    send(res, 200, spaces.status(req, url));
    return true;
  }
  if (req.method !== "POST") return false;
  if (p === "/api/lock/setup" || p === "/api/lock/unlock") {
    const { username, pin, displayName } = await readBody(req, 10_000);
    let space: Space;
    try {
      space = p === "/api/lock/setup" ? await spaces.signUp(String(username ?? "owner"), String(pin ?? ""), displayName) : await spaces.signIn(String(username ?? ""), String(pin ?? ""));
    } catch (e) {
      const [code, err] = classifyError(e);
      send(res, code, { error: { code: err.code, message: code === 500 ? "Internal error" : err.message } });
      return true;
    }
    spaces.startSession(res, space, isSecure(req));
    send(res, 200, { ok: true, username: space.me.username });
    return true;
  }
  if (p === "/api/lock/lock") {
    const { forget } = await readBody(req, 10_000).catch(() => ({}) as Record<string, unknown>);
    spaces.lock(req, res, !!forget);
    send(res, 200, { ok: true });
    return true;
  }
  return false;
}

const server = createServer(async (req, res) => {
  let url: URL;
  try {
    // A path like "//x" or a bad Host header must be a 400, never a hung request.
    url = new URL(String(req.url ?? "/").replace(/^\/{2,}/, "/"), "http://localhost");
  } catch {
    return send(res, 400, { error: { code: "INVALID_REQUEST", message: "bad URL" } });
  }
  if (isSecure(req)) res.setHeader("strict-transport-security", "max-age=31536000");
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("referrer-policy", "same-origin");
  try {
    if (await auth(req, res, url)) return;
    const p = url.pathname;

    // ---- hooks without a browser session: they act for the service user ----
    if (p === "/api/feed/inbound" && req.method === "POST") {
      if (!tokenOk(String(req.headers["x-biruni-feed-token"] ?? ""), process.env.FEED_TOKEN ?? "")) return send(res, 401, { error: { code: "AUTH_FAILURE", message: "feed token required (set FEED_TOKEN, 24+ chars)" } });
      const space = spaces.serviceSpace();
      if (!space) return locked(res);
      const body = await readBody(req);
      const out = await spaces.run(space, async () => {
        const b = space.b;
        const active = b.store.list<TripState>("trips").filter((t) => ["BOOKED", "TRAVELLING", "AWAITING_TRAVELLER"].includes(t.status)).at(-1);
        const tripId = String(body.tripId ?? active?.tripId ?? "");
        const r = b.feed.ingestMessage(tripId, String(body.text ?? body.message ?? ""));
        return { ...r, decisions: r.recognised && "event" in r ? await b.autopilot.tick(tripId) : [] };
      });
      return send(res, 200, out);
    }
    const smsHook = p.match(/^\/telephony\/exotel\/sms\/([^/]+)$/);
    if (smsHook) {
      if (!tokenOk(smsHook[1], process.env.TELEPHONY_WS_SECRET ?? "")) return send(res, 404, { error: "not found" });
      const space = spaces.serviceSpace();
      if (!space) return locked(res);
      let q: Record<string, string> = Object.fromEntries(url.searchParams);
      if (req.method === "POST") {
        let raw = "";
        for await (const c of req) if ((raw += c).length > 100_000) break;
        try {
          q = { ...q, ...(raw.trim().startsWith("{") ? JSON.parse(raw) : Object.fromEntries(new URLSearchParams(raw))) };
        } catch {
          /* keep query params */
        }
      }
      const from = q.From ?? q.from ?? "", text = q.Body ?? q.body ?? q.Content ?? q.text ?? "";
      const r = from && text ? await spaces.run(space, () => space.b.negotiator.inboundSms(from, text)) : undefined;
      return send(res, 200, { ok: true, matchedDeal: !!r });
    }
    if (p === "/mcp") {
      if (!remoteMcpEnabled()) return send(res, 404, { error: { code: "INVALID_REQUEST", message: "Remote MCP is off: set BIRUNI_MCP_TOKEN (24+ chars)" } });
      if (!authorized(req)) return send(res, 401, { error: { code: "AUTH_FAILURE", message: "Bearer token required" } });
      const space = spaces.serviceSpace();
      if (!space) return locked(res);
      if (req.method !== "POST") return send(res, 405, { error: { code: "INVALID_REQUEST", message: "POST only (stateless Streamable HTTP)" } });
      const body = await readBody(req);
      return await spaces.run(space, () => handleRemoteMcp(space.b, req, res, body));
    }
    if (p === "/api/whatsapp/webhook" || p === "/api/zerodha/callback") {
      const space = spaces.serviceSpace();
      if (!space) return locked(res);
      return await dispatch(space, req, res, url);
    }
    if (p === "/api/calendar/callback") {
      // Google's redirect carries no session cookie (SameSite=Strict); the OAuth state names the user.
      const space = spaces.loadedSpace(oauthStates.get(url.searchParams.get("state") ?? "") ?? "");
      if (!space) return send(res, 401, { error: { code: "AUTH_FAILURE", message: "invalid or expired OAuth state" } });
      return await dispatch(space, req, res, url);
    }

    // ---- everything else under /api needs a signed-in user ----
    if (p.startsWith("/api/")) {
      const space = spaces.spaceFor(req);
      if (!space) return send(res, 401, { error: { code: "LOCKED", message: spaces.accounts.count || spaces.legacyPending ? "Locked: sign in" : "Create your account first" } });
      if (p === "/api/lock/change" && req.method === "POST") {
        const { oldPin, newPin } = await readBody(req, 10_000);
        await spaces.changePin(space, String(oldPin ?? ""), String(newPin ?? ""));
        return send(res, 200, { ok: true, note: "PIN changed. Your data key was re-wrapped; nothing had to be re-encrypted." });
      }
      if (p === "/api/me/delete" && req.method === "POST") {
        const { pin, confirm } = await readBody(req, 10_000);
        if (confirm !== "DELETE") return send(res, 400, { error: { code: "INVALID_REQUEST", message: 'Type DELETE to confirm' } });
        const r = await spaces.deleteAccount(space, String(pin ?? ""));
        res.setHeader("set-cookie", "biruni_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0");
        return send(res, 200, r);
      }
      if (p === "/api/events") return sse(space, req, res, url);
      if (p === "/api/feedback.csv") {
        res.writeHead(200, { "content-type": "text/csv; charset=utf-8", "content-disposition": 'attachment; filename="biruni-feedback.csv"' });
        return res.end(spaces.run(space, () => space.b.feedback.csv()));
      }
      const audio = p.match(/^\/api\/voice\/audio\/([A-Z0-9-]+)$/);
      if (audio) {
        const a = audioCache.get(audio[1]);
        if (!a) return send(res, 404, { error: "audio expired" });
        res.writeHead(200, { "content-type": a.mime, "cache-control": "private, max-age=1800" });
        return res.end(a.data);
      }
      return await dispatch(space, req, res, url);
    }

    // ---- static UI ----
    let rel: string;
    try {
      rel = normalize(decodeURIComponent(p === "/" ? "index.html" : p.slice(1)));
    } catch {
      return send(res, 400, { error: "bad path" });
    }
    if (rel.startsWith("..") || rel.includes("\0")) return send(res, 400, { error: "bad path" });
    const asset = await staticAsset(rel);
    if (!asset) return send(res, 404, { error: "not found" });
    const enc = /\bbr\b/.test(String(req.headers["accept-encoding"] ?? "")) && asset.br ? "br" : /\bgzip\b/.test(String(req.headers["accept-encoding"] ?? "")) && asset.gz ? "gzip" : undefined;
    // Versioned libraries and icons: cache a week. App code: always revalidate (ETag), so updates show at once.
    const headers: Record<string, string> = { "content-type": asset.type, etag: asset.etag, vary: "accept-encoding", "cache-control": /^(vendor|icons)\//.test(rel) ? "public, max-age=604800" : "no-cache" };
    if (req.headers["if-none-match"] === asset.etag) {
      res.writeHead(304, headers);
      return res.end();
    }
    if (enc) headers["content-encoding"] = enc;
    res.writeHead(200, headers);
    res.end(enc === "br" ? asset.br : enc === "gzip" ? asset.gz : asset.raw);
  } catch (e) {
    const [code, err] = classifyError(e);
    if (code === 500) console.error(`[500] ${req.method} ${url.pathname}:`, e instanceof Error ? e.stack : e);
    send(res, code, { error: { code: err.code, message: code === 500 ? "Internal error (logged on the server)" : err.message } });
  }
});

// Exotel media stream (WebSocket). Only the secret path upgrades; anything else is dropped.
const wss = new WebSocketServer({ noServer: true, maxPayload: 1_000_000 });
server.on("upgrade", (req, socket, head) => {
  socket.on("error", () => {});
  const space = spaces.serviceSpace();
  if (!space || !Telephony.streamAuthorized(req)) return void socket.destroy();
  wss.handleUpgrade(req, socket, head, (ws) => spaces.run(space, () => space.b.telephony.handleStream(ws)));
});

// Last line of defence: log and keep serving. One bad request or a flaky upstream
// (model, map, MCP server) must never take the whole app down.
process.on("unhandledRejection", (e) => console.error("[unhandledRejection]", e instanceof Error ? e.stack : e));
process.on("uncaughtException", (e) => console.error("[uncaughtException]", e.stack ?? e));
server.on("clientError", (_e, socket) => socket.writable && socket.end("HTTP/1.1 400 Bad Request\r\n\r\n"));
server.requestTimeout = 120_000;
// Keep idle connections longer than clients/proxies do, so a reused socket isn't closed
// under a request in flight ("fetch failed" / ECONNRESET under load).
server.keepAliveTimeout = 65_000;
server.headersTimeout = 66_000;

await spaces.firstRunFromEnv();
server.listen(config.port, () => {
  const n = spaces.accounts.count;
  console.log(`Biruni on http://localhost:${config.port}  (providers: ${config.providerMode}) — ${spaces.legacyPending ? "existing data found: sign in with your current PIN to keep it" : n ? `${n} account(s); sign in to unlock` : "first run: open the app to create an account"}`);
});

const shutdown = () => server.close(() => (falls.stopAll(), spaces.shutdown(), process.exit(0)));
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

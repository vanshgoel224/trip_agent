// Small HTTP kit shared by the server and every route module.
import type { IncomingMessage, ServerResponse } from "node:http";
import { BiruniError } from "../../../packages/shared";

export type Handler = (req: IncomingMessage, body: any, params: Record<string, string>, url: URL) => Promise<unknown> | unknown;
export type RouteFn = (method: "GET" | "POST", path: string, handler: Handler) => void;
type Route = { method: string; pattern: RegExp; keys: string[]; handler: Handler };

export class Router {
  private routes: Route[] = [];
  route: RouteFn = (method, path, handler) => {
    const keys: string[] = [];
    const pattern = new RegExp("^" + path.replace(/:(\w+)/g, (_, k) => (keys.push(k), "([^/]+)")) + "$");
    this.routes.push({ method, pattern, keys, handler });
  };
  match(method: string, pathname: string) {
    for (const r of this.routes) {
      const m = r.method === method && pathname.match(r.pattern);
      if (!m) continue;
      let params: Record<string, string>;
      try {
        params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
      } catch {
        throw new BiruniError("INVALID_REQUEST", "bad URL encoding");
      }
      return { handler: r.handler, params };
    }
    return undefined;
  }
  get paths() {
    return this.routes.map((r) => ({ method: r.method, pattern: r.pattern.source }));
  }
}

export const STATUS: Record<string, number> = { INVALID_REQUEST: 400, AUTH_FAILURE: 401, POLICY_BLOCKED: 403, AUTHORITY_EXCEEDED: 403, OBLIGATION_BLOCKED: 403, USER_REQUIRED: 409, ALREADY_COMPLETED: 409, RATE_LIMIT: 429, TIMEOUT: 504 };
export const MIME: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".webmanifest": "application/manifest+json", ".json": "application/json", ".txt": "text/plain; charset=utf-8", ".ico": "image/x-icon", ".md": "text/markdown; charset=utf-8" };

export function send(res: ServerResponse, code: number, data: unknown) {
  if (res.headersSent || res.writableEnded) return void (res.writableEnded || res.end());
  res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(data));
}

export async function readBody(req: IncomingMessage, limit = 15_000_000): Promise<Record<string, any>> {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > limit) throw new BiruniError("INVALID_REQUEST", "body too large");
  }
  (req as any).rawBody = raw;
  if (!raw) return {};
  let j: unknown;
  try {
    j = JSON.parse(raw);
  } catch {
    throw new BiruniError("INVALID_REQUEST", "invalid JSON");
  }
  // Handlers read fields off an object; anything else (null, arrays, numbers) is rejected here.
  if (!j || typeof j !== "object" || Array.isArray(j)) throw new BiruniError("INVALID_REQUEST", "body must be a JSON object");
  delete (j as any).__proto__;
  return j as Record<string, any>;
}

/** Upstream trouble → 502/504; our own bugs → 500 (logged); everything else → 4xx. */
export function classifyError(e: unknown): [number, BiruniError] {
  if (e instanceof BiruniError) return [STATUS[e.code] ?? (e.code === "EXTERNAL_FAILURE" ? 502 : 500), e];
  const name = (e as Error)?.name ?? "";
  const msg = e instanceof Error ? e.message : String(e);
  if (name === "TimeoutError" || name === "AbortError") return [504, new BiruniError("TIMEOUT", "Upstream service timed out")];
  if (msg === "fetch failed" || /HTTP \d{3}|ECONN|ENOTFOUND|EAI_AGAIN|socket/i.test(msg)) return [502, new BiruniError("EXTERNAL_FAILURE", msg)];
  if (e instanceof TypeError || e instanceof ReferenceError || e instanceof RangeError || e instanceof SyntaxError) return [500, new BiruniError("EXTERNAL_FAILURE", msg)];
  return [400, new BiruniError("INVALID_REQUEST", msg)];
}

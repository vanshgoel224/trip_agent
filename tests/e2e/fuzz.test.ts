// Robustness: start the real server, hit every route with malformed and hostile input,
// and require that the process stays up and every reply is well-formed HTTP.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "node:net";

const dir = mkdtempSync(join(tmpdir(), "biruni-fuzz-"));
const PORT = 18000 + Math.floor(Math.random() * 2000);
const URL0 = `http://127.0.0.1:${PORT}`;
const TOKEN = "t".repeat(32);
let proc: ChildProcess;
const COOKIE = { value: "" };
let stderr = "";
after(() => {
  proc?.kill("SIGKILL");
  rmSync(dir, { recursive: true, force: true });
});

async function start() {
  proc = spawn(process.execPath, ["--no-warnings=ExperimentalWarning", "--import", "tsx", "apps/api/src/server.ts"], {
    env: { ...process.env, PORT: String(PORT), BIRUNI_DB_PATH: join(dir, "f.db"), BIRUNI_DATA_DIR: join(dir, "data"), ARGON2_MEMORY_KIB: "1024", ARGON2_ITERATIONS: "1", VAULT_SCRYPT_N: "1024", PROVIDER_MODE: "mock", OFFLINE_MODEL_CONFIG: "off", ONLINE_MODEL_API_KEY: "", GEMINI_API_KEY: "", AUTOPILOT_TICK_MS: "200", BIRUNI_INITIAL_PIN: "", BIRUNI_MCP_TOKEN: TOKEN },
    stdio: ["ignore", "pipe", "pipe"],
  });
  proc.stderr!.on("data", (d) => (stderr += d));
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${URL0}/api/lock/status`)).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("server didn't start: " + stderr);
}

const alive = async () => (await fetch(`${URL0}/api/lock/status`)).ok && proc.exitCode === null;

test("server survives malformed input on every route, locked and unlocked", { timeout: 900_000 }, async () => {
  await start();
  // Locked: everything is refused cleanly.
  assert.equal((await fetch(`${URL0}/api/chats`)).status, 401);
  // Bad PINs, bad JSON, huge PIN.
  for (const body of ["{", "null", '{"pin":12}', JSON.stringify({ pin: "x".repeat(10_000) }), '{"pin":"12"}', "[]"]) {
    const r = await fetch(`${URL0}/api/lock/setup`, { method: "POST", body, headers: { "content-type": "application/json" } });
    assert.ok(r.status >= 400 && r.status < 500, `setup ${body.slice(0, 20)} → ${r.status}`);
  }
  // Concurrent setup/unlock must not boot twice or crash.
  const setups = await Promise.all([1, 2, 3].map(() => fetch(`${URL0}/api/lock/setup`, { method: "POST", body: JSON.stringify({ pin: "1234" }) })));
  assert.equal(setups.filter((r) => r.ok).length, 1, "exactly one setup wins");
  const un = await Promise.all([1, 2, 3].map(() => fetch(`${URL0}/api/lock/unlock`, { method: "POST", body: JSON.stringify({ pin: "1234" }) })));
  assert.ok(un.every((r) => r.ok));
  const cookie = un[0].headers.get("set-cookie")!.split(";")[0];
  COOKIE.value = cookie;
  const H = { cookie, "content-type": "application/json" };
  assert.equal((await fetch(`${URL0}/api/lock/unlock`, { method: "POST", body: '{"pin":"0000"}' })).status, 401);

  // Every route from the source, every method, hostile bodies and params.
  const src = readFileSync("apps/api/src/server.ts", "utf8");
  const routes = [...src.matchAll(/route\("(GET|POST)", "([^"]+)"/g)].map((m) => ({ method: m[1], path: m[2] }));
  assert.ok(routes.length > 40, `found ${routes.length} routes`);
  const params = ["..%2F..%2Fetc%2Fpasswd", "' OR 1=1 --", "😀".repeat(50)];
  const bodies = ["", "{", "null", "[]", "123", '"str"', '{"__proto__":{"polluted":1}}', JSON.stringify({ text: "x".repeat(50_000), tripId: {}, chatId: [], amount: "NaN", providers: "nope" }), JSON.stringify({ providers: [{ provider: "custom", baseUrl: "javascript:alert(1)" }] })];
  const skip = /\/api\/(calendar|zerodha)\/(connect|login|callback)/; // redirect to external OAuth
  let requests = 0;
  const failures: string[] = [];
  const slow: string[] = [];
  for (const r of routes) {
    if (skip.test(r.path)) continue;
    for (const p of params) {
      const path = r.path.replace(/:[a-zA-Z]+/g, p);
      for (const body of r.method === "POST" ? bodies : [""]) {
        const t0 = Date.now();
        const res = await fetch(`${URL0}${path}?tripId=${encodeURIComponent(p)}&q=${encodeURIComponent(p)}`, { method: r.method, headers: H, body: r.method === "POST" ? body : undefined, signal: AbortSignal.timeout(20_000) }).catch((e) => e);
        requests++;
        if (Date.now() - t0 > 4000) {
          slow.push(`${r.method} ${r.path} ${Date.now() - t0}ms`);
          appendFileSync(join(tmpdir(), "biruni-fuzz-slow.log"), `${r.method} ${r.path} ${Date.now() - t0}ms\n`);
        }
        if (res instanceof Error) {
          failures.push(`${r.method} ${path} threw ${res.message}`);
          continue;
        }
        if (res.status >= 500 && ![502, 503, 504].includes(res.status)) failures.push(`${r.method} ${r.path} [${p}] body=${body.slice(0, 30)} → ${res.status}`);
        await res.arrayBuffer().catch(() => {});
      }
      if (!r.path.includes(":")) break;
    }
  }
  if (slow.length) console.log("slow routes:\n" + [...new Set(slow)].join("\n"));
  const traces = [...new Set(stderr.match(/\[500\][^\n]*\n[^\n]*/g) ?? [])].slice(0, 40);
  assert.deepEqual(failures, [], `${failures.length} failures:\n${[...new Set(failures.map((f) => f.replace(/ body=.*/, "")))].slice(0, 60).join("\n")}\n\nserver traces:\n${traces.join("\n")}`);
  assert.ok(({} as any).polluted === undefined);
  assert.ok(await alive(), "still alive after " + requests + " hostile requests");

  // Path traversal on static files.
  for (const p of ["/../package.json", "/..%2F..%2F.env", "/%2e%2e/%2e%2e/.env", "/vendor/../../../.env"]) {
    const r = await fetch(`${URL0}${p}`);
    const t = await r.text();
    assert.ok(!t.includes("GEMINI_API_KEY") && !t.includes('"dependencies"'), `traversal ${p} leaked`);
  }
  // Static assets the app needs offline are served locally.
  for (const p of ["/", "/vendor/maplibre-gl.js", "/vendor/maplibre-gl.css", "/manifest.webmanifest", "/sw.js", "/icons/icon-192.png", "/icons/maskable-512.png"]) {
    const r = await fetch(`${URL0}${p}`);
    assert.equal(r.status, 200, p);
  }

  // Raw socket garbage, aborted uploads, abrupt disconnects on SSE.
  await new Promise<void>((res) => {
    const s = connect(PORT, "127.0.0.1", () => s.end("GARBAGE \x00\x01 HTTP/9\r\n\r\n"));
    s.on("close", () => res()).on("error", () => res());
  });
  const ctrl = new AbortController();
  const sse = fetch(`${URL0}/api/events`, { headers: H, signal: ctrl.signal }).catch(() => {});
  await new Promise((r) => setTimeout(r, 300));
  ctrl.abort();
  await sse;
  await new Promise<void>((res) => {
    const s = connect(PORT, "127.0.0.1", () => {
      s.write(`POST /api/chats HTTP/1.1\r\nHost: x\r\nCookie: ${cookie}\r\nContent-Length: 100000\r\n\r\n{"mode":`);
      setTimeout(() => s.destroy(), 100);
    });
    s.on("close", () => res()).on("error", () => res());
  });
  // Many parallel chats while the autopilot ticks.
  const sc = await (await fetch(`${URL0}/api/scenarios/A`, { method: "POST", headers: H })).json().catch(() => ({}));
  const tripId = (sc as any).tripId;
  const chat = await (await fetch(`${URL0}/api/chats`, { method: "POST", headers: H, body: JSON.stringify({ mode: "general", tripId }) })).json();
  const sends = await Promise.all(Array.from({ length: 25 }, (_, i) => fetch(`${URL0}/api/chats/${(chat as any).chatId}/messages`, { method: "POST", headers: H, body: JSON.stringify({ text: ["status", "undo", "yes", "/btw hi", "/recall x", "/forget", "bus cancelled", "हाँ", "😀", ""][i % 10] }) })));
  assert.ok(sends.every((r) => r.status < 500), sends.map((r) => r.status).join(","));
  await new Promise((r) => setTimeout(r, 600)); // let autopilot tick a few times
  assert.ok(await alive(), "alive after concurrency + autopilot");
  assert.doesNotMatch(stderr, /uncaughtException|unhandledRejection/, stderr.slice(0, 2000));
});

test("remote MCP at /mcp: token required, tools listed, biruni_chat answers", { timeout: 60_000 }, async () => {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
  assert.equal((await fetch(`${URL0}/mcp`, { method: "POST", body: "{}" })).status, 401);
  assert.equal((await fetch(`${URL0}/mcp`, { method: "POST", body: "{}", headers: { authorization: "Bearer wrong" } })).status, 401);
  const c = new Client({ name: "test", version: "1" });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${URL0}/mcp`), { requestInit: { headers: { authorization: `Bearer ${TOKEN}` } } }));
  const tools = (await c.listTools()).tools.map((t) => t.name).sort();
  assert.deepEqual(tools, ["biruni_chat", "biruni_trip_status", "biruni_trips"]);
  await fetch(`${URL0}/api/scenarios/A`, { method: "POST", headers: { cookie: COOKIE.value } });
  const trips = JSON.parse(((await c.callTool({ name: "biruni_trips", arguments: {} })).content as any)[0].text);
  assert.ok(Array.isArray(trips) && trips.length >= 1);
  const r = JSON.parse(((await c.callTool({ name: "biruni_chat", arguments: { text: "status", tripId: trips[0].tripId } })).content as any)[0].text);
  assert.ok(r.chatId && typeof r.reply === "string" && r.reply.length > 0);
  await c.close();
  assert.ok(await alive());
});

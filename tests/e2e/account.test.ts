// Real server: trip rename/archive/delete, data export, account deletion, integrations
// health, compression + caching headers.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "biruni-acct-"));
const PORT = 22000 + Math.floor(Math.random() * 2000);
const U = `http://127.0.0.1:${PORT}`;
let proc: ChildProcess;
after(() => (proc?.kill("SIGKILL"), rmSync(dir, { recursive: true, force: true })));
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("CRUD + export + delete account + health + compression", { timeout: 90_000 }, async () => {
  proc = spawn(process.execPath, ["--no-warnings=ExperimentalWarning", "--import", "tsx", "apps/api/src/server.ts"], {
    env: { ...process.env, PORT: String(PORT), BIRUNI_DATA_DIR: dir, BIRUNI_DB_PATH: join(dir, "legacy.db"), ARGON2_MEMORY_KIB: "1024", ARGON2_ITERATIONS: "1", PROVIDER_MODE: "mock", OFFLINE_MODEL_CONFIG: "off", GEMINI_API_KEY: "", ONLINE_MODEL_API_KEY: "", BIRUNI_INITIAL_PIN: "" },
    stdio: "ignore",
  });
  for (let i = 0; i < 100 && !(await fetch(`${U}/api/lock/status`).then((r) => r.ok).catch(() => false)); i++) await wait(100);
  const r0 = await fetch(`${U}/api/lock/setup`, { method: "POST", body: JSON.stringify({ username: "ravi", pin: "246810" }) });
  const cookie = r0.headers.get("set-cookie")!.split(";")[0];
  const call = (path: string, body?: unknown, headers: Record<string, string> = {}) => fetch(`${U}${path}`, { method: body ? "POST" : "GET", headers: { cookie, ...headers }, body: body ? JSON.stringify(body) : undefined });
  const json = async (path: string, body?: unknown) => (await call(path, body)).json();

  // Trips: create, rename, archive (hidden), delete
  const { tripId } = await json("/api/scenarios/A", {});
  assert.equal((await json(`/api/trips/${tripId}/update`, { title: "Chennai work trip" })).title, "Chennai work trip");
  assert.equal((await json("/api/trips"))[0].title, "Chennai work trip");
  await json(`/api/trips/${tripId}/update`, { archived: true });
  assert.equal((await json("/api/trips")).length, 0, "archived trips are hidden");
  assert.equal((await json("/api/trips?all=1")).length, 1);
  const { tripId: t2 } = await json("/api/scenarios/A", {});
  await json("/api/chats", { mode: "general", tripId: t2 });
  const del = await json(`/api/trips/${t2}/delete`, {});
  assert.ok(del.deleted > 0, JSON.stringify(del));
  assert.equal((await call(`/api/trips/${t2}`)).status, 400, "deleted trip is gone");

  // Export: one JSON file, API keys removed
  await json("/api/models/providers", { providers: [{ provider: "gemini", apiKey: "AQ.secret-should-not-export" }] });
  const ex = await call("/api/me/export");
  assert.match(ex.headers.get("content-disposition") ?? "", /attachment; filename="biruni-ravi-/);
  const text = await ex.text();
  assert.ok(!text.includes("secret-should-not-export"), "API keys stay out of exports");
  const data = JSON.parse(text);
  assert.equal(data.account.username, "ravi");
  assert.ok(data.space.trips.length >= 1);

  // Health: every integration reported, nothing throws
  const h = await json("/api/integrations/health");
  assert.ok(h.checks.length >= 15 && /working/.test(h.summary), h.summary);
  assert.ok(h.checks.every((c: any) => ["ok", "down", "off", "simulated"].includes(c.state)));

  // Compression + caching
  const page = await fetch(`${U}/app.js`, { headers: { "accept-encoding": "br" } });
  assert.equal(page.headers.get("content-encoding"), "br");
  const etag = page.headers.get("etag")!;
  assert.equal((await fetch(`${U}/app.js`, { headers: { "if-none-match": etag } })).status, 304);
  assert.match((await fetch(`${U}/vendor/maplibre-gl.js`)).headers.get("cache-control") ?? "", /max-age=604800/);
  assert.equal((await fetch(`${U}//`)).status < 500, true, "double-slash path answers, doesn't hang");

  // Delete account: needs PIN + DELETE; data file removed; can't sign in again
  assert.equal((await call("/api/me/delete", { pin: "246810" })).status, 400);
  assert.equal((await call("/api/me/delete", { pin: "000000", confirm: "DELETE" })).status, 401);
  assert.equal((await call("/api/me/delete", { pin: "246810", confirm: "DELETE" })).status, 200);
  assert.equal(readdirSync(join(dir, "users")).filter((f) => f.endsWith(".db")).length, 0, "user data file removed");
  assert.equal((await fetch(`${U}/api/lock/unlock`, { method: "POST", body: JSON.stringify({ username: "ravi", pin: "246810" }) })).status, 401);
  assert.equal((await call("/api/me")).status, 401, "old session is dead");
  assert.ok(existsSync(join(dir, "accounts.db")));
});

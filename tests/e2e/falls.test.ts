// Real server, two users: Asha's phone drops, nobody cancels → Bala (an opted-in helper,
// not on her trip) gets a wide-range SOS with the fall details and location.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "biruni-falls-"));
const PORT = 20000 + Math.floor(Math.random() * 2000);
const U = `http://127.0.0.1:${PORT}`;
let proc: ChildProcess;
after(() => (proc?.kill("SIGKILL"), rmSync(dir, { recursive: true, force: true })));
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function signup(username: string) {
  const r = await fetch(`${U}/api/lock/setup`, { method: "POST", body: JSON.stringify({ username, pin: "123456" }) });
  assert.equal(r.status, 200);
  const cookie = r.headers.get("set-cookie")!.split(";")[0];
  return (path: string, body?: unknown) => fetch(`${U}${path}`, { method: body ? "POST" : "GET", headers: { cookie }, body: body ? JSON.stringify(body) : undefined }).then(async (x) => ({ status: x.status, json: await x.json() }));
}

test("drop → no cancel → wide SOS reaches an opted-in helper; cancel from a second device stops it", { timeout: 60_000 }, async () => {
  proc = spawn(process.execPath, ["--no-warnings=ExperimentalWarning", "--import", "tsx", "apps/api/src/server.ts"], {
    env: { ...process.env, PORT: String(PORT), BIRUNI_DATA_DIR: dir, BIRUNI_DB_PATH: join(dir, "legacy.db"), ARGON2_MEMORY_KIB: "1024", ARGON2_ITERATIONS: "1", FALL_CANCEL_MS: "1500", PROVIDER_MODE: "mock", OFFLINE_MODEL_CONFIG: "off", GEMINI_API_KEY: "", ONLINE_MODEL_API_KEY: "", BIRUNI_INITIAL_PIN: "" },
    stdio: "ignore",
  });
  for (let i = 0; i < 100; i++) {
    if (await fetch(`${U}/api/lock/status`).then((r) => r.ok).catch(() => false)) break;
    await wait(100);
  }
  const asha = await signup("asha");
  const bala = await signup("bala");
  const drop = { freefallMs: 520, heightM: 1.33, impactG: 5.6, tumbleDeg: 310, severity: "medium", orientationBefore: { beta: 80, gamma: 3 }, orientationAfter: { beta: -1, gamma: 178 }, location: { lat: 30.7352, lng: 79.0669, accuracy: 25 } };

  // 1) Cancelled from "another device" (a second session of the same account) → nothing sent.
  const ashaLaptop = async (path: string, body?: unknown) => {
    const r = await fetch(`${U}/api/lock/unlock`, { method: "POST", body: JSON.stringify({ username: "asha", pin: "123456" }) });
    const cookie = r.headers.get("set-cookie")!.split(";")[0];
    return fetch(`${U}${path}`, { method: body ? "POST" : "GET", headers: { cookie }, body: body ? JSON.stringify(body) : undefined }).then((x) => x.json());
  };
  const f1 = (await asha("/api/falls", drop)).json;
  assert.equal(f1.status, "PENDING");
  assert.equal((await ashaLaptop("/api/falls/active")).active.fallId, f1.fallId, "other device sees the countdown");
  assert.equal((await ashaLaptop(`/api/falls/${f1.fallId}/cancel`, { by: "other-device" })).status, "CANCELLED");
  await wait(2000);
  assert.equal((await bala("/api/sos")).json.inbox.length, 0, "cancelled → no SOS");

  // 2) Not cancelled → wide SOS.
  const f2 = (await asha("/api/falls", drop)).json;
  await wait(2500);
  const inbox = (await bala("/api/sos")).json.inbox;
  assert.equal(inbox.length, 1, "helper (not a contact, not on the trip) receives it: wide range");
  assert.equal(inbox[0].from, "asha");
  assert.match(inbox[0].message, /1\.3 m, 5\.6 g impact, tumbled 310°/);
  assert.equal(inbox[0].location.lat, 30.7352);
  const history = (await asha("/api/falls")).json;
  assert.deepEqual(history.slice(0, 2).map((f: any) => f.status).sort(), ["CANCELLED", "SOS_SENT"]);
  assert.ok(history.find((f: any) => f.fallId === f2.fallId).orientationAfter.gamma === 178, "moment recorded");
  // Junk is rejected, not a crash.
  assert.equal((await asha("/api/falls", { freefallMs: "x" })).status, 400);
});

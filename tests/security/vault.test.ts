import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.VAULT_SCRYPT_N = String(2 ** 12); // fast KDF for tests only
const { Vault, validatePin } = await import("../../packages/db/vault");
const { createBiruni } = await import("../../services/runtime");
const { seedScenario } = await import("../../services/integrations/scenarios");

const tmp = () => join(tmpdir(), `biruni-vault-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
const cleanup = (p: string) => ["", "-wal", "-shm"].forEach((s) => rmSync(p + s, { force: true }));
const fileText = (p: string) => ["", "-wal"].map((s) => { try { return readFileSync(p + s).toString("latin1"); } catch { return ""; } }).join("");

test("PIN rules", () => {
  assert.equal(validatePin("1519"), undefined);
  assert.match(validatePin("12")!, /4–12 digits/);
  assert.match(validatePin("abc")!, /6–64/);
  assert.equal(validatePin("goa-trip-2026"), undefined);
});

test("data is encrypted at rest; wrong PIN rejected (no lockout); right PIN reads everything back", async () => {
  const db = tmp();
  const v = new Vault(db);
  const cipher = await v.setup("1519");
  const b = createBiruni({ dbPath: db, cipher, undoWindowMs: 50 });
  const { tripId } = await seedScenario(b, "A");
  b.memory.remember({ subject: "Rahul", subject_type: "person", relation: "allergic to", object: "peanuts", object_type: "fact" }, "c");
  b.shutdown();
  const raw = fileText(db);
  for (const secret of ["peanuts", "Rahul", "Aarav", "Mumbai", "Meera"]) assert.ok(!raw.includes(secret), `"${secret}" must not appear in the DB file`);
  for (let i = 0; i < 7; i++) await assert.rejects(v.unlock("0000"), /Wrong PIN/); // no lockout after many tries
  const again = await v.unlock("1519");
  const b2 = createBiruni({ dbPath: db, cipher: again });
  assert.equal(b2.orchestrator.trip(tripId).itinerary.destination, "Chennai");
  assert.equal(b2.memory.search("peanuts")[0]?.label, "peanuts");
  b2.shutdown();
  v.close();
  cleanup(db);
});

test("existing plaintext data is migrated on first PIN; PIN change re-encrypts atomically", async () => {
  const db = tmp();
  const plain = createBiruni({ dbPath: db });
  plain.memory.remember({ subject: "Me", subject_type: "traveller", relation: "prefers", object: "window seat", object_type: "preference" }, "c");
  plain.shutdown();
  assert.ok(fileText(db).includes("window seat"), "plaintext before PIN");
  const v = new Vault(db);
  const c1 = await v.setup("1519");
  const b = createBiruni({ dbPath: db, cipher: c1 });
  const { from, to, vaultRow } = await v.prepareChange("1519", "246810");
  const n = b.store.reencrypt(from, to, vaultRow);
  assert.ok(n > 0);
  b.shutdown();
  await assert.rejects(v.unlock("1519"), /Wrong PIN/);
  const c2 = await v.unlock("246810");
  const b2 = createBiruni({ dbPath: db, cipher: c2 });
  assert.equal(b2.memory.search("window")[0]?.label, "window seat");
  b2.shutdown();
  v.close();
  cleanup(db);
});

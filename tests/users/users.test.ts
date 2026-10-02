process.env.ARGON2_MEMORY_KIB = "1024"; // fast KDF for tests (production default 64 MiB)
process.env.ARGON2_ITERATIONS = "1";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { Accounts } = await import("../../packages/db/accounts");
const { Social } = await import("../../services/social");
const { seal, unseal, safetyNumber } = await import("../../packages/crypto");
const { Store } = await import("../../packages/db");
const { makeCipher } = await import("../../packages/db/vault");
const { randomBytes } = await import("node:crypto");

const fresh = () => mkdtempSync(join(tmpdir(), "biruni-users-"));
const me = (u: Awaited<ReturnType<InstanceType<typeof Accounts>["unlock"]>>) => ({ userId: u.account.userId, username: u.account.username, identity: u.identity });

test("accounts: separate DEKs, wrong PIN refused, PIN change re-wraps only, usernames validated", async () => {
  const acc = new Accounts(fresh());
  const a = await acc.create("Vansh", "151900");
  const b = await acc.create("rahul", "246810");
  assert.equal(a.account.username, "vansh", "case-insensitive usernames");
  assert.notDeepEqual(a.dek, b.dek);
  await assert.rejects(acc.create("VANSH", "999999"), /taken/);
  await assert.rejects(acc.create("x", "123456"), /Username/);
  await assert.rejects(acc.create("priya", "12"), /PIN/);
  await assert.rejects(acc.unlock("vansh", "000000"), /Wrong username or PIN/);
  await assert.rejects(acc.unlock("nobody", "151900"), /Wrong username or PIN/);
  await acc.changePin("vansh", "151900", "777777");
  await assert.rejects(acc.unlock("vansh", "151900"), /Wrong/);
  const again = await acc.unlock("vansh", "777777");
  assert.deepEqual(again.dek, a.dek, "same DEK after PIN change: no data rewrite");
  assert.ok(!readFileSync(join((acc as any).dir, "accounts.db")).includes(a.dek), "raw DEK never stored");
});

test("store AAD: a ciphertext moved to another row fails to decrypt", () => {
  const s = new Store(":memory:", makeCipher(randomBytes(32)));
  s.put("chats", "A", { secret: "alpha" });
  s.put("chats", "B", { secret: "beta" });
  const db = (s as any).db;
  const a = db.prepare("SELECT data FROM chats WHERE id = 'A'").get().data;
  assert.match(a, /^enc2:/);
  db.prepare("UPDATE chats SET data = ? WHERE id = 'B'").run(a);
  assert.throws(() => s.get("chats", "B"), /auth|Unsupported state/i);
  assert.equal((s.get("chats", "A") as any).secret, "alpha");
});

test("sealed boxes + safety numbers", async () => {
  const acc = new Accounts(fresh());
  const a = await acc.create("asha", "123456"), b = await acc.create("bala", "123456");
  const box = seal(b.identity.publicKey, "meet at the cave mouth");
  assert.equal(unseal(b.identity, box).toString(), "meet at the cave mouth");
  assert.throws(() => unseal(a.identity, box));
  const n1 = safetyNumber({ publicKey: a.account.publicKey, username: "asha" }, { publicKey: b.account.publicKey, username: "bala" });
  const n2 = safetyNumber({ publicKey: b.account.publicKey, username: "bala" }, { publicKey: a.account.publicKey, username: "asha" });
  assert.equal(n1, n2, "same number on both phones");
  assert.match(n1, /^(\d{5} ){11}\d{5}$/);
});

test("shared trip: leader invites, members read, only the leader decides cancellations, removal rotates the key", async () => {
  const dir = fresh();
  const acc = new Accounts(dir);
  const L = me(await acc.create("leader", "111111")), M = me(await acc.create("member", "222222")), X = me(await acc.create("outsider", "333333"));
  const social = new Social(dir, acc);
  const s = social.createShare(L, "Spiti road trip", "TRIP-1");
  assert.throws(() => social.invite(s.shareId, M, "outsider"), /Only the trip leader/);
  social.invite(s.shareId, L, "member");
  social.post(s.shareId, M, "message", { text: "I'll carry the first-aid kit" });
  assert.ok(social.items(s.shareId, L).some((i) => i.content.text === "I'll carry the first-aid kit"));
  assert.throws(() => social.items(s.shareId, X), /not a member/);
  assert.ok(!readFileSync(join(dir, "shared.db")).includes("first-aid"), "server stores ciphertext only");
  const req = social.requestCancel(s.shareId, M, { bookingRef: "PNR123", reason: "landslide" });
  await assert.rejects(social.decideCancel(s.shareId, M, req.itemId, true, async () => "x"), /Only the trip leader/);
  let executed = "";
  await social.decideCancel(s.shareId, L, req.itemId, true, async (ref) => ((executed = ref), "cancelled"));
  assert.equal(executed, "PNR123");
  assert.equal(social.pendingCancels(s.shareId, L).length, 0);
  const keyBefore = social.shareFor(s.shareId, L).members.find((m) => m.userId === M.userId)!.wrappedKey;
  social.remove(s.shareId, L, M.userId);
  assert.throws(() => social.items(s.shareId, M), /not a member/);
  assert.ok(social.items(s.shareId, L).length >= 3, "items re-encrypted under the new key are still readable by the leader");
  const oldKey = unseal(M.identity, keyBefore);
  const anyItem = (social as any).db.prepare("SELECT id, data FROM share_items LIMIT 1").get();
  const { boxDecrypt } = await import("../../packages/crypto");
  assert.throws(() => boxDecrypt(oldKey, JSON.parse(anyItem.data), `item:${s.shareId}:${anyItem.id}`), "removed member's old key can't read");
  assert.throws(() => social.remove(s.shareId, L, L.userId), /leader can't leave/);
});

test("SOS: sealed per recipient, responses reach the sender, only sender resolves", async () => {
  const dir = fresh();
  const acc = new Accounts(dir);
  const A = me(await acc.create("trekker", "111111")), B = me(await acc.create("buddy", "222222")), C = me(await acc.create("stranger", "333333"));
  const social = new Social(dir, acc);
  const s = social.createShare(A, "Himalaya trek");
  social.invite(s.shareId, A, "buddy");
  const r = social.raiseSos(A, { message: "Stuck in a cave near Kedarkantha, ankle hurt", location: { lat: 31.02, lng: 78.18, accuracy: 30 } });
  assert.deepEqual(r.sentTo, ["buddy"], "trip members by default");
  assert.equal(social.activeCountFor(B.userId), 1);
  assert.equal(social.inbox(C).length, 0, "not sent to strangers unless 'everyone' is chosen");
  const inb = social.inbox(B)[0];
  assert.equal(inb.location?.lat, 31.02);
  assert.ok(!readFileSync(join(dir, "shared.db")).includes("Kedarkantha"), "message and location are sealed");
  social.respond(r.sosId, B, "called_authorities", "Called SDRF Uttarakhand, they're on the way");
  assert.throws(() => social.respond(r.sosId, C, "coming"), /wasn't sent to you/);
  const mine = social.mine(A)[0];
  assert.equal(mine.responses[0].kind, "called_authorities");
  assert.match(mine.responses[0].note!, /SDRF/);
  assert.equal(social.activeCountFor(B.userId), 0);
  assert.throws(() => social.resolve(r.sosId, B), /Only the person/);
  social.resolve(r.sosId, A);
  const wide = social.raiseSos(A, { message: "help" }, { everyone: true });
  assert.deepEqual(wide.sentTo.sort(), ["buddy", "stranger"]);
});

test("legacy single-PIN database is adopted without re-encryption", async () => {
  const dir = fresh();
  const legacy = join(dir, "old.db");
  const key = randomBytes(32);
  const st = new Store(legacy, makeCipher(key));
  st.put("chats", "C1", { title: "old chat" });
  st.close();
  const acc = new Accounts(dir);
  const u = await acc.create("owner", "151900", { existing: { dbPath: legacy, key } });
  assert.ok(!existsSync(legacy) && existsSync(u.account.dbFile));
  const back = new Store(u.account.dbFile, makeCipher(u.dek));
  assert.equal((back.get("chats", "C1") as any).title, "old chat");
  writeFileSync(join(dir, "x"), "");
});

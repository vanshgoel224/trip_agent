// Shared trips and the SOS help channel, across users of one Biruni server.
//
// Shared trip: a random trip key encrypts everything posted to it (messages,
// itinerary snapshots, cancellation requests). The key is sealed separately to each
// member's identity key, so the server stores only ciphertext and members can be
// added or removed by the leader. The leader alone decides cancellations.
//
// SOS: "I'm stuck, here's where I am". The message and location are sealed to each
// recipient (trip members, trusted contacts, and, if chosen, everyone on this server
// who opted in to help). Recipients answer "I'm coming", "I've called the
// authorities" or "Can't help"; the sender sees every answer. Biruni never replaces
// 112: the app always shows the emergency numbers too.
//
// Visible to the server: who is in which trip and who alerted whom, when. Not
// visible: what was said or where anyone is.
import { randomBytes, randomUUID } from "node:crypto";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Account, Accounts } from "../../packages/db/accounts";
import { boxDecrypt, boxEncrypt, safetyNumber, seal, unseal, type Box, type Identity, type Sealed } from "../../packages/crypto";
import { BiruniError } from "../../packages/shared";

export type Me = { userId: string; username: string; identity: Identity };
export type Member = { userId: string; username: string; role: "leader" | "member"; wrappedKey: Sealed; joinedAt: string };
export type Share = { shareId: string; title: string; leaderId: string; leaderTripId?: string; members: Member[]; createdAt: string };
export type ShareItemKind = "message" | "itinerary" | "cancel_request" | "cancel_decision" | "system";
export type ShareItem = { itemId: string; shareId: string; kind: ShareItemKind; by: string; byName: string; at: string; content: Record<string, unknown> };

export type SosPayload = { message: string; location?: { lat: number; lng: number; accuracy?: number; at?: string; label?: string }; tripTitle?: string; emergencyNote?: string };
export type SosAck = { userId: string; username: string; kind: "seen" | "coming" | "called_authorities" | "cant_help"; note?: Sealed; at: string };
type SosRow = { sosId: string; fromUserId: string; fromUsername: string; at: string; status: "ACTIVE" | "RESOLVED"; recipients: Record<string, Sealed>; selfCopy: Sealed; acks: SosAck[]; resolvedAt?: string };

const now = () => new Date().toISOString();

export class Social {
  private db: DatabaseSync;
  constructor(dir: string, private accounts: Accounts) {
    this.db = new DatabaseSync(join(dir, "shared.db"));
    this.db.exec(`PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS shares (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS share_items (id TEXT PRIMARY KEY, share_id TEXT NOT NULL, at TEXT NOT NULL, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS share_items_share ON share_items(share_id, at);
      CREATE TABLE IF NOT EXISTS sos (id TEXT PRIMARY KEY, at TEXT NOT NULL, data TEXT NOT NULL);`);
  }

  // ---------------- shared trips ----------------

  private getShare(shareId: string): Share {
    const r = this.db.prepare("SELECT data FROM shares WHERE id = ?").get(String(shareId)) as { data: string } | undefined;
    if (!r) throw new BiruniError("INVALID_REQUEST", "Unknown shared trip");
    return JSON.parse(r.data);
  }
  private putShare(s: Share) {
    this.db.prepare("INSERT INTO shares (id, data) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data").run(s.shareId, JSON.stringify(s));
  }
  private member(s: Share, userId: string) {
    const m = s.members.find((x) => x.userId === userId);
    if (!m) throw new BiruniError("POLICY_BLOCKED", "You're not a member of this trip");
    return m;
  }
  private tripKey(s: Share, me: Me) {
    return unseal(me.identity, this.member(s, me.userId).wrappedKey);
  }
  private requireLeader(s: Share, me: Me) {
    if (s.leaderId !== me.userId) throw new BiruniError("POLICY_BLOCKED", "Only the trip leader can do that");
  }
  private account(username: string): Account {
    const a = this.accounts.byUsername(username);
    if (!a) throw new BiruniError("INVALID_REQUEST", `No Biruni user called "${username}" on this server`);
    return a;
  }

  createShare(me: Me, title: string, leaderTripId?: string): Share {
    const key = randomBytes(32);
    const s: Share = {
      shareId: `SHR-${randomUUID().slice(0, 8).toUpperCase()}`, title: String(title ?? "").trim().slice(0, 80) || "Shared trip", leaderId: me.userId, leaderTripId,
      members: [{ userId: me.userId, username: me.username, role: "leader", wrappedKey: seal(me.identity.publicKey, key), joinedAt: now() }], createdAt: now(),
    };
    this.putShare(s);
    this.post(s.shareId, me, "system", { text: `${me.username} created the trip` });
    return s;
  }

  shares(userId: string) {
    return (this.db.prepare("SELECT data FROM shares").all() as { data: string }[]).map((r) => JSON.parse(r.data) as Share).filter((s) => s.members.some((m) => m.userId === userId));
  }

  /** Public view: no wrapped keys. */
  view(s: Share, me?: Me) {
    return {
      shareId: s.shareId, title: s.title, leaderId: s.leaderId, leaderTripId: s.leaderTripId, createdAt: s.createdAt, youAreLeader: me ? s.leaderId === me.userId : undefined,
      members: s.members.map((m) => {
        const acct = this.accounts.byId(m.userId);
        return { userId: m.userId, username: m.username, role: m.role, joinedAt: m.joinedAt, safetyNumber: me && acct && me.userId !== m.userId ? safetyNumber({ publicKey: me.identity.publicKey, username: me.username }, { publicKey: acct.publicKey, username: acct.username }) : undefined };
      }),
    };
  }
  shareFor(shareId: string, me: Me) {
    const s = this.getShare(shareId);
    this.member(s, me.userId);
    return s;
  }

  invite(shareId: string, me: Me, username: string) {
    const s = this.getShare(shareId);
    this.requireLeader(s, me);
    const a = this.account(username);
    if (s.members.some((m) => m.userId === a.userId)) return s;
    if (s.members.length >= 30) throw new BiruniError("INVALID_REQUEST", "A shared trip can have at most 30 people");
    const key = this.tripKey(s, me);
    s.members.push({ userId: a.userId, username: a.username, role: "member", wrappedKey: seal(a.publicKey, key), joinedAt: now() });
    this.putShare(s);
    this.post(shareId, me, "system", { text: `${me.username} added ${a.username}` });
    return s;
  }

  /**
   * Leader removes someone (or a member leaves). The trip key is rotated and
   * existing items re-encrypted, so a removed member's old key can't read new or old items.
   */
  remove(shareId: string, me: Me, userId: string) {
    const s = this.getShare(shareId);
    if (userId !== me.userId) this.requireLeader(s, me);
    if (userId === s.leaderId) throw new BiruniError("POLICY_BLOCKED", "The leader can't leave: hand over leadership first");
    if (!s.members.some((m) => m.userId === userId)) return s;
    const oldKey = this.tripKey(s, me);
    const newKey = randomBytes(32);
    const items = this.db.prepare("SELECT id, data FROM share_items WHERE share_id = ?").all(shareId) as { id: string; data: string }[];
    const upd = this.db.prepare("UPDATE share_items SET data = ? WHERE id = ?");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const it of items) upd.run(JSON.stringify(boxEncrypt(newKey, boxDecrypt(oldKey, JSON.parse(it.data) as Box, `item:${shareId}:${it.id}`), `item:${shareId}:${it.id}`)), it.id);
      const gone = s.members.find((m) => m.userId === userId)!;
      s.members = s.members.filter((m) => m.userId !== userId).map((m) => ({ ...m, wrappedKey: seal(this.accounts.byId(m.userId)!.publicKey, newKey) }));
      this.putShare(s);
      this.db.exec("COMMIT");
      this.post(shareId, me, "system", { text: userId === me.userId ? `${me.username} left` : `${me.username} removed ${gone.username}` });
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
    return s;
  }

  makeLeader(shareId: string, me: Me, userId: string) {
    const s = this.getShare(shareId);
    this.requireLeader(s, me);
    const m = this.member(s, userId);
    s.members = s.members.map((x) => ({ ...x, role: x.userId === m.userId ? "leader" : "member" }));
    s.leaderId = m.userId;
    s.leaderTripId = undefined; // the new leader links their own trip
    this.putShare(s);
    this.post(shareId, me, "system", { text: `${me.username} made ${m.username} the leader` });
    return s;
  }

  linkTrip(shareId: string, me: Me, tripId: string) {
    const s = this.getShare(shareId);
    this.requireLeader(s, me);
    s.leaderTripId = tripId;
    this.putShare(s);
    return s;
  }

  post(shareId: string, me: Me, kind: ShareItemKind, content: Record<string, unknown>): ShareItem {
    const s = this.getShare(shareId);
    const key = this.tripKey(s, me);
    if (kind === "message") {
      const text = String(content.text ?? "").trim();
      if (!text) throw new BiruniError("INVALID_REQUEST", "Empty message");
      content = { text: text.slice(0, 4000) };
    }
    const item: ShareItem = { itemId: `ITM-${randomUUID()}`, shareId, kind, by: me.userId, byName: me.username, at: now(), content };
    this.db.prepare("INSERT INTO share_items (id, share_id, at, data) VALUES (?, ?, ?, ?)").run(item.itemId, shareId, item.at, JSON.stringify(boxEncrypt(key, Buffer.from(JSON.stringify(item)), `item:${shareId}:${item.itemId}`)));
    return item;
  }

  items(shareId: string, me: Me, limit = 200): ShareItem[] {
    const s = this.getShare(shareId);
    const key = this.tripKey(s, me);
    const rows = this.db.prepare("SELECT id, data FROM share_items WHERE share_id = ? ORDER BY at DESC, rowid DESC LIMIT ?").all(shareId, Math.min(500, limit)) as { id: string; data: string }[];
    return rows.reverse().map((r) => JSON.parse(boxDecrypt(key, JSON.parse(r.data), `item:${shareId}:${r.id}`).toString("utf8")) as ShareItem);
  }

  /** Any member may ask; only the leader's decision counts. */
  requestCancel(shareId: string, me: Me, input: { bookingRef: string; reason?: string }) {
    if (!input?.bookingRef) throw new BiruniError("INVALID_REQUEST", "Which booking?");
    return this.post(shareId, me, "cancel_request", { bookingRef: String(input.bookingRef).slice(0, 40), reason: String(input.reason ?? "").slice(0, 300), status: "PENDING" });
  }
  pendingCancels(shareId: string, me: Me) {
    const its = this.items(shareId, me, 500);
    const decided = new Set(its.filter((i) => i.kind === "cancel_decision").map((i) => String(i.content.requestId)));
    return its.filter((i) => i.kind === "cancel_request" && !decided.has(i.itemId));
  }
  /** Leader decides; `execute` runs the cancellation in the leader's own space. */
  async decideCancel(shareId: string, me: Me, requestId: string, approve: boolean, execute: (bookingRef: string) => Promise<string>) {
    const s = this.getShare(shareId);
    this.requireLeader(s, me);
    const req = this.pendingCancels(shareId, me).find((i) => i.itemId === requestId);
    if (!req) throw new BiruniError("INVALID_REQUEST", "No such pending request");
    const result = approve ? await execute(String(req.content.bookingRef)) : "declined";
    return this.post(shareId, me, "cancel_decision", { requestId, approve, result, bookingRef: req.content.bookingRef });
  }

  // ---------------- SOS ----------------

  /** Who receives my SOS: trip members, my trusted contacts, and opted-in helpers if asked. */
  recipientsFor(me: Me, opts: { contacts?: string[]; everyone?: boolean }) {
    const ids = new Set<string>();
    for (const s of this.shares(me.userId)) for (const m of s.members) ids.add(m.userId);
    for (const u of opts.contacts ?? []) {
      const a = this.accounts.byUsername(u);
      if (a) ids.add(a.userId);
    }
    if (opts.everyone) for (const a of this.accounts.list()) if (a.help?.optIn !== false) ids.add(a.userId);
    ids.delete(me.userId);
    return [...ids].map((id) => this.accounts.byId(id)!).filter(Boolean);
  }

  raiseSos(me: Me, payload: SosPayload, opts: { contacts?: string[]; everyone?: boolean } = {}) {
    const message = String(payload?.message ?? "").trim().slice(0, 1000) || "I need help.";
    const loc = payload.location && Number.isFinite(Number(payload.location.lat)) && Number.isFinite(Number(payload.location.lng))
      ? { lat: Number(payload.location.lat), lng: Number(payload.location.lng), accuracy: payload.location.accuracy ? Number(payload.location.accuracy) : undefined, at: payload.location.at, label: payload.location.label ? String(payload.location.label).slice(0, 120) : undefined }
      : undefined;
    const body = JSON.stringify({ message, location: loc, tripTitle: payload.tripTitle, emergencyNote: payload.emergencyNote });
    const to = this.recipientsFor(me, opts);
    const row: SosRow = {
      sosId: `SOS-${randomUUID().slice(0, 8).toUpperCase()}`, fromUserId: me.userId, fromUsername: me.username, at: now(), status: "ACTIVE",
      recipients: Object.fromEntries(to.map((a) => [a.userId, seal(a.publicKey, body)])), selfCopy: seal(me.identity.publicKey, body), acks: [],
    };
    this.db.prepare("INSERT INTO sos (id, at, data) VALUES (?, ?, ?)").run(row.sosId, row.at, JSON.stringify(row));
    return { sosId: row.sosId, sentTo: to.map((a) => a.username), at: row.at };
  }

  private sosRow(id: string): SosRow {
    const r = this.db.prepare("SELECT data FROM sos WHERE id = ?").get(String(id)) as { data: string } | undefined;
    if (!r) throw new BiruniError("INVALID_REQUEST", "Unknown SOS");
    return JSON.parse(r.data);
  }
  private saveSos(row: SosRow) {
    this.db.prepare("UPDATE sos SET data = ? WHERE id = ?").run(JSON.stringify(row), row.sosId);
  }
  private allSos(): SosRow[] {
    return (this.db.prepare("SELECT data FROM sos ORDER BY at DESC LIMIT 500").all() as { data: string }[]).map((r) => JSON.parse(r.data));
  }

  /** Alerts waiting for a (possibly locked) user: counts only, nothing decrypted. */
  activeCountFor(userId: string) {
    return this.allSos().filter((r) => r.status === "ACTIVE" && userId in r.recipients && !r.acks.some((a) => a.userId === userId && a.kind !== "seen")).length;
  }

  inbox(me: Me) {
    return this.allSos()
      .filter((r) => me.userId in r.recipients)
      .map((r) => {
        const p = JSON.parse(unseal(me.identity, r.recipients[me.userId]).toString("utf8")) as SosPayload;
        return { sosId: r.sosId, from: r.fromUsername, at: r.at, status: r.status, resolvedAt: r.resolvedAt, ...p, responses: r.acks.map((a) => ({ username: a.username, kind: a.kind, at: a.at })), myResponse: r.acks.filter((a) => a.userId === me.userId).at(-1)?.kind };
      });
  }

  mine(me: Me) {
    return this.allSos()
      .filter((r) => r.fromUserId === me.userId)
      .map((r) => ({
        sosId: r.sosId, at: r.at, status: r.status, resolvedAt: r.resolvedAt, sentTo: Object.keys(r.recipients).map((id) => this.accounts.byId(id)?.username ?? "?"),
        ...(JSON.parse(unseal(me.identity, r.selfCopy).toString("utf8")) as SosPayload),
        responses: r.acks.map((a) => ({ username: a.username, kind: a.kind, at: a.at, note: a.note ? safeOpen(me.identity, a.note) : undefined })),
      }));
  }

  respond(sosId: string, me: Me, kind: SosAck["kind"], note?: string) {
    if (!["seen", "coming", "called_authorities", "cant_help"].includes(kind)) throw new BiruniError("INVALID_REQUEST", "Unknown response");
    const r = this.sosRow(sosId);
    if (!(me.userId in r.recipients)) throw new BiruniError("POLICY_BLOCKED", "This alert wasn't sent to you");
    const sender = this.accounts.byId(r.fromUserId)!;
    r.acks.push({ userId: me.userId, username: me.username, kind, note: note?.trim() ? seal(sender.publicKey, note.trim().slice(0, 1000)) : undefined, at: now() });
    this.saveSos(r);
    return { ok: true, sosId, kind };
  }

  resolve(sosId: string, me: Me) {
    const r = this.sosRow(sosId);
    if (r.fromUserId !== me.userId) throw new BiruniError("POLICY_BLOCKED", "Only the person who raised it can mark it safe");
    r.status = "RESOLVED";
    r.resolvedAt = now();
    this.saveSos(r);
    return { ok: true, sosId, status: r.status };
  }

  close() {
    this.db.close();
  }
}

const safeOpen = (me: Identity, s: Sealed) => {
  try {
    return unseal(me, s).toString("utf8");
  } catch {
    return undefined;
  }
};

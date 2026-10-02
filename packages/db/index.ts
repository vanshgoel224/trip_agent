import { DatabaseSync } from "node:sqlite";
import { BiruniError, nowIso } from "../shared";
import type { Cipher } from "./vault";

// Prototype persistence: node:sqlite (experimental in Node 22) with one
// document table per entity from spec §17. prisma/schema.prisma is the
// production schema with the same table names.

export const TABLES = [
  "users",
  "trips",
  "trip_states",
  "incidents",
  "itineraries",
  "obligations",
  "authority_ledgers",
  "transactions",
  "payments",
  "bookings",
  "routes",
  "tool_calls",
  "agent_runs",
  "audit_logs",
  "undo_actions",
  "consents",
  "offline_cache",
  // Added for the conversational layer (not in spec §17):
  "chats",
  "chat_messages",
  "expenses",
  "memory_nodes",
  "memory_links",
  "mcp_servers",
  "device_readings",
  "parcels",
  "feedback",
  "autopilot",
  "deals",
  "settings",
  "offers",
  "partner_bookings",
] as const;

export type Table = (typeof TABLES)[number];

/** Ids and index keys must be strings; numbers are converted, anything else is a bad request. */
function keyOf(v: unknown, optional = false): string | null {
  if (v === undefined || v === null) {
    if (optional) return null;
    throw new BiruniError("INVALID_REQUEST", "missing id");
  }
  if (typeof v === "string") return v;
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  throw new BiruniError("INVALID_REQUEST", "ids must be strings");
}

// Spec §17 critical invariant: only the finance service mutates these.
const FINANCE_ONLY: Table[] = ["obligations", "authority_ledgers", "transactions"];

export type FinanceCapability = { readonly __finance: unique symbol };

type Meta = { tripId?: string; incidentId?: string; key?: string };

export class Store {
  private db: DatabaseSync;
  private financeCap: FinanceCapability | null = null;
  // Prepared-statement cache: SQLite parses each distinct SQL once.
  private stmts = new Map<string, ReturnType<DatabaseSync["prepare"]>>();
  private stmt(sql: string) {
    let st = this.stmts.get(sql);
    if (!st) this.stmts.set(sql, (st = this.db.prepare(sql)));
    return st;
  }

  constructor(path = ":memory:", private cipher?: Cipher) {
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL;");
    for (const t of TABLES) {
      this.db.exec(`CREATE TABLE IF NOT EXISTS ${t} (
        id TEXT PRIMARY KEY,
        trip_id TEXT,
        incident_id TEXT,
        key TEXT,
        data TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS ${t}_trip ON ${t}(trip_id);
      CREATE INDEX IF NOT EXISTS ${t}_incident ON ${t}(incident_id);
      CREATE INDEX IF NOT EXISTS ${t}_key ON ${t}(key);`);
    }
  }

  // ---------- encryption at rest ----------
  private seal(json: string, table: string, id: string) {
    return this.cipher ? this.cipher.encrypt(json, `${table}:${id}`) : json;
  }
  private open(stored: string, table: string, id: string) {
    return this.cipher ? this.cipher.decrypt(stored, `${table}:${id}`) : stored;
  }
  get encrypted() {
    return !!this.cipher;
  }

  /** Encrypts any plaintext rows left from before a PIN was set. Returns rows migrated. */
  encryptAll(): number {
    if (!this.cipher) return 0;
    let n = 0;
    this.tx(() => {
      for (const t of TABLES) {
        // Plaintext rows and enc1 rows (no AAD) are upgraded to enc2 (bound to table:id).
        const rows = this.db.prepare(`SELECT id, data FROM ${t} WHERE data NOT LIKE 'enc2:%'`).all() as { id: string; data: string }[];
        const upd = this.db.prepare(`UPDATE ${t} SET data = ? WHERE id = ?`);
        for (const r of rows) (upd.run(this.cipher!.encrypt(this.cipher!.decrypt(r.data), `${t}:${r.id}`), r.id), n++);
      }
    });
    return n;
  }

  /** PIN change: re-encrypt every row and update the vault row atomically. */
  reencrypt(from: Cipher, to: Cipher, vaultRow: string): number {
    let n = 0;
    this.tx(() => {
      for (const t of TABLES) {
        const rows = this.db.prepare(`SELECT id, data FROM ${t}`).all() as { id: string; data: string }[];
        const upd = this.db.prepare(`UPDATE ${t} SET data = ? WHERE id = ?`);
        for (const r of rows) (upd.run(to.encrypt(from.decrypt(r.data, `${t}:${r.id}`), `${t}:${r.id}`), r.id), n++);
      }
      this.db.prepare("UPDATE vault SET data = ? WHERE id = 1").run(vaultRow);
    });
    this.cipher = to;
    return n;
  }

  /** Issued exactly once, to the finance agent. */
  issueFinanceCapability(): FinanceCapability {
    if (this.financeCap) throw new Error("finance capability already issued: finance agent is the single writer");
    this.financeCap = Object.freeze({}) as FinanceCapability;
    return this.financeCap;
  }

  put<T>(table: Table, id: string, doc: T, meta: Meta = {}, cap?: FinanceCapability) {
    id = keyOf(id)!;
    if (FINANCE_ONLY.includes(table) && (!cap || cap !== this.financeCap)) {
      throw new Error(`write to ${table} rejected: only the finance agent may mutate it`);
    }
    const now = nowIso();
    this
      .stmt(
        `INSERT INTO ${table} (id, trip_id, incident_id, key, data, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET trip_id=excluded.trip_id, incident_id=excluded.incident_id,
           key=excluded.key, data=excluded.data, updated_at=excluded.updated_at`,
      )
      .run(id, keyOf(meta.tripId, true), keyOf(meta.incidentId, true), keyOf(meta.key, true), this.seal(JSON.stringify(doc), table, id), now, now);
    return doc;
  }

  get<T>(table: Table, id: string): T | undefined {
    if (typeof id !== "string" && typeof id !== "number") return undefined; // ids from request bodies can be anything
    const row = this.stmt(`SELECT data FROM ${table} WHERE id = ?`).get(String(id)) as { data: string } | undefined;
    return row ? (JSON.parse(this.open(row.data, table, String(id))) as T) : undefined;
  }

  list<T>(table: Table, filter: Meta = {}): T[] {
    const where: string[] = [];
    const args: string[] = [];
    if (filter.tripId) (where.push("trip_id = ?"), args.push(keyOf(filter.tripId)!));
    if (filter.incidentId) (where.push("incident_id = ?"), args.push(keyOf(filter.incidentId)!));
    if (filter.key) (where.push("key = ?"), args.push(keyOf(filter.key)!));
    const sql = `SELECT id, data FROM ${table}${where.length ? " WHERE " + where.join(" AND ") : ""} ORDER BY created_at, rowid`;
    return (this.stmt(sql).all(...args) as { id: string; data: string }[]).map((r) => JSON.parse(this.open(r.data, table, r.id)) as T);
  }

  findByKey<T>(table: Table, key: string): T | undefined {
    return this.list<T>(table, { key })[0];
  }

  delete(table: Table, id: string) {
    if (FINANCE_ONLY.includes(table)) throw new Error(`delete on ${table} not allowed`);
    this.stmt(`DELETE FROM ${table} WHERE id = ?`).run(keyOf(id)!);
  }

  /** Synchronous atomic section. */
  tx<R>(fn: () => R): R {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const r = fn();
      this.db.exec("COMMIT");
      return r;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  close() {
    this.stmts.clear();
    this.db.close();
  }
}

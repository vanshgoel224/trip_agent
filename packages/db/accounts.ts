// Accounts: one encrypted space per user. This file holds only what's needed to
// unlock a space: username, KDF salt/params, the wrapped data key (DEK), the public
// identity key and the wrapped private key. Each user's data lives in its own
// database file, encrypted with their DEK. No lockout after wrong PINs (product
// decision); Argon2id (46 MiB, 1 pass, OWASP setting) makes each guess slow and memory-hard.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, existsSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { boxDecrypt, boxEncrypt, deriveKek, newIdentity, newKdf, privateFromDer, type Box, type Identity, type KdfParams } from "../crypto";
import { BiruniError } from "../shared";
import { validatePin } from "./vault";

export type Account = {
  userId: string; username: string; displayName: string; kdf: KdfParams; wrappedDek: Box;
  publicKey: string; wrappedPrivateKey: Box; dbFile: string; createdAt: string;
  help: { optIn: boolean; city?: string };
};
export type Unlocked = { account: Account; dek: Buffer; identity: Identity };

export const validUsername = (u: string) => /^[a-z0-9][a-z0-9_.-]{2,31}$/.test(u);
const norm = (u: unknown) => String(u ?? "").trim().toLowerCase();

export class Accounts {
  private db: DatabaseSync;
  constructor(private dir: string) {
    mkdirSync(join(dir, "users"), { recursive: true });
    this.db = new DatabaseSync(join(dir, "accounts.db"));
    this.db.exec("PRAGMA journal_mode = WAL; CREATE TABLE IF NOT EXISTS accounts (user_id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, data TEXT NOT NULL);");
  }

  list(): Account[] {
    return (this.db.prepare("SELECT data FROM accounts ORDER BY rowid").all() as { data: string }[]).map((r) => JSON.parse(r.data));
  }
  get count() {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM accounts").get() as { n: number }).n;
  }
  byUsername(u: string): Account | undefined {
    const r = this.db.prepare("SELECT data FROM accounts WHERE username = ?").get(norm(u)) as { data: string } | undefined;
    return r ? JSON.parse(r.data) : undefined;
  }
  byId(id: string): Account | undefined {
    const r = this.db.prepare("SELECT data FROM accounts WHERE user_id = ?").get(String(id)) as { data: string } | undefined;
    return r ? JSON.parse(r.data) : undefined;
  }
  /** Public directory entry (no secrets). */
  publicView(a: Account) {
    return { userId: a.userId, username: a.username, displayName: a.displayName, publicKey: a.publicKey };
  }
  private save(a: Account) {
    this.db.prepare("INSERT INTO accounts (user_id, username, data) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET data = excluded.data").run(a.userId, a.username, JSON.stringify(a));
  }

  /**
   * New account. `existing` adopts an old single-user database: its PIN-derived key
   * becomes this account's DEK (wrapped like any other), so nothing is re-encrypted.
   */
  async create(usernameIn: string, pin: string, opts: { displayName?: string; existing?: { dbPath: string; key: Buffer } } = {}): Promise<Unlocked> {
    const username = norm(usernameIn);
    if (!validUsername(username)) throw new BiruniError("INVALID_REQUEST", "Username: 3–32 characters, letters, numbers, . _ -");
    const bad = validatePin(pin);
    if (bad) throw new BiruniError("INVALID_REQUEST", bad);
    if (this.byUsername(username)) throw new BiruniError("INVALID_REQUEST", "That username is taken");
    const userId = randomUUID();
    const dek = opts.existing?.key ?? randomBytes(32);
    const kdf = newKdf();
    const kek = await deriveKek(pin, kdf);
    const id = newIdentity();
    const dbFile = join(this.dir, "users", `${createHash("sha256").update(userId).digest("hex").slice(0, 24)}.db`);
    if (opts.existing && existsSync(opts.existing.dbPath)) {
      mkdirSync(dirname(dbFile), { recursive: true });
      for (const ext of ["", "-wal", "-shm"]) if (existsSync(opts.existing.dbPath + ext)) renameSync(opts.existing.dbPath + ext, dbFile + ext);
    }
    const a: Account = {
      userId, username, displayName: String(opts.displayName ?? usernameIn).trim().slice(0, 40) || username, kdf,
      wrappedDek: boxEncrypt(kek, dek, `dek:${userId}`), publicKey: id.publicKey, wrappedPrivateKey: boxEncrypt(dek, id.privateDer, `idkey:${userId}`),
      dbFile, createdAt: new Date().toISOString(), help: { optIn: true },
    };
    try {
      this.db.prepare("INSERT INTO accounts (user_id, username, data) VALUES (?, ?, ?)").run(a.userId, a.username, JSON.stringify(a));
    } catch {
      throw new BiruniError("INVALID_REQUEST", "That username is taken"); // lost a race for the same name
    }
    return { account: a, dek, identity: { publicKey: a.publicKey, privateKey: privateFromDer(id.privateDer) } };
  }

  async unlock(usernameIn: string, pin: string): Promise<Unlocked> {
    const a = this.byUsername(usernameIn);
    // Same work whether or not the user exists, so timing doesn't reveal usernames.
    const kek = await deriveKek(String(pin ?? ""), a?.kdf ?? newKdf());
    if (!a) throw new BiruniError("AUTH_FAILURE", "Wrong username or PIN");
    let dek: Buffer;
    try {
      dek = boxDecrypt(kek, a.wrappedDek, `dek:${a.userId}`);
    } catch {
      throw new BiruniError("AUTH_FAILURE", "Wrong username or PIN");
    }
    const priv = privateFromDer(boxDecrypt(dek, a.wrappedPrivateKey, `idkey:${a.userId}`));
    return { account: a, dek, identity: { publicKey: a.publicKey, privateKey: priv } };
  }

  /** PIN change re-wraps the DEK only (envelope encryption): instant, no data rewrite. */
  async changePin(usernameIn: string, oldPin: string, newPin: string) {
    const u = await this.unlock(usernameIn, oldPin);
    const bad = validatePin(newPin);
    if (bad) throw new BiruniError("INVALID_REQUEST", bad);
    const kdf = newKdf();
    const kek = await deriveKek(newPin, kdf);
    this.save({ ...u.account, kdf, wrappedDek: boxEncrypt(kek, u.dek, `dek:${u.account.userId}`) });
  }

  update(userId: string, patch: Partial<Pick<Account, "displayName" | "help">>) {
    const a = this.byId(userId);
    if (!a) throw new BiruniError("INVALID_REQUEST", "Unknown user");
    const next = { ...a, ...patch, help: { ...a.help, ...(patch.help ?? {}) } };
    this.save(next);
    return next;
  }

  /** Removes the account row and its data file. Caller verifies the PIN and closes the store first. */
  delete(userId: string) {
    const a = this.byId(userId);
    if (!a) return false;
    this.db.prepare("DELETE FROM accounts WHERE user_id = ?").run(userId);
    for (const ext of ["", "-wal", "-shm"]) rmSync(a.dbFile + ext, { force: true });
    return true;
  }

  close() {
    this.db.close();
  }
}

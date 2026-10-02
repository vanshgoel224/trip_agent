// PIN vault: encryption at rest for every stored record.
//   key  = scrypt(PIN, salt)            — never stored; lives only in RAM after unlock
//   data = AES-256-GCM(key, record)     — "enc1:" + base64(iv | tag | ciphertext)
//   The vault row keeps only the salt, KDF parameters, an encrypted verifier and
//   nothing else. A wrong PIN fails GCM authentication.
// No lockout after wrong PINs (product decision). Honest limits: a 4-digit PIN has
// 10,000 combinations; scrypt makes each try ~0.3 s, so 4 digits fall in under an
// hour of guessing. Use 6+ digits or a password for real protection.
// .env secrets are not covered by this encryption.
import { createCipheriv, createDecipheriv, randomBytes, scrypt as scryptCb, type ScryptOptions } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

const scrypt = (pin: string, salt: Buffer, opts: ScryptOptions) =>
  new Promise<Buffer>((res, rej) => scryptCb(pin.normalize("NFKC"), salt, 32, opts, (e, k) => (e ? rej(e) : res(k))));

export const KDF = { N: Number(process.env.VAULT_SCRYPT_N ?? 2 ** 17), r: 8, p: 1 }; // ~0.3 s per guess
const PREFIX = "enc1:";
const VERIFIER = "biruni-vault-ok";

export type Cipher = { encrypt(plain: string, aad?: string): string; decrypt(stored: string, aad?: string): string };
const PREFIX2 = "enc2:"; // AES-GCM with AAD = "table:id": a row can't be swapped into another row

export function makeCipher(key: Buffer): Cipher {
  return {
    encrypt(plain, aad) {
      const iv = randomBytes(12);
      const c = createCipheriv("aes-256-gcm", key, iv);
      if (aad) c.setAAD(Buffer.from(aad));
      const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
      return (aad ? PREFIX2 : PREFIX) + Buffer.concat([iv, c.getAuthTag(), ct]).toString("base64");
    },
    decrypt(stored, aad) {
      const v2 = stored.startsWith(PREFIX2);
      if (!v2 && !stored.startsWith(PREFIX)) return stored; // legacy plaintext row (migrated on unlock)
      const buf = Buffer.from(stored.slice(PREFIX.length), "base64");
      const d = createDecipheriv("aes-256-gcm", key, buf.subarray(0, 12));
      if (v2) d.setAAD(Buffer.from(aad ?? ""));
      d.setAuthTag(buf.subarray(12, 28));
      return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString("utf8");
    },
  };
}
export const isEncrypted = (s: string) => s.startsWith(PREFIX) || s.startsWith(PREFIX2);

type VaultRow = { salt: string; N: number; r: number; p: number; verifier: string; createdAt: string };

export function validatePin(pin: string): string | undefined {
  if (typeof pin !== "string") return "PIN required";
  if (/^\d+$/.test(pin)) return pin.length >= 4 && pin.length <= 12 ? undefined : "PIN must be 4–12 digits";
  return pin.length >= 6 && pin.length <= 64 ? undefined : "Password must be 6–64 characters";
}

export class Vault {
  private db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL; CREATE TABLE IF NOT EXISTS vault (id INTEGER PRIMARY KEY CHECK (id = 1), data TEXT NOT NULL);");
  }
  private row(): VaultRow | undefined {
    const r = this.db.prepare("SELECT data FROM vault WHERE id = 1").get() as { data: string } | undefined;
    return r ? JSON.parse(r.data) : undefined;
  }

  get configured() {
    return !!this.row();
  }

  status() {
    return { configured: !!this.row() };
  }

  async setup(pin: string): Promise<Cipher> {
    if (this.configured) throw new Error("A PIN is already set");
    const bad = validatePin(pin);
    if (bad) throw new Error(bad);
    const salt = randomBytes(16);
    const key = await scrypt(pin, salt, { ...KDF, maxmem: 256 * 1024 * 1024 });
    const cipher = makeCipher(key);
    // Plain INSERT (no upsert): if two setups race, the second fails instead of
    // replacing the salt that the first one's data is already encrypted under.
    try {
      this.db.prepare("INSERT INTO vault (id, data) VALUES (1, ?)").run(JSON.stringify({ salt: salt.toString("base64"), ...KDF, verifier: cipher.encrypt(VERIFIER), createdAt: new Date().toISOString() }));
    } catch {
      throw new Error("A PIN is already set");
    }
    return cipher;
  }

  /** Raw key for adopting this legacy database into a multi-user account. */
  async unlockKey(pin: string): Promise<Buffer> {
    const v = this.row();
    if (!v) throw new Error("No PIN set yet");
    const key = await scrypt(String(pin ?? ""), Buffer.from(v.salt, "base64"), { N: v.N, r: v.r, p: v.p, maxmem: 256 * 1024 * 1024 });
    try {
      if (makeCipher(key).decrypt(v.verifier) !== VERIFIER) throw new Error("bad");
    } catch {
      throw new Error("Wrong PIN");
    }
    return key;
  }

  /** Returns the cipher on success. No lockout (by design); scrypt makes each guess ~0.3 s. */
  async unlock(pin: string): Promise<Cipher> {
    const v = this.row();
    if (!v) throw new Error("No PIN set yet");
    const key = await scrypt(String(pin ?? ""), Buffer.from(v.salt, "base64"), { N: v.N, r: v.r, p: v.p, maxmem: 256 * 1024 * 1024 });
    const cipher = makeCipher(key);
    try {
      if (cipher.decrypt(v.verifier) !== VERIFIER) throw new Error("bad");
    } catch {
      throw new Error("Wrong PIN");
    }
    return cipher;
  }

  /**
   * Verifies the old PIN and prepares the new key. The caller re-encrypts every row
   * AND writes `vaultRow` in the same transaction (Store.reencrypt), so a crash can
   * never leave data under a key nobody knows.
   */
  async prepareChange(oldPin: string, newPin: string): Promise<{ from: Cipher; to: Cipher; vaultRow: string }> {
    const from = await this.unlock(oldPin);
    const bad = validatePin(newPin);
    if (bad) throw new Error(bad);
    const v = this.row()!;
    const salt = randomBytes(16);
    const key = await scrypt(newPin, salt, { ...KDF, maxmem: 256 * 1024 * 1024 });
    const to = makeCipher(key);
    return { from, to, vaultRow: JSON.stringify({ ...v, salt: salt.toString("base64"), ...KDF, verifier: to.encrypt(VERIFIER) }) };
  }

  close() {
    this.db.close();
  }
}

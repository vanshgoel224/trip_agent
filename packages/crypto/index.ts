// Signal-style key handling for Biruni accounts.
//   PIN ──Argon2id──► KEK ──wraps──► DEK (random, per user) ──encrypts──► the user's data
//   Changing the PIN re-wraps the DEK only; data is never re-encrypted.
//   Identity: X25519 key pair per user (private key wrapped by the DEK).
//   Sealed box: ephemeral X25519 + HKDF-SHA256 + AES-256-GCM, so only the recipient
//   can open it (used for shared-trip keys and SOS alerts).
//   Safety numbers: 60 digits from both users' identity keys, like Signal; compare
//   them in person to rule out a server swapping keys.
//   AAD: every stored record is bound to "table:id", so ciphertext can't be moved
//   to another row without failing authentication.
import { createCipheriv, createDecipheriv, createHash, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes, type KeyObject } from "node:crypto";
import { argon2id } from "hash-wasm";
import { availableParallelism } from "node:os";
import { Worker } from "node:worker_threads";

// OWASP Password Storage Cheat Sheet option: m = 46 MiB, t = 1, p = 1 (fast sign-in, memory-hard).
export const KDF_DEFAULT = { alg: "argon2id" as const, m: Number(process.env.ARGON2_MEMORY_KIB ?? 47104), t: Number(process.env.ARGON2_ITERATIONS ?? 1), p: 1 };
export type KdfParams = { alg: "argon2id"; salt: string; m: number; t: number; p: number };
export type Box = { iv: string; ct: string }; // AES-GCM, ct includes the 16-byte tag
export type Sealed = { e: string; iv: string; ct: string }; // e = ephemeral public key (spki, base64)

// Argon2id runs in worker threads so many people signing in at once don't freeze the
// server (each hash is ~0.3 s of CPU and 46 MiB). One short-lived worker per hash, at most
// MAX_KDF_WORKERS at a time; extra sign-ins queue (bounded memory, nothing left running).
const MAX_WORKERS = Math.max(1, Math.min(4, Number(process.env.MAX_KDF_WORKERS ?? (availableParallelism?.() ?? 2) - 1)));
let running = 0;
const queue: (() => void)[] = [];
const slot = () => (running < MAX_WORKERS ? (running++, Promise.resolve()) : new Promise<void>((r) => queue.push(() => (running++, r()))));
const release = () => (running--, queue.shift()?.());

export async function deriveKek(pin: string, kdf: KdfParams): Promise<Buffer> {
  const opts = { password: pin.normalize("NFKC"), salt: kdf.salt, iterations: kdf.t, parallelism: kdf.p, memorySize: kdf.m };
  if (process.env.KDF_INLINE === "1") {
    const out = await argon2id({ ...opts, salt: Buffer.from(kdf.salt, "base64"), hashLength: 32, outputType: "binary" });
    return Buffer.from(out);
  }
  await slot();
  try {
    return await new Promise<Buffer>((resolve, reject) => {
      // Plain JS worker, no inherited flags (under "node --test" it would start a test runner).
      const w = new Worker(new URL("./kdf-worker.mjs", import.meta.url), { execArgv: [] });
      w.once("message", (m: { key?: string; error?: string }) => (m.error ? reject(new Error(m.error)) : resolve(Buffer.from(m.key!, "base64"))));
      w.once("error", reject);
      w.once("exit", (code) => code !== 0 && reject(new Error(`kdf worker exited ${code}`)));
      w.postMessage({ id: 0, ...opts });
    }).finally(() => {});
  } finally {
    release();
  }
}
export const newKdf = (): KdfParams => ({ ...KDF_DEFAULT, salt: randomBytes(16).toString("base64") });

export function boxEncrypt(key: Buffer, plain: Buffer, aad?: string): Box {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  if (aad) c.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([c.update(plain), c.final(), c.getAuthTag()]);
  return { iv: iv.toString("base64"), ct: ct.toString("base64") };
}
export function boxDecrypt(key: Buffer, box: Box, aad?: string): Buffer {
  const buf = Buffer.from(box.ct, "base64");
  const d = createDecipheriv("aes-256-gcm", key, Buffer.from(box.iv, "base64"));
  if (aad) d.setAAD(Buffer.from(aad));
  d.setAuthTag(buf.subarray(buf.length - 16));
  return Buffer.concat([d.update(buf.subarray(0, buf.length - 16)), d.final()]);
}

// ---------- identity keys ----------
export type Identity = { publicKey: string; privateKey: KeyObject };
export function newIdentity(): { publicKey: string; privateDer: Buffer } {
  const { publicKey, privateKey } = generateKeyPairSync("x25519");
  return { publicKey: publicKey.export({ format: "der", type: "spki" }).toString("base64"), privateDer: privateKey.export({ format: "der", type: "pkcs8" }) };
}
export const privateFromDer = (der: Buffer) => createPrivateKey({ key: der, format: "der", type: "pkcs8" });
const publicFromB64 = (b64: string) => createPublicKey({ key: Buffer.from(b64, "base64"), format: "der", type: "spki" });

const sealKey = (shared: Buffer, ePub: string, rPub: string) => Buffer.from(hkdfSync("sha256", shared, Buffer.from(ePub + rPub), "biruni-seal-v1", 32));

/** Encrypt for one recipient's public key. */
export function seal(recipientPublicKey: string, plain: Buffer | string): Sealed {
  const eph = generateKeyPairSync("x25519");
  const ePub = eph.publicKey.export({ format: "der", type: "spki" }).toString("base64");
  const shared = diffieHellman({ privateKey: eph.privateKey, publicKey: publicFromB64(recipientPublicKey) });
  const box = boxEncrypt(sealKey(shared, ePub, recipientPublicKey), Buffer.from(plain), `seal:${recipientPublicKey}`);
  return { e: ePub, ...box };
}
export function unseal(me: Identity, s: Sealed): Buffer {
  const shared = diffieHellman({ privateKey: me.privateKey, publicKey: publicFromB64(s.e) });
  return boxDecrypt(sealKey(shared, s.e, me.publicKey), s, `seal:${me.publicKey}`);
}

// ---------- safety numbers ----------
function fingerprint(publicKey: string, username: string) {
  let h = Buffer.concat([Buffer.from([0, 0]), Buffer.from(publicKey, "base64"), Buffer.from(username.toLowerCase())]);
  const key = Buffer.from(publicKey, "base64");
  for (let i = 0; i < 5200; i++) h = createHash("sha512").update(h).update(key).digest();
  const groups: string[] = [];
  for (let i = 0; i < 30; i += 5) groups.push(String(h.readUIntBE(i, 5) % 100000).padStart(5, "0"));
  return groups.join(" ");
}
/** The same 60 digits on both phones: compare them in person. */
export function safetyNumber(a: { publicKey: string; username: string }, b: { publicKey: string; username: string }) {
  const fa = fingerprint(a.publicKey, a.username), fb = fingerprint(b.publicKey, b.username);
  return [fa, fb].sort().join(" ");
}

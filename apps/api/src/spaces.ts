// Per-user encrypted spaces: who is signed in, and each user's own Biruni runtime.
// A request runs inside its user's context (AsyncLocalStorage), so route code just
// calls rt() / me() and never sees anyone else's data.
import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Accounts, type Unlocked } from "../../../packages/db/accounts";
import { makeCipher, Vault } from "../../../packages/db/vault";
import { BiruniError, config } from "../../../packages/shared";
import { withActor } from "../../../packages/shared/context";
import { GoogleCalendar } from "../../../services/integrations/google-calendar";
import { createBiruni, type Biruni } from "../../../services/runtime";
import { Social, type Me } from "../../../services/social";

export type Space = { me: Me; account: Unlocked["account"]; b: Biruni; calendar: GoogleCalendar; loadedAt: number };

const DATA_DIR = process.env.BIRUNI_DATA_DIR || "data";
const IDLE_MS = Number(process.env.LOCK_IDLE_MIN ?? 30) * 60_000;
const COOKIE = "biruni_session";

export class Spaces {
  readonly accounts = new Accounts(DATA_DIR);
  readonly social = new Social(DATA_DIR, this.accounts);
  private sessions = new Map<string, { userId: string; last: number }>();
  private loaded = new Map<string, Space>();
  private opening = new Map<string, Promise<Space>>();
  private als = new AsyncLocalStorage<Space>();
  /** The pre-multi-user database (one PIN, no username), adopted on first sign-in. */
  private legacy = existsSync(config.dbPath) ? new Vault(config.dbPath) : undefined;

  get legacyPending() {
    return !!this.legacy?.configured && this.accounts.count === 0;
  }

  status(req: IncomingMessage, url: URL) {
    const s = this.session(req);
    const ask = url.searchParams.get("u");
    const acct = ask ? this.accounts.byUsername(ask) : undefined;
    return {
      accounts: this.accounts.count, legacy: this.legacyPending,
      unlocked: !!s, user: s ? this.loaded.get(s.userId)?.account.username : undefined,
      // So a locked phone can still say "someone needs your help" (count only, nothing decrypted).
      sosWaiting: acct ? this.social.activeCountFor(acct.userId) : undefined,
    };
  }

  /** Builds (once) the user's runtime from their DEK. Concurrent sign-ins share one build. */
  private async open(u: Unlocked): Promise<Space> {
    const have = this.loaded.get(u.account.userId);
    if (have) return have;
    const pending = this.opening.get(u.account.userId);
    if (pending) return pending;
    const p = (async () => {
      const me: Me = { userId: u.account.userId, username: u.account.username, identity: u.identity };
      const actor = { userId: me.userId, username: me.username };
      const ctx = <T>(fn: () => T) => withActor(actor, fn);
      const b = withActor(actor, () => createBiruni({ dbPath: u.account.dbFile, cipher: makeCipher(u.dek), context: ctx }));
      const space: Space = { me, account: u.account, b, calendar: new GoogleCalendar(b.store), loadedAt: Date.now() };
      this.loaded.set(me.userId, space);
      withActor(actor, () => {
        void b.mcpClients.connectAll();
        b.autopilot.start();
      });
      return space;
    })();
    this.opening.set(u.account.userId, p);
    try {
      return await p;
    } finally {
      this.opening.delete(u.account.userId);
    }
  }

  async signUp(username: string, pin: string, displayName?: string) {
    if (this.legacyPending) throw new BiruniError("INVALID_REQUEST", "Existing data found: sign in with your current PIN to keep it");
    return this.open(await this.accounts.create(username, pin, { displayName }));
  }

  async signIn(username: string, pin: string) {
    if (this.legacyPending) {
      // First sign-in after the upgrade: the old PIN unlocks the old data, which becomes this account.
      let key: Buffer;
      try {
        key = await this.legacy!.unlockKey(pin);
      } catch {
        throw new BiruniError("AUTH_FAILURE", "Wrong PIN for your existing data");
      }
      this.legacy!.close();
      const u = await this.accounts.create(username || "owner", pin, { existing: { dbPath: config.dbPath, key } });
      this.legacy = undefined;
      return this.open(u);
    }
    return this.open(await this.accounts.unlock(username, pin));
  }

  async firstRunFromEnv() {
    const pin = process.env.BIRUNI_INITIAL_PIN;
    if (!pin || this.accounts.count > 0 || this.legacyPending) return;
    await this.accounts.create(process.env.BIRUNI_INITIAL_USER || "owner", pin).then(
      () => console.log(`Account "${process.env.BIRUNI_INITIAL_USER || "owner"}" created from BIRUNI_INITIAL_PIN. Sign in with it.`),
      (e) => console.error(`BIRUNI_INITIAL_PIN rejected: ${e.message}`),
    );
  }

  startSession(res: ServerResponse, space: Space, secure: boolean) {
    const t = randomBytes(32).toString("hex");
    this.sessions.set(t, { userId: space.me.userId, last: Date.now() });
    res.setHeader("set-cookie", `${COOKIE}=${t}; HttpOnly; SameSite=Strict; Path=/;${secure ? " Secure;" : ""} Max-Age=${Math.round(IDLE_MS / 1000) * 48}`);
  }
  private token(req: IncomingMessage) {
    return new RegExp(`(?:^|;\\s*)${COOKIE}=([a-f0-9]{64})`).exec(String(req.headers.cookie ?? ""))?.[1];
  }
  session(req: IncomingMessage) {
    const t = this.token(req);
    const s = t && this.sessions.get(t);
    if (!t || !s) return undefined;
    if (Date.now() - s.last > IDLE_MS || !this.loaded.has(s.userId)) return void this.sessions.delete(t);
    s.last = Date.now();
    return s;
  }
  spaceFor(req: IncomingMessage) {
    const s = this.session(req);
    return s ? this.loaded.get(s.userId) : undefined;
  }
  lock(req: IncomingMessage, res: ServerResponse, forget = false) {
    const t = this.token(req);
    const s = t ? this.sessions.get(t) : undefined;
    if (t) this.sessions.delete(t);
    // "Sign out everywhere": also drop the in-memory key and runtime (autopilot stops).
    if (forget && s) {
      for (const [k, v] of this.sessions) if (v.userId === s.userId) this.sessions.delete(k);
      const sp = this.loaded.get(s.userId);
      sp?.b.shutdown();
      this.loaded.delete(s.userId);
    }
    res.setHeader("set-cookie", `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
  }

  async changePin(space: Space, oldPin: string, newPin: string) {
    await this.accounts.changePin(space.me.username, oldPin, newPin);
  }

  /** Run fn as this user (events, timers and model settings stay inside their space). */
  run<T>(space: Space, fn: () => T): T {
    return this.als.run(space, () => withActor({ userId: space.me.userId, username: space.me.username }, () => space.b.modelSettings.run(fn)));
  }
  current(): Space {
    const s = this.als.getStore();
    if (!s) throw new BiruniError("AUTH_FAILURE", "Not signed in");
    return s;
  }
  loadedSpace(userId: string) {
    return this.loaded.get(userId);
  }

  /** Server-level hooks (remote MCP, SMS feed, telephony, WhatsApp) act for this user. */
  serviceSpace(): Space | undefined {
    const name = process.env.BIRUNI_SERVICE_USER;
    const acct = name ? this.accounts.byUsername(name) : this.accounts.list()[0];
    return acct ? this.loaded.get(acct.userId) : undefined;
  }

  shutdown() {
    for (const s of this.loaded.values()) s.b.shutdown();
    this.social.close();
    this.accounts.close();
  }
}

export const spaces = new Spaces();
export const rt = () => spaces.current().b;
export const me = () => spaces.current().me;
export const cal = () => spaces.current().calendar;

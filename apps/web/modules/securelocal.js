// Encrypted on-device storage (for your last known locations, so SOS still works
// when the server or the internet is unreachable). Key = PBKDF2-SHA256(PIN, salt,
// 600k iterations), held only in memory while you're signed in. Data = AES-256-GCM.
// Uses the browser's WebCrypto; nothing here is sent anywhere.
const enc = new TextEncoder(), dec = new TextDecoder();
const b64 = (u8) => btoa(String.fromCharCode(...new Uint8Array(u8)));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const ls = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
};

let key = null, user = null;

export const secureLocal = {
  get ready() { return !!key; },
  async unlock(username, pin) {
    if (!crypto?.subtle) return; // plain http on a LAN IP: WebCrypto is unavailable
    user = username;
    let salt = ls.get(`biruni.salt.${user}`);
    if (!salt) ls.set(`biruni.salt.${user}`, (salt = b64(crypto.getRandomValues(new Uint8Array(16)))));
    const base = await crypto.subtle.importKey("raw", enc.encode(pin.normalize("NFKC")), "PBKDF2", false, ["deriveKey"]);
    key = await crypto.subtle.deriveKey({ name: "PBKDF2", salt: unb64(salt), iterations: 600_000, hash: "SHA-256" }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  },
  lock() { key = null; },
  async put(name, value) {
    if (!key) return false;
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: enc.encode(`${user}:${name}`) }, key, enc.encode(JSON.stringify(value)));
    ls.set(`biruni.sec.${user}.${name}`, JSON.stringify({ iv: b64(iv), ct: b64(ct) }));
    return true;
  },
  async get(name, fallback) {
    if (!key) return fallback;
    const raw = ls.get(`biruni.sec.${user}.${name}`);
    if (!raw) return fallback;
    try {
      const { iv, ct } = JSON.parse(raw);
      const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(iv), additionalData: enc.encode(`${user}:${name}`) }, key, unb64(ct));
      return JSON.parse(dec.decode(pt));
    } catch {
      return fallback;
    }
  },
  /** Keeps the last 50 positions (newest first), encrypted. */
  async saveLocation(loc) {
    const list = await this.get("locations", []);
    list.unshift({ lat: loc.lat, lng: loc.lng, accuracy: loc.accuracy, at: new Date().toISOString() });
    return this.put("locations", list.slice(0, 50));
  },
  async lastLocation() {
    return (await this.get("locations", []))[0];
  },
};

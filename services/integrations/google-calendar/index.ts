// Google Calendar — read and add trip events.
// Two ways to connect:
//  1. OAuth (read + write): GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET from a Google
//     Cloud "Web application" OAuth client, Calendar API enabled, redirect URI
//     = GOOGLE_REDIRECT_URI (default APP_BASE_URL + /api/calendar/callback).
//     The traveller then clicks "Connect calendar" in the UI.
//  2. Read-only: GOOGLE_CALENDAR_ICS_URL = the calendar's "secret address in iCal format".
import type { Store } from "../../../packages/db";
import { BiruniError, nowIso } from "../../../packages/shared";

const SCOPE = "https://www.googleapis.com/auth/calendar.events";
const TOKEN_ID = "GOOGLE_CALENDAR_OAUTH";

export type CalEvent = { id?: string; title: string; start: string; end?: string; location?: string; source: "GOOGLE" | "ICS" };
type Tokens = { access_token: string; refresh_token?: string; expires_at: number };

const redirectUri = () => process.env.GOOGLE_REDIRECT_URI || `${process.env.APP_BASE_URL || "http://localhost:8787"}/api/calendar/callback`;
export const oauthConfigured = () => !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
export const icsConfigured = () => !!process.env.GOOGLE_CALENDAR_ICS_URL;

export class GoogleCalendar {
  constructor(private store: Store) {}

  status() {
    const linked = !!this.store.get<Tokens>("consents", TOKEN_ID);
    return {
      oauthConfigured: oauthConfigured(),
      linked,
      icsReadOnly: icsConfigured(),
      canRead: linked || icsConfigured(),
      canWrite: linked,
    };
  }

  authUrl(state: string) {
    if (!oauthConfigured()) throw new BiruniError("AUTH_FAILURE", "Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET first");
    const p = new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID!,
      redirect_uri: redirectUri(),
      response_type: "code",
      scope: SCOPE,
      access_type: "offline",
      prompt: "consent",
      state,
    });
    return `https://accounts.google.com/o/oauth2/v2/auth?${p}`;
  }

  private async tokenRequest(body: Record<string, string>): Promise<Tokens> {
    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: process.env.GOOGLE_CLIENT_ID!, client_secret: process.env.GOOGLE_CLIENT_SECRET!, ...body }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new BiruniError("AUTH_FAILURE", `Google token HTTP ${res.status}: ${(await res.text()).slice(0, 160)}`);
    const j = (await res.json()) as { access_token: string; refresh_token?: string; expires_in: number };
    return { access_token: j.access_token, refresh_token: j.refresh_token, expires_at: Date.now() + j.expires_in * 1000 };
  }

  async handleCallback(code: string) {
    const t = await this.tokenRequest({ code, grant_type: "authorization_code", redirect_uri: redirectUri() });
    this.store.put("consents", TOKEN_ID, { ...t, linkedAt: nowIso(), scope: SCOPE });
  }

  private async accessToken(): Promise<string> {
    const t = this.store.get<Tokens>("consents", TOKEN_ID);
    if (!t) throw new BiruniError("AUTH_FAILURE", "Google Calendar not linked: click Connect calendar");
    if (t.expires_at > Date.now() + 60_000) return t.access_token;
    if (!t.refresh_token) throw new BiruniError("AUTH_FAILURE", "Calendar token expired: reconnect");
    const n = await this.tokenRequest({ refresh_token: t.refresh_token, grant_type: "refresh_token" });
    this.store.put("consents", TOKEN_ID, { ...t, ...n, refresh_token: n.refresh_token ?? t.refresh_token });
    return n.access_token;
  }

  async list(days = 14): Promise<CalEvent[]> {
    const from = new Date();
    const to = new Date(Date.now() + days * 86_400_000);
    if (this.status().linked) {
      const p = new URLSearchParams({ timeMin: from.toISOString(), timeMax: to.toISOString(), singleEvents: "true", orderBy: "startTime", maxResults: "50" });
      const res = await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events?${p}`, { headers: { authorization: `Bearer ${await this.accessToken()}` }, signal: AbortSignal.timeout(10_000) });
      if (!res.ok) throw new BiruniError("EXTERNAL_FAILURE", `Calendar HTTP ${res.status}`);
      const j = (await res.json()) as { items?: any[] };
      return (j.items ?? []).map((e) => ({ id: e.id, title: e.summary ?? "(no title)", start: e.start?.dateTime ?? e.start?.date, end: e.end?.dateTime ?? e.end?.date, location: e.location, source: "GOOGLE" as const }));
    }
    if (icsConfigured()) {
      const res = await fetch(process.env.GOOGLE_CALENDAR_ICS_URL!, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) throw new BiruniError("EXTERNAL_FAILURE", `ICS HTTP ${res.status}`);
      return parseIcs(await res.text()).filter((e) => new Date(e.start) >= from && new Date(e.start) <= to);
    }
    throw new BiruniError("AUTH_FAILURE", "Calendar not connected: set GOOGLE_CLIENT_ID/SECRET and click Connect, or set GOOGLE_CALENDAR_ICS_URL");
  }

  async add(e: { title: string; start: string; end?: string; location?: string; description?: string }): Promise<CalEvent> {
    const end = e.end ?? new Date(new Date(e.start).getTime() + 3600_000).toISOString();
    const res = await fetch("https://www.googleapis.com/calendar/v3/calendars/primary/events", {
      method: "POST",
      headers: { authorization: `Bearer ${await this.accessToken()}`, "content-type": "application/json" },
      body: JSON.stringify({ summary: e.title, location: e.location, description: e.description ?? "Added by Biruni", start: { dateTime: new Date(e.start).toISOString() }, end: { dateTime: new Date(end).toISOString() } }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new BiruniError("EXTERNAL_FAILURE", `Calendar insert HTTP ${res.status}: ${(await res.text()).slice(0, 160)}`);
    const j = (await res.json()) as any;
    return { id: j.id, title: j.summary, start: j.start?.dateTime, end: j.end?.dateTime, location: j.location, source: "GOOGLE" };
  }
}

/** Minimal VEVENT parser: SUMMARY, DTSTART, DTEND, LOCATION. Ignores recurrence rules. */
export function parseIcs(ics: string): CalEvent[] {
  const unfolded = ics.replace(/\r?\n[ \t]/g, "");
  const toIso = (v: string) => {
    const m = v.match(/(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?/);
    if (!m) return v;
    return m[4] ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}${m[7] ? "Z" : ""}` : `${m[1]}-${m[2]}-${m[3]}`;
  };
  return unfolded.split("BEGIN:VEVENT").slice(1).map((block) => {
    const get = (k: string) => block.match(new RegExp(`^${k}[^:\\n]*:(.*)$`, "m"))?.[1]?.trim();
    return { title: get("SUMMARY") ?? "(no title)", start: toIso(get("DTSTART") ?? ""), end: get("DTEND") ? toIso(get("DTEND")!) : undefined, location: get("LOCATION"), source: "ICS" as const };
  });
}

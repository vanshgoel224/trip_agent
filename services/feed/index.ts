// Operator status feed: turns real-world signals into autopilot operator events.
//  1. Flights: AviationStack (AVIATIONSTACK_KEY). Leg needs a flight number, taken from
//     the leg's bookingRef/vendor (e.g. "6E 2134"). Response fields used: flight_status,
//     departure.delay. Verify against aviationstack.com docs for your plan; the free plan
//     is HTTP-only and rate-limited (about 100 calls/month), so polling is sparse.
//  2. Forwarded SMS / email: the traveller pastes or forwards an operator message
//     (IRCTC, airline, bus operator). Parsed locally, no model needed: cancelled,
//     delayed/rescheduled, platform/gate changes, in English and Hindi.
//  3. Booking partners: status of bookings made through TBO/Agoda/EaseMyTrip (simulated today).
// Every signal goes through autopilot.operatorEvent, so the usual corroboration,
// stale-signal and ₹2,000 authority rules apply.
import type { Store } from "../../packages/db";
import type { ItineraryLeg, TripState } from "../../packages/domain";
import { BiruniError } from "../../packages/shared";
import type { Autopilot } from "../autopilot";
import type { PartnerHub } from "../integrations/partners";

export type ParsedOperatorMessage = { status: "CANCELLED" | "DELAYED" | "ON_TIME"; delayMin?: number; refs: string[]; operator?: string; detail: string };

const HINDI_DIGITS: Record<string, string> = { "०": "0", "१": "1", "२": "2", "३": "3", "४": "4", "५": "5", "६": "6", "७": "7", "८": "8", "९": "9" };

/** Parse an operator SMS/email. Returns undefined if it isn't a status message. */
export function parseOperatorMessage(raw: string): ParsedOperatorMessage | undefined {
  const text = String(raw ?? "").slice(0, 5000).replace(/[०-९]/g, (d) => HINDI_DIGITS[d]);
  const t = text.toLowerCase();
  const refs = new Set<string>();
  for (const m of text.matchAll(/\bPNR[:\s#-]*([A-Z0-9]{6,10})\b/gi)) refs.add(m[1].toUpperCase());
  for (const m of text.matchAll(/\b(?:train|trn|ट्रेन)\s*(?:no\.?|number|#)?\s*:?\s*(\d{5})\b/gi)) refs.add(m[1]);
  for (const m of text.matchAll(/\b((?:6E|AI|IX|QP|SG|UK|I5|G8)\s?-?\d{2,4})\b/g)) refs.add(m[1].replace(/[\s-]/g, "").toUpperCase());
  const operator = /irctc/i.test(text) ? "IRCTC" : /indigo|\b6e\b/i.test(text) ? "IndiGo" : /air india/i.test(text) ? "Air India" : /akasa/i.test(text) ? "Akasa Air" : /spicejet/i.test(text) ? "SpiceJet" : /redbus|ksrtc|msrtc|vrl|srs/i.test(text) ? "Bus operator" : undefined;
  const cancelled = /\b(cancel+ed|cancel+ation of|stands cancel+ed|has been cancel+ed|not operat(e|ing)|withdrawn)\b|रद्द|निरस्त/.test(t);
  // "delayed by 2 hrs 15 min", "late by 90 minutes", "rescheduled to 21:40" (no minutes → unknown delay)
  let delayMin: number | undefined;
  const hm = t.match(/(?:delay(?:ed)?|late|running late|विलंब|देरी)[^\d]{0,20}(\d{1,2})\s*(?:hrs?|hours?|घंटे)(?:\s*(?:and\s*)?(\d{1,2})\s*(?:mins?|minutes?|मिनट))?/);
  const mOnly = t.match(/(?:delay(?:ed)?|late|विलंब|देरी)[^\d]{0,20}(\d{1,3})\s*(?:mins?|minutes?|मिनट)/);
  // Number first, delay word after: "2 घंटे देरी से", "45 min late"
  const hmRev = t.match(/(\d{1,2})\s*(?:hrs?|hours?|घंटे|घंटा)(?:\s*(\d{1,2})\s*(?:mins?|minutes?|मिनट))?[^\d]{0,20}(?:late|delay|देरी|विलंब)/);
  const mRev = t.match(/(\d{1,3})\s*(?:mins?|minutes?|मिनट)[^\d]{0,20}(?:late|delay|देरी|विलंब)/);
  if (hm) delayMin = Number(hm[1]) * 60 + Number(hm[2] ?? 0);
  else if (mOnly) delayMin = Number(mOnly[1]);
  else if (hmRev) delayMin = Number(hmRev[1]) * 60 + Number(hmRev[2] ?? 0);
  else if (mRev) delayMin = Number(mRev[1]);
  const delayed = delayMin !== undefined || /\b(delayed|rescheduled|running late|revised departure|new departure)\b|विलंब|देरी/.test(t);
  const onTime = /\b(on time|on schedule|right time)\b/.test(t);
  if (cancelled) return { status: "CANCELLED", refs: [...refs], operator, detail: "cancellation" };
  if (delayed) return { status: "DELAYED", delayMin, refs: [...refs], operator, detail: delayMin ? `delay ${delayMin} min` : "delay (minutes not stated)" };
  if (onTime) return { status: "ON_TIME", refs: [...refs], operator, detail: "on time" };
  return undefined;
}

const norm = (s?: string) => String(s ?? "").replace(/[\s-]/g, "").toUpperCase();

export class OperatorFeed {
  private lastFlightPoll = new Map<string, number>();
  constructor(private d: { store: Store; autopilot: Autopilot; partners: PartnerHub }) {}

  status() {
    return {
      flights: process.env.AVIATIONSTACK_KEY ? "AviationStack (live)" : "not connected: set AVIATIONSTACK_KEY (aviationstack.com)",
      forwarded: "on: paste or forward operator SMS/email in any chat or POST /api/feed/message",
      partners: "on: booking-partner status (simulated until partner keys)",
    };
  }

  /** Which leg a message is about: PNR/flight/train match, else the next upcoming leg. */
  private matchLeg(trip: TripState, refs: string[]): ItineraryLeg | undefined {
    const live = trip.itinerary.legs.filter((l) => l.status === "CONFIRMED" || l.status === "PLANNED");
    const byRef = live.find((l) => refs.some((r) => norm(l.bookingRef).includes(r) || norm(l.vendor).includes(r)));
    if (byRef) return byRef;
    return live.filter((l) => Date.parse(l.departure) > Date.now() - 3 * 3600_000).sort((a, b) => a.departure.localeCompare(b.departure))[0];
  }

  /** Forwarded operator message → operator event. The traveller forwarding it counts as a confirmed report. */
  ingestMessage(tripId: string, text: string) {
    const trip = this.d.store.get<TripState>("trips", tripId);
    if (!trip) throw new BiruniError("INVALID_REQUEST", "Unknown trip");
    const p = parseOperatorMessage(text);
    if (!p) return { recognised: false as const, note: "Not an operator status message (no cancellation/delay/on-time wording found)." };
    const leg = this.matchLeg(trip, p.refs);
    if (!leg) return { recognised: true as const, parsed: p, note: "No upcoming leg on this trip to attach it to." };
    const event = this.d.autopilot.operatorEvent(tripId, { legId: leg.legId, status: p.status, delayMin: p.delayMin, source: `operator message forwarded by traveller (confirmed)${p.operator ? ` · ${p.operator}` : ""}` });
    return { recognised: true as const, parsed: p, leg: { legId: leg.legId, from: leg.from, to: leg.to }, event };
  }

  /** One polling pass for a trip: partner bookings, then flights (sparse, to respect API quotas). */
  async poll(tripId: string) {
    const out: string[] = [];
    const trip = this.d.store.get<TripState>("trips", tripId);
    if (!trip) return out;
    for (const b of this.d.partners.list(tripId)) {
      if (b.offer.kind === "hotel") continue;
      const r = await this.d.partners.refresh(b.bookingRef).catch(() => undefined);
      if (!r?.changed) continue;
      const leg = trip.itinerary.legs.find((l) => norm(l.bookingRef) === norm(b.pnr));
      if (!leg || !["CANCELLED", "DELAYED"].includes(r.booking.status)) continue;
      this.d.autopilot.operatorEvent(tripId, { legId: leg.legId, status: r.booking.status as "CANCELLED" | "DELAYED", delayMin: r.booking.delayMin, source: `booking partner ${b.partner}${b.simulated ? " (simulated)" : " (official)"}` });
      out.push(`${b.pnr} ${r.booking.status}`);
    }
    const key = process.env.AVIATIONSTACK_KEY;
    if (key) {
      for (const leg of trip.itinerary.legs.filter((l) => l.mode === "FLIGHT" && l.status === "CONFIRMED")) {
        const dep = Date.parse(leg.departure);
        if (dep < Date.now() - 2 * 3600_000 || dep > Date.now() + 24 * 3600_000) continue; // only around departure
        const last = this.lastFlightPoll.get(leg.legId) ?? 0;
        if (Date.now() - last < Number(process.env.AVIATIONSTACK_POLL_MIN ?? 30) * 60_000) continue;
        this.lastFlightPoll.set(leg.legId, Date.now());
        const flight = [leg.bookingRef, leg.vendor].map((x) => norm(x).match(/(6E|AI|IX|QP|SG|UK|I5|G8)\d{2,4}/)?.[0]).find(Boolean);
        if (!flight) continue;
        const s = await this.flightStatus(flight, key).catch(() => undefined);
        if (!s || s.status === "ON_TIME") continue;
        this.d.autopilot.operatorEvent(tripId, { legId: leg.legId, status: s.status, delayMin: s.delayMin, source: "AviationStack (official)" });
        out.push(`${flight} ${s.status}`);
      }
    }
    return out;
  }

  async flightStatus(flightIata: string, key: string): Promise<{ status: "CANCELLED" | "DELAYED" | "ON_TIME"; delayMin?: number } | undefined> {
    const base = process.env.AVIATIONSTACK_BASE_URL || "http://api.aviationstack.com/v1";
    const res = await fetch(`${base}/flights?access_key=${encodeURIComponent(key)}&flight_iata=${encodeURIComponent(flightIata)}`, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`AviationStack HTTP ${res.status}`);
    const j = (await res.json()) as { data?: { flight_status?: string; departure?: { delay?: number | null } }[] };
    const f = j.data?.[0];
    if (!f) return undefined;
    if (f.flight_status === "cancelled") return { status: "CANCELLED" };
    const delay = Number(f.departure?.delay ?? 0);
    return delay >= 15 ? { status: "DELAYED", delayMin: delay } : { status: "ON_TIME" };
  }
}

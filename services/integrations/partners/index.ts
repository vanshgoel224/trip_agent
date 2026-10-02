// Travel booking partners: flights, hotels, buses, trains.
//   TBO (TBO.com / TekTravels): India's all-in-one B2B API; primary.
//   Agoda: hotels (affiliate / partner API).
//   EaseMyTrip: flights, hotels, buses (partner access only).
// None of these publish open self-serve docs: endpoints, auth and field names come with
// partner onboarding (business KYC). So the live adapters are honest slots: they report
// "credentials present, endpoints not wired" instead of guessing an API. Until a
// partner kit arrives, the simulator serves every kind for any Indian city pair, with
// prices in ₹, PNRs, status changes and cancellations, all clearly marked simulated.
import { createHash } from "node:crypto";
import type { Store } from "../../../packages/db";
import { BiruniError, id, nowIso } from "../../../packages/shared";

export type Kind = "flight" | "hotel" | "bus" | "rail";
export type PartnerId = "tbo" | "agoda" | "easemytrip" | "simulator";
export type SearchQuery = { kind: Kind; from?: string; to?: string; city?: string; date: string; nights?: number; passengers?: number; maxPrice?: number };
export type Offer = {
  offerId: string; partner: PartnerId; kind: Kind; title: string; operator: string;
  from?: string; to?: string; city?: string; date: string; depart?: string; arrive?: string; nights?: number;
  className: string; priceInr: number; perPerson: boolean; refundable: boolean; seatsLeft: number;
  expiresAt: string; simulated: boolean;
};
export type BookingStatus = "CONFIRMED" | "CANCELLED" | "DELAYED" | "COMPLETED";
export type PartnerBooking = {
  bookingRef: string; partner: PartnerId; offer: Offer; travellers: string[]; contactPhone?: string; totalInr: number;
  pnr: string; status: BookingStatus; delayMin?: number; tripId?: string; bookedBy?: string; simulated: boolean;
  history: { at: string; status: BookingStatus; note?: string }[]; createdAt: string;
};

export interface Partner {
  id: PartnerId; label: string; kinds: Kind[]; configured(): boolean; note(): string;
  search(q: SearchQuery): Promise<Offer[]>;
  book(offer: Offer, travellers: string[], phone?: string): Promise<{ pnr: string }>;
  status(b: PartnerBooking): Promise<{ status: BookingStatus; delayMin?: number }>;
  cancel(b: PartnerBooking): Promise<{ refundInr: number }>;
}

// ---------------- live slots ----------------

class LiveSlot implements Partner {
  constructor(public id: PartnerId, public label: string, public kinds: Kind[], private envKeys: string[], private onboarding: string) {}
  configured() {
    return this.envKeys.every((k) => !!process.env[k]);
  }
  note() {
    return this.configured()
      ? `${this.label}: credentials present, but API endpoints are not wired yet (need the partner's API kit). Using the simulator.`
      : `${this.label}: not connected. ${this.onboarding} Set ${this.envKeys.join(", ")}.`;
  }
  private refuse(): never {
    throw new BiruniError("EXTERNAL_FAILURE", this.note());
  }
  search(): Promise<Offer[]> {
    this.refuse();
  }
  book(): Promise<{ pnr: string }> {
    this.refuse();
  }
  status(): Promise<{ status: BookingStatus }> {
    this.refuse();
  }
  cancel(): Promise<{ refundInr: number }> {
    this.refuse();
  }
}

// ---------------- simulator ----------------

const h = (s: string) => createHash("sha256").update(s.toLowerCase()).digest().readUInt32BE(0);
const pick = <T>(xs: T[], seed: number) => xs[seed % xs.length];
const hhmm = (min: number) => `${String(Math.floor(min / 60) % 24).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
const roundTo = (n: number, step: number) => Math.round(n / step) * step;

const AIRLINES = ["IndiGo", "Air India", "Akasa Air", "Air India Express", "SpiceJet"];
const BUSES = ["VRL Travels", "SRS Travels", "Zingbus", "IntrCity SmartBus", "Orange Travels", "Neeta Travels", "KSRTC Airavat", "MSRTC Shivneri"];
const TRAINS = ["Rajdhani Express", "Shatabdi Express", "Vande Bharat Express", "Duronto Express", "Superfast Express", "Mail Express"];
const HOTELS = ["Treebo", "FabHotel", "Lemon Tree", "Ginger", "Zostel", "OYO Townhouse", "Taj Vivanta", "ibis"];

export class Simulator implements Partner {
  id: PartnerId = "simulator";
  label = "Simulated inventory";
  kinds: Kind[] = ["flight", "hotel", "bus", "rail"];
  /** Status overrides set by the demo operator feed. */
  static overrides = new Map<string, { status: BookingStatus; delayMin?: number }>();
  configured() {
    return true;
  }
  note() {
    return "Simulated: any Indian city pair, prices in ₹, fake PNRs. Nothing is really booked or paid.";
  }
  async search(q: SearchQuery): Promise<Offer[]> {
    const pax = Math.max(1, Math.min(9, Math.round(q.passengers ?? 1)));
    const expires = new Date(Date.now() + 15 * 60_000).toISOString();
    const base = { partner: "simulator" as const, kind: q.kind, date: q.date, simulated: true, expiresAt: expires };
    // Same search → same offer ids, so "book the cheapest one" still works after a re-search.
    const oid = (i: number) => `OFR-${(h(`${q.kind}|${q.from ?? ""}|${q.to ?? ""}|${q.city ?? ""}|${q.date}|${q.nights ?? 1}|${pax}|${i}`) >>> 0).toString(16).toUpperCase().padStart(8, "0")}`;
    const out: Offer[] = [];
    if (q.kind === "hotel") {
      const city = q.city ?? q.to ?? "";
      const nights = Math.max(1, Math.min(30, Math.round(q.nights ?? 1)));
      for (let i = 0; i < 5; i++) {
        const s = h(`${city}|${q.date}|${i}`);
        const brand = pick(HOTELS, s);
        const perNight = roundTo(800 + (s % 5200) * (brand === "Taj Vivanta" ? 1.8 : 1), 50);
        out.push({ ...base, offerId: oid(i), operator: brand, city, title: `${brand} ${city}`, nights, className: pick(["Standard room", "Deluxe room", "Dorm bed", "Suite"], s >>> 3), priceInr: perNight * nights, perPerson: false, refundable: s % 3 !== 0, seatsLeft: 1 + (s % 6) });
      }
    } else {
      if (!q.from || !q.to) throw new BiruniError("INVALID_REQUEST", "from and to are needed");
      const km = 120 + (h(`${[q.from, q.to].sort().join("|")}`) % 1900);
      for (let i = 0; i < 4; i++) {
        const s = h(`${q.from}|${q.to}|${q.date}|${q.kind}|${i}`);
        const dep = (5 * 60 + (s % (17 * 60))) - ((s % (17 * 60)) % 5);
        let minutes: number, fare: number, operator: string, cls: string;
        if (q.kind === "flight") {
          minutes = 60 + Math.round(km / 12) + (s % 40);
          fare = 2800 + km * 3.2 + (s % 3500);
          operator = pick(AIRLINES, s);
          cls = s % 7 === 0 ? "Business" : "Economy";
          if (cls === "Business") fare *= 3.5;
        } else if (q.kind === "bus") {
          minutes = Math.round((km / 45) * 60);
          fare = 250 + km * 1.4 + (s % 400);
          operator = pick(BUSES, s);
          cls = pick(["AC Sleeper", "Volvo AC Seater", "Non-AC Sleeper"], s >>> 4);
        } else {
          minutes = Math.round((km / 55) * 60);
          cls = pick(["Sleeper (SL)", "AC 3 Tier (3A)", "AC 2 Tier (2A)", "AC Chair Car (CC)"], s >>> 4);
          fare = 120 + km * ({ "Sleeper (SL)": 0.55, "AC 3 Tier (3A)": 1.5, "AC 2 Tier (2A)": 2.2, "AC Chair Car (CC)": 1.3 } as Record<string, number>)[cls];
          operator = `${10000 + (s % 89999)} ${pick(TRAINS, s >>> 2)}`;
        }
        out.push({ ...base, offerId: oid(i), operator, from: q.from, to: q.to, title: `${operator} ${q.from} → ${q.to}`, depart: hhmm(dep), arrive: hhmm(dep + minutes), className: cls, priceInr: roundTo(fare, 10) * pax, perPerson: false, refundable: s % 4 !== 0, seatsLeft: 1 + (s % 20) });
      }
    }
    return out.filter((o) => !q.maxPrice || o.priceInr <= q.maxPrice).sort((a, b) => a.priceInr - b.priceInr);
  }
  async book(offer: Offer) {
    const pnr = offer.kind === "flight" ? id("").slice(1, 7).replace(/-/g, "X") : offer.kind === "rail" ? String(4000000000 + (h(offer.offerId) % 999999999)) : id("SIM").replace(/-/g, "");
    return { pnr };
  }
  async status(b: PartnerBooking) {
    return Simulator.overrides.get(b.bookingRef) ?? { status: b.status };
  }
  async cancel(b: PartnerBooking) {
    return { refundInr: b.offer.refundable ? Math.round(b.totalInr * 0.85) : 0 };
  }
}

// ---------------- hub ----------------

export class PartnerHub {
  readonly live: Record<Exclude<PartnerId, "simulator">, Partner> = {
    tbo: new LiveSlot("tbo", "TBO (TekTravels)", ["flight", "hotel", "bus", "rail"], ["TBO_USERNAME", "TBO_PASSWORD", "TBO_CLIENT_ID"], "B2B agent account with business KYC from tbo.com."),
    agoda: new LiveSlot("agoda", "Agoda", ["hotel"], ["AGODA_SITE_ID", "AGODA_API_KEY"], "Agoda partner/affiliate account (partners.agoda.com)."),
    easemytrip: new LiveSlot("easemytrip", "EaseMyTrip", ["flight", "hotel", "bus"], ["EASEMYTRIP_API_KEY"], "Partner API access by agreement with EaseMyTrip."),
  };
  readonly sim = new Simulator();
  constructor(private store: Store) {}

  status() {
    return { partners: Object.values(this.live).map((p) => ({ id: p.id, label: p.label, kinds: p.kinds, configured: p.configured(), note: p.note() })), active: "simulator", note: this.sim.note() };
  }

  /** Live partners are tried first when wired; today every search lands on the simulator. */
  private partnerFor(kind: Kind): Partner {
    return this.sim;
  }

  async search(q: SearchQuery): Promise<Offer[]> {
    if (!["flight", "hotel", "bus", "rail"].includes(q.kind)) throw new BiruniError("INVALID_REQUEST", "kind must be flight, hotel, bus or rail");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(q.date))) throw new BiruniError("INVALID_REQUEST", "date must be YYYY-MM-DD");
    const offers = await this.partnerFor(q.kind).search(q);
    for (const o of offers) this.store.put("offers", o.offerId, o, { key: o.kind });
    return offers;
  }

  offer(offerId: string) {
    return this.store.get<Offer>("offers", offerId);
  }

  async book(input: { offerId: string; travellers: string[]; phone?: string; tripId?: string; bookedBy?: string }): Promise<PartnerBooking> {
    const offer = this.offer(input.offerId);
    if (!offer) throw new BiruniError("INVALID_REQUEST", "Unknown offer: search again");
    if (Date.parse(offer.expiresAt) < Date.now()) throw new BiruniError("INVALID_REQUEST", "This fare expired: search again for the current price");
    const travellers = (Array.isArray(input.travellers) ? input.travellers : []).map((t) => String(t).trim()).filter(Boolean).slice(0, 9);
    if (!travellers.length) throw new BiruniError("INVALID_REQUEST", "Traveller names (as on ID) are needed to book");
    if (input.phone && !/^(\+91)?[6-9]\d{9}$/.test(String(input.phone).replace(/[\s-]/g, ""))) throw new BiruniError("INVALID_REQUEST", "Phone must be an Indian mobile number");
    // Idempotent: the same offer for the same people is booked once.
    const key = `${offer.offerId}|${travellers.join(",").toLowerCase()}`;
    const dup = this.store.findByKey<PartnerBooking>("partner_bookings", key);
    if (dup) return dup;
    const p = offer.simulated ? this.sim : this.live[offer.partner as Exclude<PartnerId, "simulator">];
    const { pnr } = await p.book(offer, travellers, input.phone);
    const b: PartnerBooking = {
      bookingRef: id("BKG"), partner: offer.partner, offer, travellers, contactPhone: input.phone, totalInr: offer.priceInr, pnr, status: "CONFIRMED",
      tripId: input.tripId, bookedBy: input.bookedBy, simulated: offer.simulated, history: [{ at: nowIso(), status: "CONFIRMED" }], createdAt: nowIso(),
    };
    this.store.put("partner_bookings", b.bookingRef, b, { tripId: input.tripId, key });
    return b;
  }

  get(ref: string) {
    return this.store.get<PartnerBooking>("partner_bookings", ref) ?? this.list().find((b) => b.pnr === ref);
  }
  list(tripId?: string) {
    return this.store.list<PartnerBooking>("partner_bookings", tripId ? { tripId } : {});
  }
  private save(b: PartnerBooking) {
    this.store.put("partner_bookings", b.bookingRef, b, { tripId: b.tripId, key: `${b.offer.offerId}|${b.travellers.join(",").toLowerCase()}` });
  }

  /** Polls the partner; returns the booking and whether its status changed. */
  async refresh(ref: string): Promise<{ booking: PartnerBooking; changed: boolean }> {
    const b = this.get(ref);
    if (!b) throw new BiruniError("INVALID_REQUEST", "Unknown booking");
    if (b.status === "CANCELLED" || b.status === "COMPLETED") return { booking: b, changed: false };
    const p = b.simulated ? this.sim : this.live[b.partner as Exclude<PartnerId, "simulator">];
    const s = await p.status(b);
    const changed = s.status !== b.status || s.delayMin !== b.delayMin;
    if (changed) {
      b.status = s.status;
      b.delayMin = s.delayMin;
      b.history.push({ at: nowIso(), status: s.status, note: s.delayMin ? `+${s.delayMin} min` : "from partner" });
      this.save(b);
    }
    return { booking: b, changed };
  }

  async cancel(ref: string, note = "cancelled by traveller") {
    const b = this.get(ref);
    if (!b) throw new BiruniError("INVALID_REQUEST", "Unknown booking");
    if (b.status === "CANCELLED") return { booking: b, refundInr: 0, alreadyCancelled: true };
    const p = b.simulated ? this.sim : this.live[b.partner as Exclude<PartnerId, "simulator">];
    const { refundInr } = await p.cancel(b);
    b.status = "CANCELLED";
    b.history.push({ at: nowIso(), status: "CANCELLED", note });
    this.save(b);
    return { booking: b, refundInr };
  }

  summary(b: PartnerBooking) {
    const o = b.offer;
    const when = o.kind === "hotel" ? `${o.date}, ${o.nights} night(s)` : `${o.date} ${o.depart}→${o.arrive}`;
    return `${o.title} · ${o.className} · ${when} · ₹${b.totalInr.toLocaleString("en-IN")} · PNR ${b.pnr} · ${b.status}${b.delayMin ? ` (+${b.delayMin} min)` : ""}${b.simulated ? " · SIMULATED" : ""}`;
  }
}

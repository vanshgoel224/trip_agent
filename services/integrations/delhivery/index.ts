// Delhivery — geocoding, routing, pickups (spec §7).
// Booking inventory and the vendor directory are simulated (spec §29); the
// design artifact does not name a rail for them.
import type { Route } from "../../../packages/domain";
import type { Store } from "../../../packages/db";
import { BiruniError, id, inr, nowIso } from "../../../packages/shared";
import { distanceM, findPlace } from "../openstreetmap";
import { simulator, type VendorDirectoryEntry } from "../simulator";

export interface RoutingProvider {
  geocode(place: string): Promise<{ name: string; lat: number; lng: number }>;
  alternatives(tripId: string, from: string, to: string): Promise<Route[]>;
  vendorProfile(vendorId: string): Promise<VendorDirectoryEntry | undefined>;
}

export interface BookingProvider {
  book(tripId: string, route: Route, idempotencyKey: string): Promise<{ pnr: string }>;
  cancel(pnr: string): Promise<{ cancelled: boolean }>;
  verify(pnr: string): Promise<{ confirmed: boolean }>;
}

const KNOWN: Record<string, [number, number]> = {
  mumbai: [19.076, 72.8777],
  chennai: [13.0827, 80.2707],
  pune: [18.5204, 73.8567],
  bengaluru: [12.9716, 77.5946],
};

export class MockRoutingProvider implements RoutingProvider {
  async geocode(place: string) {
    if (!place.trim()) throw new BiruniError("INVALID_REQUEST", "empty place");
    const k = KNOWN[place.toLowerCase()];
    return { name: place, lat: k?.[0] ?? 0, lng: k?.[1] ?? 0 }; // unknown places: simulated, no coordinates
  }
  async alternatives(tripId: string, from: string, to: string) {
    const sim = simulator.trip(tripId);
    const fixed = sim.routes.filter((r) => r.from.toLowerCase() === from.toLowerCase() && r.to.toLowerCase() === to.toLowerCase());
    const routes = fixed.length || !sim.synthetic ? fixed : syntheticRoutes(from, to, sim.referenceFare || 1500);
    return routes.map((r) => ({ ...r, source: "LIVE" as const }));
  }
  async vendorProfile(vendorId: string) {
    return simulator.vendors.get(vendorId);
  }
}

/** SIMULATED alternatives for any city pair, priced off the original fare. Not real inventory. */
function syntheticRoutes(from: string, to: string, fare: number): Omit<Route, "source">[] {
  const at = (h: number) => {
    const d = new Date(Date.now() + 5.5 * 3600_000 + h * 3600_000);
    return `${d.toISOString().slice(0, 13)}:00:00+05:30`;
  };
  const slug = `${from}-${to}`.toUpperCase().replace(/[^A-Z]+/g, "");
  const r = (n: string, name: string, vendorId: string, rung: Route["vendorRung"], mult: number, mode: Route["mode"], h: number) => ({
    routeId: `RT-${slug}-${n}`, from, to, mode, departure: at(h), vendorId, vendorName: `${name} (simulated)`, vendorRung: rung, price: Math.round((fare * mult) / 10) * 10,
  });
  return [
    r("PL", "Express Sleeper Coach", "VND-PL-NUEGO", "PINE_LABS_MERCHANT", 0.8, "BUS", 2),
    r("UPI", "City Travels", "VND-UPI-SAIRAM", "UPI_OPERATOR", 0.9, "BUS", 3),
    r("LOC", "Local Tempo Service", "VND-LOCAL-RAJU", "LOCAL_TRANSPORT", 1.1, "OTHER", 2),
    r("CASH", "Private bus (cash)", "VND-CASH-AUTO", "LOGGED_CASH", 0.6, "BUS", 4),
  ];
}

export class MockBookingProvider implements BookingProvider {
  pnrs = new Map<string, { status: "CONFIRMED" | "CANCELLED"; key: string }>();
  async book(_tripId: string, _route: Route, idempotencyKey: string) {
    for (const [pnr, b] of this.pnrs) if (b.key === idempotencyKey) return { pnr };
    const pnr = id("PNR");
    this.pnrs.set(pnr, { status: "CONFIRMED", key: idempotencyKey });
    return { pnr };
  }
  async cancel(pnr: string) {
    const b = this.pnrs.get(pnr);
    if (b) b.status = "CANCELLED";
    return { cancelled: !!b };
  }
  async verify(pnr: string) {
    return { confirmed: this.pnrs.get(pnr)?.status === "CONFIRMED" };
  }
}

/**
 * Delhivery — parcel / luggage booking (send bags ahead, ship purchases home).
 * Works end to end in the app: quote → book (traveller's explicit yes) → waybill →
 * tracking → cancel. Without a key every booking is SIMULATED and labelled so.
 * With DELHIVERY_API_KEY + DELHIVERY_PICKUP_LOCATION (your registered warehouse
 * name) it also files a real Pickup Request:
 *   POST https://track.delhivery.com/fm/request/new/  (staging: staging-express.delhivery.com)
 *   inputs per Delhivery's docs: pickup_time, pickup_date, pickup_location, expected_package_count
 *   auth header "Authorization: Token <key>" is an assumption — verify in Delhivery One's developer portal.
 * Real waybill/shipment creation isn't implemented: its request format isn't public.
 */

export type ParcelStatus = "PICKUP_SCHEDULED" | "PICKED_UP" | "IN_TRANSIT" | "OUT_FOR_DELIVERY" | "DELIVERED" | "CANCELLED";
export type Quote = { quoteId: string; from: string; to: string; weightKg: number; service: "surface" | "express"; price: number; etaDays: number; distanceKm: number; simulated: boolean; createdAt: string };
export type Parcel = {
  bookingId: string; awb: string; quote: Quote; tripId?: string;
  pickupAddress: string; dropAddress: string; contactName: string; phone: string; pickupDate: string; contents: string;
  status: ParcelStatus; simulated: boolean; livePickupId?: string; liveError?: string; createdAt: string; cancelledAt?: string;
};

const STAGES: ParcelStatus[] = ["PICKUP_SCHEDULED", "PICKED_UP", "IN_TRANSIT", "OUT_FOR_DELIVERY", "DELIVERED"];
const rid = (p: string) => `${p}-${Date.now().toString(36).toUpperCase()}${Math.random().toString(36).slice(2, 6).toUpperCase()}`;

export class Delhivery {
  readonly name = "Delhivery";
  constructor(private store: Store) {}

  get keyed() {
    return !!(process.env.DELHIVERY_API_KEY && process.env.DELHIVERY_PICKUP_LOCATION);
  }
  status() {
    return { active: true, keyed: this.keyed, note: this.keyed ? "Bookings also file a real Delhivery pickup request" : "Active: bookings are simulated until DELHIVERY_API_KEY + DELHIVERY_PICKUP_LOCATION are set" };
  }

  /** Simulated tariff (no public rate card used). */
  async quote(from: string, to: string, weightKg: number, service: "surface" | "express" = "surface"): Promise<Quote> {
    if (!(weightKg > 0 && weightKg <= 50)) throw new Error("weight must be between 0 and 50 kg");
    const [a, b] = await Promise.all([findPlace(from), findPlace(to)]);
    if (!a[0]) throw new Error(`Couldn't find "${from}"`);
    if (!b[0]) throw new Error(`Couldn't find "${to}"`);
    const km = Math.max(5, Math.round(distanceM(a[0], b[0]) / 1000));
    const base = 80 + 45 * Math.ceil(weightKg) + 0.18 * km * Math.max(1, weightKg / 5);
    const price = Math.round((service === "express" ? base * 1.6 : base) / 10) * 10;
    const etaDays = service === "express" ? Math.ceil(km / 900) + 1 : Math.ceil(km / 450) + 2;
    const q: Quote = { quoteId: rid("DLQ"), from: a[0].name, to: b[0].name, weightKg, service, price, etaDays, distanceKm: km, simulated: true, createdAt: nowIso() };
    this.store.put("parcels", q.quoteId, q, { key: "QUOTE" });
    return q;
  }

  async book(input: { quoteId: string; pickupAddress: string; dropAddress: string; contactName: string; phone: string; pickupDate: string; contents: string; tripId?: string }): Promise<Parcel> {
    const q = this.store.get<Quote>("parcels", input.quoteId);
    if (!q) throw new Error("Unknown or expired quote: get a quote first");
    if (Date.now() - Date.parse(q.createdAt) > 30 * 60_000) throw new Error("Quote expired (30 min): get a fresh quote");
    if (!/^(\+91[- ]?)?[6-9]\d{9}$/.test(input.phone.replace(/[\s-]/g, ""))) throw new Error("Phone must be a valid Indian mobile number");
    const parcel: Parcel = {
      bookingId: rid("DLB"), awb: String(Math.floor(1e12 + Math.random() * 9e12)), quote: q, tripId: input.tripId,
      pickupAddress: input.pickupAddress, dropAddress: input.dropAddress, contactName: input.contactName, phone: input.phone,
      pickupDate: input.pickupDate.slice(0, 10), contents: input.contents, status: "PICKUP_SCHEDULED", simulated: !this.keyed, createdAt: nowIso(),
    };
    if (this.keyed) {
      try {
        const res = await fetch(`${process.env.DELHIVERY_API_URL || "https://track.delhivery.com"}/fm/request/new/`, {
          method: "POST",
          headers: { authorization: `Token ${process.env.DELHIVERY_API_KEY}`, "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify({ pickup_time: "11:00:00", pickup_date: parcel.pickupDate, pickup_location: process.env.DELHIVERY_PICKUP_LOCATION, expected_package_count: 1 }),
          signal: AbortSignal.timeout(15_000),
        });
        const j = (await res.json().catch(() => ({}))) as any;
        if (!res.ok) throw new Error(`HTTP ${res.status}: ${JSON.stringify(j).slice(0, 160)}`);
        parcel.livePickupId = String(j.pickup_id ?? j.pickupId ?? "");
      } catch (e) {
        parcel.liveError = e instanceof Error ? e.message : String(e);
        parcel.simulated = true;
      }
    }
    this.store.put("parcels", parcel.bookingId, parcel, { tripId: input.tripId, key: "BOOKING" });
    return parcel;
  }

  /** Simulated tracking advances one stage every N minutes (DELHIVERY_SIM_STAGE_MIN, default 3). */
  track(idOrAwb: string): Parcel & { events: { status: ParcelStatus; at: string }[] } {
    const p = this.list().find((x) => x.bookingId === idOrAwb || x.awb === idOrAwb);
    if (!p) throw new Error(`No booking ${idOrAwb}`);
    if (p.status === "CANCELLED") return { ...p, events: [{ status: "CANCELLED", at: p.cancelledAt! }] };
    const per = Number(process.env.DELHIVERY_SIM_STAGE_MIN ?? 3) * 60_000;
    const stage = Math.min(STAGES.length - 1, Math.floor((Date.now() - Date.parse(p.createdAt)) / per));
    const events = STAGES.slice(0, stage + 1).map((status, i) => ({ status, at: new Date(Date.parse(p.createdAt) + i * per).toISOString() }));
    if (p.status !== STAGES[stage]) this.store.put("parcels", p.bookingId, { ...p, status: STAGES[stage] }, { tripId: p.tripId, key: "BOOKING" });
    return { ...p, status: STAGES[stage], events };
  }

  cancel(idOrAwb: string) {
    const p = this.track(idOrAwb);
    if (p.status !== "PICKUP_SCHEDULED") throw new Error(`Can't cancel: parcel is already ${p.status.replace(/_/g, " ").toLowerCase()}`);
    const next = { ...p, status: "CANCELLED" as const, cancelledAt: nowIso() };
    delete (next as any).events;
    this.store.put("parcels", p.bookingId, next, { tripId: p.tripId, key: "BOOKING" });
    return next;
  }

  list(tripId?: string): Parcel[] {
    return this.store.list<Parcel>("parcels", { key: "BOOKING", ...(tripId ? { tripId } : {}) });
  }

  summary(p: Parcel) {
    return `${p.simulated ? "[SIMULATED] " : ""}${p.quote.from} → ${p.quote.to}, ${p.quote.weightKg} kg ${p.quote.service}, ${inr(p.quote.price)}, AWB ${p.awb}, pickup ${p.pickupDate}`;
  }
}

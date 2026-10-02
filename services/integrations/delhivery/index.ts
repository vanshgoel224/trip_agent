// Delhivery — geocoding, routing, pickups (spec §7).
// Booking inventory and the vendor directory are simulated (spec §29); the
// design artifact does not name a rail for them.
import type { Route } from "../../../packages/domain";
import { BiruniError, id } from "../../../packages/shared";
import { notImplemented, requireEnv } from "../live-stub";
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
    const k = KNOWN[place.toLowerCase()];
    if (!k) throw new BiruniError("INVALID_REQUEST", `unknown place ${place} in simulator`);
    return { name: place, lat: k[0], lng: k[1] };
  }
  async alternatives(tripId: string, from: string, to: string) {
    return simulator
      .trip(tripId)
      .routes.filter((r) => r.from.toLowerCase() === from.toLowerCase() && r.to.toLowerCase() === to.toLowerCase())
      .map((r) => ({ ...r, source: "LIVE" as const }));
  }
  async vendorProfile(vendorId: string) {
    return simulator.vendors.get(vendorId);
  }
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

export class DelhiveryProvider implements RoutingProvider {
  constructor() {
    requireEnv("DELHIVERY_API_KEY", "DELHIVERY_API_URL");
  }
  geocode(): Promise<never> {
    return notImplemented("delhivery", "geocode");
  }
  alternatives(): Promise<never> {
    return notImplemented("delhivery", "alternatives");
  }
  vendorProfile(): Promise<never> {
    return notImplemented("delhivery", "vendorProfile");
  }
}

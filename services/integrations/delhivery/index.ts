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

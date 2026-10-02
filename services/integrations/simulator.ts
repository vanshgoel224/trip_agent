// Realistic simulator for capabilities that cannot be connected end-to-end
// for the demo (spec §29): route alternatives, booking inventory, vendor
// directory, payment faults, disruption events. All prices are simulated INR
// figures for the demo, NOT real fares.
import type { Debit, Route } from "../../packages/domain";

export type VendorDirectoryEntry = {
  vendorId: string;
  identityVerified: boolean;
  rating: number;
  reviewCount: number;
  distanceFromQuotedPickupKm: number;
  fraudFlags: string[];
};

export type TripSimulation = {
  routes: Omit<Route, "source">[];
  referenceFare: number;
  faults: {
    /** Payment provider accepts the charge, then the response times out. */
    paymentTimeoutAfterCharge?: boolean;
    /** Rungs whose payment rail declines. */
    declineRungs?: Route["vendorRung"][];
  };
};

export type SimAccount = { balance: number; debits: Debit[] };

class Simulator {
  trips = new Map<string, TripSimulation>();
  vendors = new Map<string, VendorDirectoryEntry>();
  accounts = new Map<string, SimAccount>();
  holdings = new Map<string, { symbol: string; qty: number; lastPrice: number }[]>();

  configureTrip(tripId: string, sim: TripSimulation) {
    this.trips.set(tripId, sim);
  }
  trip(tripId: string): TripSimulation {
    return this.trips.get(tripId) ?? { routes: [], referenceFare: 0, faults: {} };
  }
}

export const simulator = new Simulator();

// ---------- Seed data ----------

const monthsAgo = (n: number, day: number, now = new Date()) =>
  new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - n, day)).toISOString().slice(0, 10);

/** Six months of debits, the window spec §7 gives for Setu AA. */
export function sixMonthsOfDebits(opts: { rent: number; emi: number; fee?: number }): Debit[] {
  const out: Debit[] = [];
  for (let m = 1; m <= 6; m++) {
    out.push({ date: monthsAgo(m, 3), narration: "NEFT RENT LANDLORD SHARMA", amount: opts.rent });
    out.push({ date: monthsAgo(m, 5), narration: "ACH EMI HDFC LOAN 4471", amount: opts.emi });
    out.push({ date: monthsAgo(m, 12), narration: "UPI SWIGGY", amount: 300 + m * 40 });
    out.push({ date: monthsAgo(m, 18), narration: "UPI JIO RECHARGE", amount: 299 });
  }
  if (opts.fee) out.push({ date: monthsAgo(1, 20), narration: "COLLEGE FEE INSTALMENT", amount: opts.fee });
  return out;
}

export function seedVendors() {
  const v = (e: VendorDirectoryEntry) => simulator.vendors.set(e.vendorId, e);
  v({ vendorId: "VND-PL-NUEGO", identityVerified: true, rating: 4.3, reviewCount: 1200, distanceFromQuotedPickupKm: 0.4, fraudFlags: [] });
  v({ vendorId: "VND-UPI-SAIRAM", identityVerified: true, rating: 4.0, reviewCount: 85, distanceFromQuotedPickupKm: 0.8, fraudFlags: [] });
  v({ vendorId: "VND-LOCAL-RAJU", identityVerified: true, rating: 4.1, reviewCount: 32, distanceFromQuotedPickupKm: 1.1, fraudFlags: [] });
  v({ vendorId: "VND-LOCAL-SHADY", identityVerified: false, rating: 2.1, reviewCount: 3, distanceFromQuotedPickupKm: 6, fraudFlags: ["duplicate_phone"] });
  v({ vendorId: "VND-PL-AIR", identityVerified: true, rating: 4.4, reviewCount: 5000, distanceFromQuotedPickupKm: 0, fraudFlags: [] });
  v({ vendorId: "VND-CASH-AUTO", identityVerified: true, rating: 3.9, reviewCount: 14, distanceFromQuotedPickupKm: 0.3, fraudFlags: [] });
}

export function seedHoldings(consentId: string) {
  simulator.holdings.set(consentId, [
    { symbol: "NIFTYBEES", qty: 40, lastPrice: 270 },
    { symbol: "INFY", qty: 5, lastPrice: 1500 },
  ]);
}

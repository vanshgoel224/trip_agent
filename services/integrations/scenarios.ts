// Demo scenarios (spec §26 A–D, plus ladder, safety, offline and restart).
// All fares, balances and vendors are SIMULATED and fictional.
import type { Route } from "../../packages/domain";
import type { Biruni } from "../runtime";
import { seedHoldings, simulator, sixMonthsOfDebits, type TripSimulation } from "./simulator";

export const SCENARIOS = {
  A: { title: "Successful recovery", trigger: "My bus to Chennai was cancelled" },
  B: { title: "Authority exceeded", trigger: "My bus to Chennai was cancelled" },
  C: { title: "Obligation protected", trigger: "My bus to Chennai was cancelled" },
  D: { title: "Duplicate payment risk (timeout after charge)", trigger: "My bus to Chennai was cancelled" },
  LADDER: { title: "Vendor ladder fallback", trigger: "My bus to Chennai was cancelled" },
  SAFETY: { title: "Safety escalation", trigger: "There was an accident and I feel unsafe" },
  OFFLINE: { title: "Offline recovery from cache", trigger: "Bus cancelled, no network here" },
  RESTART: { title: "Agent crash + restart without double payment", trigger: "My bus to Chennai was cancelled" },
} as const;

export type ScenarioName = keyof typeof SCENARIOS;

const tonight = (hh: number, mm = 0) => {
  const d = new Date(Date.now() + 5.5 * 3600_000); // IST date
  const date = d.toISOString().slice(0, 10);
  return `${date}T${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:00+05:30`;
};

const r = (routeId: string, vendorName: string, vendorId: string, vendorRung: Route["vendorRung"], price: number, mode: Route["mode"], dep: string): Omit<Route, "source"> => ({
  routeId, from: "Mumbai", to: "Chennai", mode, departure: dep, vendorId, vendorName, vendorRung, price,
});

function simFor(name: ScenarioName): TripSimulation {
  const pl = r("RT-PL-1", "Konkan Sleeper Coach", "VND-PL-NUEGO", "PINE_LABS_MERCHANT", 1200, "BUS", tonight(22, 30));
  const upi = r("RT-UPI-1", "Sairam Travels", "VND-UPI-SAIRAM", "UPI_OPERATOR", 1350, "BUS", tonight(23, 0));
  const shady = r("RT-LOC-0", "Quick Cab (unverified)", "VND-LOCAL-SHADY", "LOCAL_TRANSPORT", 1400, "CAB", tonight(22, 0));
  const local = r("RT-LOC-1", "Raju Tours Tempo", "VND-LOCAL-RAJU", "LOCAL_TRANSPORT", 1600, "OTHER", tonight(23, 30));
  const cash = r("RT-CASH-1", "Private sleeper (cash)", "VND-CASH-AUTO", "LOGGED_CASH", 900, "BUS", tonight(23, 45));
  switch (name) {
    case "B":
      return { routes: [r("RT-PL-B", "Konkan Sleeper Coach", "VND-PL-NUEGO", "PINE_LABS_MERCHANT", 2450, "BUS", tonight(23, 15))], referenceFare: 1800, faults: {} };
    case "C":
      return { routes: [r("RT-PL-C", "Konkan Sleeper Coach", "VND-PL-NUEGO", "PINE_LABS_MERCHANT", 1400, "BUS", tonight(22, 30))], referenceFare: 1800, faults: {} };
    case "D":
      return { routes: [pl], referenceFare: 1800, faults: { paymentTimeoutAfterCharge: true } };
    case "LADDER":
      return { routes: [pl, upi, shady, local, cash], referenceFare: 1800, faults: { declineRungs: ["PINE_LABS_MERCHANT", "UPI_OPERATOR"] } };
    case "OFFLINE":
      return { routes: [pl, cash], referenceFare: 1800, faults: {} };
    default:
      return { routes: [pl, upi], referenceFare: 1800, faults: {} };
  }
}

export type CustomTripInput = {
  name?: string;
  origin: string;
  destination: string;
  departure: string; // ISO or "YYYY-MM-DDTHH:MM" (IST assumed)
  mode?: "BUS" | "TRAIN" | "FLIGHT" | "CAB";
  fare?: number;
  operator?: string;
  dailyCeiling?: number;
};

/** A trip on the traveller's own route. Finance data and alternatives are SIMULATED. */
export async function createCustomTrip(b: Biruni, input: CustomTripInput) {
  const consentId = `AA-CONSENT-CUSTOM-${Date.now()}`;
  simulator.accounts.set(consentId, { balance: 48_000, debits: sixMonthsOfDebits({ rent: 15_000, emi: 6_500 }) });
  seedHoldings(consentId);
  const dep = /[+Z]/.test(input.departure.slice(10)) ? input.departure : `${input.departure.slice(0, 16)}:00+05:30`;
  const fare = Math.max(0, Math.round(input.fare ?? 1500));
  const trip = b.orchestrator.createTrip({
    traveller: {
      name: input.name?.trim() || "Traveller",
      age: 22,
      preferredLanguage: "en-IN",
      dailyCeiling: input.dailyCeiling ?? 3000,
      emergencyContact: { name: "Emergency contact", phone: "+91-90000-00001" },
      emergencyAutoAlertOptIn: false,
      aaConsentId: consentId,
    },
    itinerary: {
      origin: input.origin.trim(),
      destination: input.destination.trim(),
      legs: [{ legId: "LEG-1", from: input.origin.trim(), to: input.destination.trim(), mode: input.mode ?? "BUS", departure: dep, vendor: input.operator || "Your operator", cost: fare, status: "CONFIRMED" }],
    },
    currentLocation: { name: input.origin.trim() },
  });
  simulator.configureTrip(trip.tripId, { routes: [], referenceFare: fare || 1500, synthetic: true, faults: {} });
  await b.orchestrator.prepareTrip(trip.tripId);
  return { tripId: trip.tripId };
}

export async function seedScenario(b: Biruni, name: ScenarioName) {
  const consentId = `AA-CONSENT-${name}-${Date.now()}`;
  // Scenario C: free balance ₹1,200 after rent + EMI; recovery costs ₹1,400.
  const balance = name === "C" ? 22_700 : 48_000;
  simulator.accounts.set(consentId, { balance, debits: sixMonthsOfDebits({ rent: 15_000, emi: 6_500 }) });
  seedHoldings(consentId);

  const trip = b.orchestrator.createTrip({
    traveller: {
      name: "Aarav",
      age: 22,
      phone: "+91-90000-00000",
      preferredLanguage: "en-IN",
      dailyCeiling: 3000,
      emergencyContact: { name: "Meera (sister)", phone: "+91-90000-00001" },
      emergencyAutoAlertOptIn: false,
      aaConsentId: consentId,
    },
    itinerary: {
      origin: "Mumbai",
      destination: "Chennai",
      legs: [{ legId: "LEG-1", from: "Mumbai", to: "Chennai", mode: "BUS", departure: tonight(21, 0), vendor: "Original operator", bookingRef: "PNR-ORIG", cost: 1800, status: "CONFIRMED" }],
    },
    currentLocation: { name: "Mumbai Central bus depot", lat: 18.969, lng: 72.8205 },
  });
  simulator.configureTrip(trip.tripId, simFor(name));
  await b.orchestrator.prepareTrip(trip.tripId);
  if (name === "OFFLINE") b.orchestrator.setConnectivity(trip.tripId, false);
  if (name === "RESTART") b.recovery.faults.crashAfterPayment = true;
  return { tripId: trip.tripId, trigger: SCENARIOS[name].trigger, title: SCENARIOS[name].title };
}

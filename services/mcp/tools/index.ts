// The seven Biruni MCP tools (spec §6). Names are PROVISIONAL — see schemas/index.ts.
import type { AgentName, BookingRecord, PaymentRecord, Route, TripState, Traveller } from "../../../packages/domain";
import type { Store } from "../../../packages/db";
import { verifyVendor } from "../../../packages/policy";
import { BiruniError, id, nowIso } from "../../../packages/shared";
import type { Providers } from "../../integrations";
import { schemas, type ToolArgs, type ToolName } from "../schemas";

export type ToolDeps = { store: Store; providers: Providers };

export type ToolDef<N extends ToolName> = {
  name: N;
  rail: string;
  description: string;
  allowedAgents: AgentName[];
  /** Amount this call would spend (drives finance + authority checks). */
  spend(args: ToolArgs<N>): number;
  /** Consequential calls carry an idempotency key and are never blindly retried. */
  idempotencyKey(args: ToolArgs<N>): string | undefined;
  execute(args: ToolArgs<N>, deps: ToolDeps): Promise<unknown>;
  /** Ask the rail whether an ambiguous earlier attempt actually completed. */
  reconcile?(args: ToolArgs<N>, deps: ToolDeps): Promise<{ completed: boolean; data?: unknown }>;
};

const none = () => 0;
const noKey = () => undefined;

const voice_speak: ToolDef<"voice_speak"> = {
  name: "voice_speak",
  rail: "Gnani",
  description: "Speak a message to the traveller (or, if opted in, their emergency contact) via Gnani voice.",
  allowedAgents: ["voice"],
  spend: none,
  idempotencyKey: noKey,
  async execute(a, { store, providers }) {
    const trip = store.get<TripState>("trips", a.tripId)!;
    const traveller = store.get<Traveller>("users", trip.travellerId)!;
    const to = a.to === "EMERGENCY_CONTACT" ? (traveller.emergencyContact?.phone ?? "unknown") : (traveller.phone ?? traveller.travellerId);
    return providers.voice.speak(a.text, a.language, to);
  },
};

const route_search: ToolDef<"route_search"> = {
  name: "route_search",
  rail: "Delhivery",
  description: "Find alternative routes between two places (live via Delhivery, or from the pre-fetched offline cache).",
  allowedAgents: ["travel"],
  spend: none,
  idempotencyKey: noKey,
  async execute(a, { store, providers }) {
    if (a.offline) {
      const cached = store.get<{ routes: Route[] }>("offline_cache", `ROUTES-${a.tripId}`);
      return (cached?.routes ?? [])
        .filter((r) => r.from.toLowerCase() === a.from.toLowerCase() && r.to.toLowerCase() === a.to.toLowerCase())
        .map((r) => ({ ...r, source: "OFFLINE_CACHE" }));
    }
    await providers.routing.geocode(a.from);
    await providers.routing.geocode(a.to);
    const routes = await providers.routing.alternatives(a.tripId, a.from, a.to);
    for (const r of routes) store.put("routes", r.routeId, r, { tripId: a.tripId, incidentId: a.incidentId });
    return routes;
  },
};

const vendor_verify: ToolDef<"vendor_verify"> = {
  name: "vendor_verify",
  rail: "Vendor directory (simulated)",
  description: "Check a vendor's identity, reviews, location consistency, quoted price and fraud indicators.",
  allowedAgents: ["recovery"],
  spend: none,
  idempotencyKey: noKey,
  async execute(a, { providers }) {
    const p = await providers.routing.vendorProfile(a.vendorId);
    if (!p) return { pass: false, reason: "Vendor not found in directory", checks: {} };
    return verifyVendor({ ...p, quotedPrice: a.quotedPrice, referenceFare: a.referenceFare });
  },
};

const payment_execute: ToolDef<"payment_execute"> = {
  name: "payment_execute",
  rail: "Pine Labs",
  description: "Charge, refund or check status of a recovery payment. Charges are bounded by obligation + authority guards.",
  allowedAgents: ["recovery"],
  spend: (a) => (a.operation === "charge" ? a.amount : 0),
  idempotencyKey: (a) => (a.operation === "status" ? undefined : a.idempotencyKey),
  async execute(a, { store, providers }) {
    if (a.operation === "charge") {
      const paymentId = `PAY-${a.idempotencyKey}`;
      const rec: PaymentRecord = store.get<PaymentRecord>("payments", paymentId) ?? {
        paymentId, idempotencyKey: a.idempotencyKey, incidentId: a.incidentId, tripId: a.tripId, amount: a.amount,
        rung: a.rung, vendorId: a.vendorId, status: "PENDING", createdAt: nowIso(), updatedAt: nowIso(),
      };
      store.put("payments", paymentId, rec, { tripId: a.tripId, incidentId: a.incidentId, key: a.idempotencyKey });
      const r = await providers.payments.charge({ idempotencyKey: a.idempotencyKey, amount: a.amount, vendorId: a.vendorId, rung: a.rung, tripId: a.tripId });
      const done = { ...rec, status: "SUCCESS" as const, externalRef: r.externalRef, updatedAt: nowIso() };
      store.put("payments", paymentId, done, { tripId: a.tripId, incidentId: a.incidentId, key: a.idempotencyKey });
      return done;
    }
    const rec = store.get<PaymentRecord>("payments", a.paymentId);
    if (!rec) throw new BiruniError("INVALID_REQUEST", `unknown payment ${a.paymentId}`);
    if (a.operation === "status") {
      const s = await providers.payments.status(rec.idempotencyKey);
      return { paymentId: rec.paymentId, local: rec.status, rail: s };
    }
    if (rec.status !== "SUCCESS") throw new BiruniError("INVALID_REQUEST", `cannot refund payment in state ${rec.status}`);
    const refund = rec.rung === "LOGGED_CASH" ? { refundRef: "CASH-VOID", status: "REFUNDED" } : await providers.payments.refund(rec.externalRef!, rec.amount, a.idempotencyKey);
    const done = { ...rec, status: "REFUNDED" as const, updatedAt: nowIso() };
    store.put("payments", rec.paymentId, done, { tripId: rec.tripId, incidentId: rec.incidentId, key: rec.idempotencyKey });
    return { ...done, refund };
  },
  async reconcile(a, { store, providers }) {
    if (a.operation !== "charge") return { completed: false };
    const s = await providers.payments.status(a.idempotencyKey);
    if (!s.found || s.status !== "SUCCESS") return { completed: false };
    const paymentId = `PAY-${a.idempotencyKey}`;
    const prev = store.get<PaymentRecord>("payments", paymentId);
    const rec: PaymentRecord = {
      paymentId, idempotencyKey: a.idempotencyKey, incidentId: a.incidentId, tripId: a.tripId, amount: a.amount, rung: a.rung,
      vendorId: a.vendorId, status: "SUCCESS", externalRef: s.externalRef, createdAt: prev?.createdAt ?? nowIso(), updatedAt: nowIso(),
    };
    store.put("payments", paymentId, rec, { tripId: a.tripId, incidentId: a.incidentId, key: a.idempotencyKey });
    return { completed: true, data: rec };
  },
};

const booking_execute: ToolDef<"booking_execute"> = {
  name: "booking_execute",
  rail: "Booking inventory (simulated)",
  description: "Book, cancel or verify a recovery booking.",
  allowedAgents: ["booking"],
  spend: none,
  idempotencyKey: (a) => (a.operation === "verify" ? undefined : a.idempotencyKey),
  async execute(a, { store, providers }) {
    if (a.operation === "book") {
      const pay = store.get<PaymentRecord>("payments", a.paymentId);
      if (!pay || pay.status !== "SUCCESS") throw new BiruniError("POLICY_BLOCKED", "booking requires a successful payment");
      const { pnr } = await providers.booking.book(a.tripId, a.route as Route, a.idempotencyKey);
      const rec: BookingRecord = { bookingId: `BKG-${a.idempotencyKey}`, idempotencyKey: a.idempotencyKey, tripId: a.tripId, incidentId: a.incidentId, routeId: a.route.routeId, paymentId: a.paymentId, status: "CONFIRMED", pnr, createdAt: nowIso() };
      store.put("bookings", rec.bookingId, rec, { tripId: a.tripId, incidentId: a.incidentId, key: a.idempotencyKey });
      return rec;
    }
    const rec = store.get<BookingRecord>("bookings", a.bookingId);
    if (!rec) throw new BiruniError("INVALID_REQUEST", `unknown booking ${a.bookingId}`);
    if (a.operation === "verify") return { ...rec, ...(await providers.booking.verify(rec.pnr)) };
    await providers.booking.cancel(rec.pnr);
    const done = { ...rec, status: "CANCELLED" as const };
    store.put("bookings", rec.bookingId, done, { tripId: rec.tripId, incidentId: rec.incidentId, key: rec.idempotencyKey });
    return done;
  },
};

const financial_context: ToolDef<"financial_context"> = {
  name: "financial_context",
  rail: "Setu AA",
  description: "Fetch consented account balance and recent debits for obligation inference.",
  allowedAgents: ["finance"],
  spend: none,
  idempotencyKey: noKey,
  async execute(a, { store, providers }) {
    const trip = store.get<TripState>("trips", a.tripId)!;
    const t = store.get<Traveller>("users", trip.travellerId)!;
    return providers.financial.fetch(t.aaConsentId!, a.months);
  },
};

const holdings_context: ToolDef<"holdings_context"> = {
  name: "holdings_context",
  rail: "Zerodha",
  description: "Read-only investment holdings for financial context. Never sold for recovery.",
  allowedAgents: ["finance"],
  spend: none,
  idempotencyKey: noKey,
  async execute(a, { store, providers }) {
    const trip = store.get<TripState>("trips", a.tripId)!;
    const t = store.get<Traveller>("users", trip.travellerId)!;
    return providers.holdings.holdings(t.aaConsentId!);
  },
};

export const TOOLS = { voice_speak, route_search, vendor_verify, payment_execute, booking_execute, financial_context, holdings_context } as const;

export { schemas };
export const newToolCallId = () => id("CALL");

// Compile-time guard: exactly the schema set.
const _check: Record<ToolName, ToolDef<any>> = TOOLS;
void _check;

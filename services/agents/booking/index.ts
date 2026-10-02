// Booking / execution specialist — recovery booking, cancellation, verification,
// itinerary versioning (spec §4.7).
import type { Activity, BookingRecord, Itinerary, ItineraryLeg, Route, TripState } from "../../../packages/domain";
import type { Store } from "../../../packages/db";
import { id, nowIso } from "../../../packages/shared";
import { bus } from "../../../packages/events";
import type { AgentMcp } from "../../mcp/client";

export class BookingAgent {
  constructor(private store: Store, private mcp: AgentMcp) {}

  async book(tripId: string, incidentId: string, route: Route, paymentId: string, idempotencyKey: string) {
    return this.mcp.call("booking_execute", { tripId, incidentId, operation: "book", route, paymentId, idempotencyKey });
  }
  async cancel(tripId: string, incidentId: string, bookingId: string) {
    return this.mcp.call("booking_execute", { tripId, incidentId, operation: "cancel", bookingId, idempotencyKey: `${bookingId}-CANCEL` });
  }
  async verify(tripId: string, incidentId: string, bookingId: string) {
    const r = await this.mcp.call("booking_execute", { tripId, incidentId, operation: "verify", bookingId });
    return r.success && (r.data as { confirmed: boolean }).confirmed;
  }

  /** Produce the new itinerary: affected leg REPLACED, recovery leg CONFIRMED. */
  applyReplacement(tripId: string, affectedLegId: string | undefined, route: Route, booking: BookingRecord): Itinerary {
    const trip = this.store.get<TripState>("trips", tripId)!;
    this.store.put("itineraries", `${tripId}-v${trip.itinerary.version}`, trip.itinerary, { tripId });
    const newLegId = `LEG-${booking.bookingId}`;
    const legs = trip.itinerary.legs.map((l) => (l.legId === affectedLegId ? { ...l, status: "REPLACED" as const, replacedBy: newLegId } : l));
    const idx = legs.findIndex((l) => l.legId === affectedLegId);
    const leg = { legId: newLegId, from: route.from, to: route.to, mode: route.mode, departure: route.departure, arrival: route.arrival, vendor: route.vendorName, bookingRef: booking.pnr, cost: route.price, status: "CONFIRMED" as const };
    legs.splice(idx >= 0 ? idx + 1 : legs.length, 0, leg);
    const itinerary: Itinerary = { ...trip.itinerary, version: trip.itinerary.version + 1, legs };
    this.store.put("trips", tripId, { ...trip, itinerary, currentRoute: route, updatedAt: nowIso() }, { tripId });
    this.store.put("itineraries", `${tripId}-v${itinerary.version}`, itinerary, { tripId });
    bus.emitEvent({ tripId, incidentId: booking.incidentId, agent: "booking", type: "ITINERARY", detail: `Itinerary v${itinerary.version}: ${route.mode} ${route.from} → ${route.to} ${route.departure.slice(11, 16)}, PNR ${booking.pnr}`, data: itinerary });
    return itinerary;
  }

  /** A transport booking the traveller made (travel_book) becomes an itinerary leg the autopilot watches. */
  addLeg(tripId: string, leg: Omit<ItineraryLeg, "legId" | "status">) {
    const trip = this.store.get<TripState>("trips", tripId);
    if (!trip) return undefined;
    const newLeg: ItineraryLeg = { ...leg, legId: `LEG-${leg.bookingRef ?? Date.now()}`, status: "CONFIRMED" };
    if (trip.itinerary.legs.some((l) => l.legId === newLeg.legId)) return trip.itinerary;
    const legs = [...trip.itinerary.legs, newLeg].sort((a, b) => a.departure.localeCompare(b.departure));
    const itinerary: Itinerary = { ...trip.itinerary, version: trip.itinerary.version + 1, legs };
    this.store.put("trips", tripId, { ...trip, itinerary, updatedAt: nowIso() }, { tripId });
    this.store.put("itineraries", `${tripId}-v${itinerary.version}`, itinerary, { tripId });
    bus.emitEvent({ tripId, agent: "booking", type: "ITINERARY", detail: `Added ${leg.mode} ${leg.from} → ${leg.to} ${leg.departure.slice(0, 16)}, PNR ${leg.bookingRef}`, data: itinerary });
    return itinerary;
  }

  revertItinerary(tripId: string, toVersion: number) {
    const trip = this.store.get<TripState>("trips", tripId)!;
    const prev = this.store.get<Itinerary>("itineraries", `${tripId}-v${toVersion}`);
    if (!prev) return trip.itinerary;
    const itinerary = { ...prev, version: trip.itinerary.version + 1 };
    this.store.put("trips", tripId, { ...trip, itinerary, currentRoute: undefined, updatedAt: nowIso() }, { tripId });
    this.store.put("itineraries", `${tripId}-v${itinerary.version}`, itinerary, { tripId });
    return itinerary;
  }

  // ---------- traveller activities (non-transport plans) ----------

  addActivity(tripId: string, a: Omit<Activity, "activityId">): Activity {
    const trip = this.store.get<TripState>("trips", tripId)!;
    const act: Activity = { activityId: id("ACT"), ...a };
    const activities = [...(trip.activities ?? []), act].sort((x, y) => `${x.date}${x.time ?? ""}`.localeCompare(`${y.date}${y.time ?? ""}`));
    this.store.put("trips", tripId, { ...trip, activities, updatedAt: nowIso() }, { tripId });
    bus.emitEvent({ tripId, agent: "booking", type: "ACTIVITY", detail: `Added ${a.date}${a.time ? " " + a.time : ""} ${a.title}` });
    return act;
  }

  updateActivity(tripId: string, activityId: string, patch: Partial<Activity>) {
    const trip = this.store.get<TripState>("trips", tripId)!;
    const activities = (trip.activities ?? []).map((x) => (x.activityId === activityId ? { ...x, ...patch, activityId } : x));
    this.store.put("trips", tripId, { ...trip, activities, updatedAt: nowIso() }, { tripId });
    return activities.find((x) => x.activityId === activityId);
  }

  removeActivity(tripId: string, activityId: string) {
    const trip = this.store.get<TripState>("trips", tripId)!;
    const before = trip.activities ?? [];
    const activities = before.filter((x) => x.activityId !== activityId);
    this.store.put("trips", tripId, { ...trip, activities, updatedAt: nowIso() }, { tripId });
    if (activities.length < before.length) bus.emitEvent({ tripId, agent: "booking", type: "ACTIVITY", detail: `Removed activity ${activityId}` });
    return before.length - activities.length;
  }
}

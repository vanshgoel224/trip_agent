// Phone sensors: GPS (browser Geolocation API) and accelerometer (DeviceMotion).
// Crash/fall detection is a heuristic, not a certified safety system:
//   the phone reports a hard impact (peak ≥ IMPACT_G) followed by stillness;
//   Biruni asks "Are you OK?" and, if there is no answer within CHECKIN_MS,
//   escalates through the normal SAFETY path (emergency contact only per policy).
import type { Store } from "../../packages/db";
import { id, nowIso } from "../../packages/shared";
import { bus } from "../../packages/events";
import type { Directions } from "../integrations/openstreetmap";

export type LocationReading = { lat: number; lng: number; accuracy?: number; speed?: number | null; heading?: number | null; at: string };
export type ImpactReading = { peakG: number; stillSeconds?: number; at: string };

export const IMPACT_G = Number(process.env.IMPACT_G ?? 3.5);
const checkinMs = () => Number(process.env.CRASH_CHECKIN_MS ?? 30_000);

type Escalate = (tripId: string, description: string) => Promise<unknown>;
type Ask = (tripId: string, text: string) => Promise<unknown>;

export class Devices {
  private checkins = new Map<string, NodeJS.Timeout>();
  constructor(private store: Store, private hooks?: { escalate: Escalate; ask: Ask }) {}

  bind(hooks: { escalate: Escalate; ask: Ask }) {
    this.hooks = hooks;
  }

  recordLocation(tripId: string | undefined, r: Omit<LocationReading, "at">) {
    if (!(Math.abs(r.lat) <= 90 && Math.abs(r.lng) <= 180)) throw new Error("invalid coordinates");
    const reading: LocationReading = { ...r, at: nowIso() };
    this.store.put("device_readings", `LOC-${tripId ?? "default"}`, reading, { tripId, key: "LOCATION" });
    this.store.put("device_readings", "LOC-default", reading, { key: "LOCATION" });
    if (tripId) {
      const t = this.store.get<any>("trips", tripId);
      if (t) this.store.put("trips", tripId, { ...t, currentLocation: { name: t.currentLocation?.name ?? "Live location", lat: r.lat, lng: r.lng }, updatedAt: nowIso() }, { tripId });
    }
    bus.emitEvent({ tripId: tripId ?? "*", agent: "device", type: "LOCATION", detail: `GPS ${r.lat.toFixed(5)},${r.lng.toFixed(5)} ±${Math.round(r.accuracy ?? 0)}m`, data: reading });
    return reading;
  }

  latest(tripId?: string): LocationReading | undefined {
    return this.store.get<LocationReading>("device_readings", `LOC-${tripId ?? "default"}`) ?? this.store.get<LocationReading>("device_readings", "LOC-default");
  }

  setRoute(tripId: string | undefined, r: Directions & { from: { lat: number; lng: number; name?: string }; to: { lat: number; lng: number; name?: string } }) {
    this.store.put("device_readings", `ROUTE-${tripId ?? "default"}`, { ...r, at: nowIso() }, { tripId, key: "ROUTE" });
    bus.emitEvent({ tripId: tripId ?? "*", agent: "device", type: "ROUTE", detail: `Route to ${r.to.name ?? "destination"}: ${(r.distanceM / 1000).toFixed(1)} km, ${Math.round(r.durationS / 60)} min` });
  }

  route(tripId?: string) {
    return this.store.get<any>("device_readings", `ROUTE-${tripId ?? "default"}`);
  }

  /** Phone reported a hard impact. Returns whether a check-in started. */
  async impact(tripId: string, r: Omit<ImpactReading, "at">) {
    const reading = { ...r, at: nowIso() };
    this.store.put("device_readings", id("IMP"), reading, { tripId, key: "IMPACT" });
    if (r.peakG < IMPACT_G || this.checkins.has(tripId)) return { checkin: false, reason: r.peakG < IMPACT_G ? "below threshold" : "check-in already running" };
    bus.emitEvent({ tripId, agent: "device", type: "IMPACT", detail: `Hard impact ${r.peakG.toFixed(1)}g${r.stillSeconds ? `, still for ${r.stillSeconds}s` : ""} — asking if traveller is OK` });
    await this.hooks?.ask(tripId, `I felt a hard jolt on your phone. Are you OK? Tap "I'm OK" within ${Math.round(checkinMs() / 1000)} seconds or I'll treat this as a safety emergency.`);
    this.checkins.set(
      tripId,
      setTimeout(async () => {
        this.checkins.delete(tripId);
        bus.emitEvent({ tripId, agent: "device", type: "IMPACT", detail: "No response to check-in — escalating as SAFETY" });
        await this.hooks?.escalate(tripId, `Possible accident: phone sensors detected a ${r.peakG.toFixed(1)}g impact and the traveller did not respond`).catch(() => {});
      }, checkinMs()),
    );
    return { checkin: true, seconds: Math.round(checkinMs() / 1000) };
  }

  imOk(tripId: string) {
    const t = this.checkins.get(tripId);
    if (!t) return false;
    clearTimeout(t);
    this.checkins.delete(tripId);
    bus.emitEvent({ tripId, agent: "device", type: "IMPACT", detail: "Traveller confirmed they are OK — check-in cancelled" });
    return true;
  }

  checkinActive(tripId: string) {
    return this.checkins.has(tripId);
  }

  stopAll() {
    this.checkins.forEach((t) => clearTimeout(t));
    this.checkins.clear();
  }
}

// Travel / routing specialist — route info, location context, alternative
// discovery, offline route cache (spec §4.6). Delhivery rail.
import type { Route, Traveller, TripState } from "../../../packages/domain";
import type { Store } from "../../../packages/db";
import { nowIso } from "../../../packages/shared";
import { bus } from "../../../packages/events";
import type { AgentMcp } from "../../mcp/client";

export class TravelAgent {
  constructor(private store: Store, private mcp: AgentMcp) {}

  async alternatives(tripId: string, incidentId: string, from: string, to: string, online: boolean): Promise<Route[]> {
    const r = await this.mcp.call("route_search", { tripId, incidentId, from, to, offline: !online });
    if (!r.success) throw new Error(`route_search failed: ${r.error?.message}`);
    return r.data as Route[];
  }

  /** ROM layer (spec §20): pre-fetch before departure so recovery works without signal. */
  async prefetch(tripId: string) {
    const trip = this.store.get<TripState>("trips", tripId)!;
    const traveller = this.store.get<Traveller>("users", trip.travellerId)!;
    const routes: Route[] = [];
    for (const leg of trip.itinerary.legs) {
      const r = await this.mcp.call("route_search", { tripId, from: leg.from, to: leg.to, offline: false });
      if (r.success) routes.push(...(r.data as Route[]));
    }
    this.store.put("offline_cache", `ROUTES-${tripId}`, { routes, fetchedAt: nowIso() }, { tripId, key: "ROUTES" });
    this.store.put("offline_cache", `ITIN-${tripId}`, { itinerary: trip.itinerary, fetchedAt: nowIso() }, { tripId, key: "ITINERARY" });
    this.store.put(
      "offline_cache",
      `EMERGENCY-${tripId}`,
      { emergencyNumber: "112", contact: traveller.emergencyContact ?? null, fetchedAt: nowIso() },
      { tripId, key: "EMERGENCY" },
    );
    bus.emitEvent({ tripId, agent: "travel", type: "PREFETCHED", detail: `Offline cache: ${routes.length} routes, itinerary, emergency info` });
    return { routes: routes.length };
  }
}

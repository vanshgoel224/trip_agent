// L4 authority flag. Held by the orchestrator only (spec §2): while active,
// the recovery agent may execute bounded autonomous spends through MCP.
import type { Store } from "../../packages/db";

export type TripRuntime = {
  tripId: string;
  l4Active: boolean;
  l4IncidentId?: string;
  online: boolean;
  batteryPct?: number;
};

export function getRuntime(store: Store, tripId: string): TripRuntime {
  return store.get<TripRuntime>("trip_states", tripId) ?? { tripId, l4Active: false, online: true };
}

export function setRuntime(store: Store, tripId: string, patch: Partial<TripRuntime>) {
  const next = { ...getRuntime(store, tripId), ...patch };
  store.put("trip_states", tripId, next, { tripId });
  return next;
}

export function activateL4(store: Store, tripId: string, incidentId: string) {
  return setRuntime(store, tripId, { l4Active: true, l4IncidentId: incidentId });
}

export function deactivateL4(store: Store, tripId: string) {
  return setRuntime(store, tripId, { l4Active: false, l4IncidentId: undefined });
}

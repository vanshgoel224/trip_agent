// Explicit trip state (spec §15) — never inferred from LLM conversation memory.
import type { RecoveryStep, TripState, TripStatus } from "../../packages/domain";
import type { Store } from "../../packages/db";
import { nowIso } from "../../packages/shared";
import { bus } from "../../packages/events";

const TRIP: Record<TripStatus, TripStatus[]> = {
  PLANNING: ["BOOKED"],
  BOOKED: ["TRAVELLING", "SETTLED"],
  TRAVELLING: ["DISRUPTED", "HOME_SAFE"],
  DISRUPTED: ["RECOVERY_ACTIVE", "AWAITING_TRAVELLER", "TRAVELLING"],
  RECOVERY_ACTIVE: ["TRAVELLING", "AWAITING_TRAVELLER", "DISRUPTED"],
  AWAITING_TRAVELLER: ["RECOVERY_ACTIVE", "TRAVELLING", "DISRUPTED", "HOME_SAFE"],
  HOME_SAFE: ["SETTLED"],
  SETTLED: [],
};

// Spec §14 recovery state machine, as persisted checkpoints.
export const RECOVERY: Record<RecoveryStep, RecoveryStep[]> = {
  DISRUPTION_DETECTED: ["CLASSIFIED"],
  CLASSIFIED: ["OPTIONS_GENERATED", "ESCALATED_SAFETY", "AWAITING_TRAVELLER"],
  OPTIONS_GENERATED: ["OBLIGATION_CHECKED", "AWAITING_TRAVELLER"],
  OBLIGATION_CHECKED: ["AUTHORITY_CHECKED", "AWAITING_TRAVELLER"],
  AUTHORITY_CHECKED: ["EXECUTING", "AWAITING_TRAVELLER"],
  EXECUTING: ["UNDO_WINDOW_OPEN", "AWAITING_TRAVELLER"],
  UNDO_WINDOW_OPEN: ["VERIFIED", "UNDONE", "AWAITING_TRAVELLER"],
  VERIFIED: ["READBACK_SENT"],
  READBACK_SENT: ["CLOSED"],
  AWAITING_TRAVELLER: ["EXECUTING", "CLOSED", "OPTIONS_GENERATED"],
  ESCALATED_SAFETY: ["CLOSED", "AWAITING_TRAVELLER"],
  UNDONE: ["CLOSED", "AWAITING_TRAVELLER"],
  CLOSED: [],
};

export function canTransitionTrip(from: TripStatus, to: TripStatus) {
  return from === to || TRIP[from].includes(to);
}

export function transitionTrip(store: Store, tripId: string, to: TripStatus): TripState {
  const t = store.get<TripState>("trips", tripId);
  if (!t) throw new Error(`unknown trip ${tripId}`);
  if (!canTransitionTrip(t.status, to)) throw new Error(`illegal trip transition ${t.status} → ${to}`);
  const next = { ...t, status: to, updatedAt: nowIso() };
  store.put("trips", tripId, next, { tripId });
  if (t.status !== to) bus.emitEvent({ tripId, agent: "orchestrator", type: "TRIP_STATUS", detail: `${t.status} → ${to}` });
  return next;
}

export function assertRecoveryTransition(from: RecoveryStep, to: RecoveryStep) {
  if (from !== to && !RECOVERY[from].includes(to)) throw new Error(`illegal recovery transition ${from} → ${to}`);
}

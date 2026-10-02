// Deterministic planner: intent + explicit state → plan. The model only
// proposes the intent; it never chooses money-moving steps.
import type { Incident, TripState } from "../../packages/domain";
import type { Intent } from "../models";

export type PlanStep =
  | { do: "START_RECOVERY" }
  | { do: "UNDO"; incidentId: string }
  | { do: "APPROVE"; incidentId: string }
  | { do: "DECLINE"; incidentId: string }
  | { do: "MARK_VERIFIED_WAY_HOME"; incidentId?: string }
  | { do: "STATUS" }
  | { do: "REPLY"; text: string };

export function plan(intent: Intent, trip: TripState, incident?: Incident): PlanStep[] {
  const open = incident && incident.step !== "CLOSED" ? incident : undefined;
  switch (intent) {
    case "REPORT_DISRUPTION":
      if (open && open.step !== "AWAITING_TRAVELLER" && open.step !== "UNDONE")
        return [{ do: "REPLY", text: "I'm already handling the current disruption." }];
      return [{ do: "START_RECOVERY" }];
    case "UNDO":
      return open?.step === "UNDO_WINDOW_OPEN" ? [{ do: "UNDO", incidentId: open.incidentId }] : [{ do: "REPLY", text: "There's nothing to undo right now." }];
    case "APPROVE":
      return open?.pendingApproval ? [{ do: "APPROVE", incidentId: open.incidentId }] : [{ do: "REPLY", text: "There's nothing waiting for your approval." }];
    case "DECLINE":
      return open?.pendingApproval ? [{ do: "DECLINE", incidentId: open.incidentId }] : [{ do: "REPLY", text: "Okay." }];
    case "VERIFIED_WAY_HOME":
      return [{ do: "MARK_VERIFIED_WAY_HOME", incidentId: open?.incidentId }];
    case "STATUS":
      return [{ do: "STATUS" }];
    default:
      return [{ do: "REPLY", text: `I'm watching your trip ${trip.itinerary.origin} → ${trip.itinerary.destination}. Tell me if anything goes wrong.` }];
  }
}

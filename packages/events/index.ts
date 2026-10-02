import { EventEmitter } from "node:events";
import { nowIso } from "../shared";
import { currentActor } from "../shared/context";

// In-process event bus. Drives the UI activity panel via SSE.
// Shows actions and statuses only — never model chain-of-thought (spec §27).
export type BiruniEvent = {
  at: string;
  tripId: string;
  incidentId?: string;
  agent: string;
  type: string;
  detail: string;
  data?: unknown;
  /** Whose space produced it (multi-user): live streams only deliver a user's own events. */
  userId?: string;
};

class Bus extends EventEmitter {
  emitEvent(e: Omit<BiruniEvent, "at">) {
    const ev = { at: nowIso(), userId: currentActor()?.userId, ...e };
    this.emit("event", ev);
    return ev;
  }
}

export const bus = new Bus();
bus.setMaxListeners(1000);

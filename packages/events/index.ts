import { EventEmitter } from "node:events";
import { nowIso } from "../shared";

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
};

class Bus extends EventEmitter {
  emitEvent(e: Omit<BiruniEvent, "at">) {
    const ev = { at: nowIso(), ...e };
    this.emit("event", ev);
    return ev;
  }
}

export const bus = new Bus();
bus.setMaxListeners(100);

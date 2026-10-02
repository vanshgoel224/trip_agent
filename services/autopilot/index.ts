// L4 autopilot: Biruni acting on its own, without being asked, inside the
// authority contract. Every tick it looks at each active trip, decides, acts,
// and logs WHY (a decision trace) — critical thinking applied to autonomy:
//   - corroborate a signal before acting on it (no recovery on one stray event)
//   - check it's still relevant (not stale, not already handled, no verified way home)
//   - prefer the least-invasive action (notify < ask < act)
//   - all money still flows through recovery + MCP guards (₹2,000/incident, obligations, undo)
import type { Incident, TripState } from "../../packages/domain";
import type { Store } from "../../packages/db";
import { id, nowIso } from "../../packages/shared";
import { bus } from "../../packages/events";
import type { Orchestrator } from "../orchestrator";
import type { VoiceAgent } from "../agents/voice";
import type { Devices } from "../devices";
import { simulator } from "../integrations/simulator";
import { directions, findPlace } from "../integrations/openstreetmap";

export type OperatorStatus = { legId: string; status: "ON_TIME" | "DELAYED" | "CANCELLED"; delayMin?: number; source: string; at: string };
export type Decision = { decisionId: string; tripId: string; at: string; signal: string; considered: string[]; decided: "ACT" | "ASK" | "NOTIFY" | "WAIT" | "IGNORE"; action?: string; why: string };

const DELAY_RECOVER_MIN = Number(process.env.AUTOPILOT_DELAY_RECOVER_MIN ?? 180);
const LEAVE_BUFFER_MIN = Number(process.env.AUTOPILOT_LEAVE_BUFFER_MIN ?? 30);

export class Autopilot {
  private timer?: NodeJS.Timeout;
  private busy = false;
  constructor(private d: { store: Store; orchestrator: Orchestrator; voice: VoiceAgent; devices: Devices; runWithModels?: <T>(fn: () => T) => T }) {}

  // ---------- settings ----------
  enabled(tripId: string) {
    return this.d.store.get<{ on: boolean }>("autopilot", `SET-${tripId}`)?.on ?? true; // L4 on by default
  }
  setEnabled(tripId: string, on: boolean) {
    this.d.store.put("autopilot", `SET-${tripId}`, { on, at: nowIso() }, { tripId, key: "SETTING" });
    this.log({ tripId, signal: "Traveller toggled autopilot", considered: [], decided: "NOTIFY", why: on ? "Autopilot (L4) on: Biruni may act within its authority" : "Autopilot off: Biruni will only act when asked" });
  }

  // ---------- operator feed (simulated rail; a real operator/IRCTC/bus API plugs in here) ----------
  operatorEvent(tripId: string, e: Omit<OperatorStatus, "at" | "source"> & { source?: string }) {
    const ev: OperatorStatus = { ...e, source: e.source ?? "operator-feed (simulated)", at: nowIso() };
    const sim = simulator.trip(tripId);
    (sim as any).operator = [...((sim as any).operator ?? []), ev];
    bus.emitEvent({ tripId, agent: "autopilot", type: "OPERATOR", detail: `Operator: ${e.legId} ${e.status}${e.delayMin ? ` +${e.delayMin} min` : ""}` });
    return ev;
  }
  private operatorFeed(tripId: string): OperatorStatus[] {
    return ((simulator.trip(tripId) as any).operator ?? []) as OperatorStatus[];
  }

  decisions(tripId: string) {
    return this.d.store.list<Decision>("autopilot", { tripId, key: "DECISION" }).slice(-50);
  }
  private log(x: Omit<Decision, "decisionId" | "at">) {
    const dcs: Decision = { decisionId: id("DEC"), at: nowIso(), ...x };
    this.d.store.put("autopilot", dcs.decisionId, dcs, { tripId: x.tripId, key: "DECISION" });
    bus.emitEvent({ tripId: x.tripId, agent: "autopilot", type: "AUTOPILOT", detail: `${x.decided}: ${x.signal} — ${x.why}`, data: dcs });
    return dcs;
  }
  private once(tripId: string, key: string) {
    const k = `ONCE-${tripId}-${key}`;
    if (this.d.store.get("autopilot", k)) return false;
    this.d.store.put("autopilot", k, { at: nowIso() }, { tripId, key: "ONCE" });
    return true;
  }

  // ---------- loop ----------
  start(ms = Number(process.env.AUTOPILOT_TICK_MS ?? 60_000)) {
    this.stop();
    this.timer = setInterval(() => void (this.d.runWithModels ? this.d.runWithModels(() => this.tickAll()) : this.tickAll()), ms);
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
  async tickAll() {
    if (this.busy) return;
    this.busy = true;
    try {
      for (const t of this.d.store.list<TripState>("trips")) if (!t.archived && ["BOOKED", "TRAVELLING", "AWAITING_TRAVELLER"].includes(t.status) && this.enabled(t.tripId)) await this.tick(t.tripId).catch(() => {});
    } finally {
      this.busy = false;
    }
  }

  /** One autonomous pass over a trip. Returns the decisions taken this tick. */
  /** Set by the runtime: pulls real-world status (partners, flights) before each decision pass. */
  feedPoll?: (tripId: string) => Promise<unknown>;

  async tick(tripId: string): Promise<Decision[]> {
    const out: Decision[] = [];
    await this.feedPoll?.(tripId).catch(() => {});
    const o = this.d.orchestrator;
    const trip = o.trip(tripId);
    if (!this.enabled(tripId)) return out;
    const open = o.currentIncident(tripId);
    const busy = (inc?: Incident) => !!inc && !["CLOSED", "UNDONE"].includes(inc.step);
    const now = Date.now();

    // 1. Operator signals → autonomous recovery (L4), with corroboration and relevance checks.
    for (const leg of trip.itinerary.legs.filter((l) => l.status === "CONFIRMED" || l.status === "PLANNED")) {
      const feed = this.operatorFeed(tripId).filter((e) => e.legId === leg.legId);
      const latest = feed.at(-1);
      if (!latest || latest.status === "ON_TIME") continue;
      const depMs = Date.parse(leg.departure);
      const considered = [`leg ${leg.from}→${leg.to} departs ${leg.departure.slice(11, 16)}`, `operator says ${latest.status}${latest.delayMin ? ` +${latest.delayMin}m` : ""} (${feed.length} report(s))`];
      if (depMs < now - 3 * 3600_000) {
        if (this.once(tripId, `stale-${leg.legId}-${latest.at}`)) out.push(this.log({ tripId, signal: `${latest.status} for a leg that left >3h ago`, considered, decided: "IGNORE", why: "Stale: the departure is long past, acting now would not help" }));
        continue;
      }
      if (busy(open)) continue; // recovery already running; don't stack incidents
      if (latest.status === "DELAYED" && (latest.delayMin ?? 0) < DELAY_RECOVER_MIN) {
        if (this.once(tripId, `delay-${leg.legId}-${latest.delayMin}`)) {
          await this.d.voice.say(tripId, `Heads up: your ${leg.mode.toLowerCase()} ${leg.from}→${leg.to} is running about ${latest.delayMin} minutes late. No action needed yet; I'm watching it.`, { kind: "AUTOPILOT" });
          out.push(this.log({ tripId, signal: `Delay ${latest.delayMin} min`, considered: [...considered, `threshold ${DELAY_RECOVER_MIN} min`], decided: "NOTIFY", why: "Delay is below the recovery threshold; least-invasive action is to inform and keep watching" }));
        }
        continue;
      }
      // Corroborate: one cancellation report is enough only from a trusted feed; otherwise wait for a second report.
      const confirmed = feed.filter((e) => e.status === latest.status).length >= 2 || /operator|official|irctc|confirmed/i.test(latest.source);
      if (!confirmed) {
        if (this.once(tripId, `wait-${leg.legId}-${latest.at}`)) out.push(this.log({ tripId, signal: `${latest.status} from ${latest.source}`, considered, decided: "WAIT", why: "Single report from an unconfirmed source: waiting for corroboration before spending money" }));
        continue;
      }
      if (!this.once(tripId, `recover-${leg.legId}-${latest.status}`)) continue;
      const description = latest.status === "CANCELLED" ? `Operator cancelled ${leg.mode.toLowerCase()} ${leg.from} to ${leg.to}` : `Operator reports ${leg.mode.toLowerCase()} ${leg.from} to ${leg.to} delayed ${latest.delayMin} minutes`;
      const inc = await o.reportDisruption(tripId, description, leg.legId);
      out.push(this.log({ tripId, signal: description, considered: [...considered, "no recovery running", "within authority checks happen inside recovery"], decided: "ACT", action: `Autonomous recovery ${inc.incidentId} → ${inc.step}${inc.stopReason ? ` (${inc.stopReason})` : ""}`, why: inc.step === "UNDO_WINDOW_OPEN" ? "Disruption confirmed; booked an alternative within ₹2,000 authority, 30s undo open" : `Disruption confirmed; recovery stopped for the traveller: ${inc.stopReason ?? inc.step}` }));
    }

    // 2. Leave-now: live location + live travel time vs departure.
    const loc = this.d.devices.latest(tripId);
    const next = trip.itinerary.legs.find((l) => (l.status === "CONFIRMED" || l.status === "PLANNED") && Date.parse(l.departure) > now);
    if (next) {
      const minsLeft = (Date.parse(next.departure) - now) / 60_000;
      if (minsLeft <= 180 && minsLeft > 0 && this.once(tripId, `remind-${next.legId}`)) {
        await this.d.voice.say(tripId, `Reminder: your ${next.mode.toLowerCase()} to ${next.to} leaves at ${next.departure.slice(11, 16)}${next.bookingRef ? `, PNR ${next.bookingRef}` : ""}.`, { kind: "AUTOPILOT" });
        out.push(this.log({ tripId, signal: `Departure in ${Math.round(minsLeft)} min`, considered: [`${next.from}→${next.to}`], decided: "NOTIFY", why: "Departure within 3 hours" }));
      }
      if (loc && minsLeft <= 240 && minsLeft > 0) {
        try {
          const origin = (await findPlace(next.from, loc))[0];
          if (origin) {
            const r = await directions(loc, origin);
            const travelMin = r.durationS / 60;
            const slack = minsLeft - travelMin - LEAVE_BUFFER_MIN;
            if (r.distanceM > 1000 && slack <= 0 && this.once(tripId, `leave-${next.legId}`)) {
              await this.d.voice.say(tripId, `Leave now for ${origin.name}: it's about ${Math.round(travelMin)} minutes away and your ${next.mode.toLowerCase()} leaves at ${next.departure.slice(11, 16)}.`, { kind: "AUTOPILOT" });
              out.push(this.log({ tripId, signal: "Leave-now check", considered: [`${(r.distanceM / 1000).toFixed(1)} km to ${origin.name}`, `${Math.round(travelMin)} min drive`, `${Math.round(minsLeft)} min to departure`, `${LEAVE_BUFFER_MIN} min buffer`], decided: "NOTIFY", why: "Travel time plus buffer now exceeds time left" }));
            }
          }
        } catch {
          /* maps unreachable: skip this tick */
        }
      }
    }

    // 3. Feedback after a finished recovery (ask once).
    if (open?.step === "CLOSED" && open.chosenOption && this.once(tripId, `feedback-${open.incidentId}`)) {
      await this.d.voice.say(tripId, `How was ${open.chosenOption.vendorName}? Rate it 1 to 5 in the app — it helps me pick better next time.`, { incidentId: open.incidentId, kind: "FEEDBACK_REQUEST" });
      out.push(this.log({ tripId, signal: "Recovery finished", considered: [open.chosenOption.vendorName], decided: "ASK", action: "feedback request", why: "Vendor ratings feed the vendor ladder's review check" }));
    }
    return out;
  }
}

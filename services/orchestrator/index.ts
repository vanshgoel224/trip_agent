// Orchestrator (spec §4.1): the ONLY conversational authority and holder of
// the L4 flag. It never moves money or writes the ledger itself — it routes
// work to specialists, which go through MCP.
//   message → intent → state → plan → agent selection → tool call → result → state update → next action
import type { Incident, Itinerary, Location, Traveller, TripState } from "../../packages/domain";
import type { Store } from "../../packages/db";
import { BiruniError, config, id, nowIso } from "../../packages/shared";
import { bus } from "../../packages/events";
import type { FinanceAgent } from "../agents/finance";
import type { RecoveryAgent } from "../agents/recovery";
import type { UndoManager } from "../agents/recovery/undo";
import type { TravelAgent } from "../agents/travel";
import type { VoiceAgent } from "../agents/voice";
import type { ModelRouter } from "../models";
import { activateL4, deactivateL4, getRuntime, setRuntime } from "./authority";
import { SessionMemory } from "./memory";
import { plan } from "./planner";
import { AgentRouter } from "./router";
import { transitionTrip } from "./state-machine";

export type CreateTripInput = {
  traveller: Omit<Traveller, "travellerId"> & { travellerId?: string };
  itinerary: Omit<Itinerary, "version">;
  currentLocation?: Location;
};

export type OrchestratorDeps = {
  finance: FinanceAgent;
  recovery: RecoveryAgent;
  travel: TravelAgent;
  voice: VoiceAgent;
  undo: UndoManager;
  models: ModelRouter;
};

export class Orchestrator {
  readonly router: AgentRouter;
  readonly memory = new SessionMemory();

  constructor(private store: Store, private d: OrchestratorDeps) {
    this.router = new AgentRouter(store);
  }

  // ---------- trips ----------

  createTrip(input: CreateTripInput): TripState {
    if (!input?.traveller || typeof input.traveller !== "object") throw new BiruniError("INVALID_REQUEST", "trip needs a traveller");
    if (typeof input.traveller.age !== "number" || !Number.isFinite(input.traveller.age)) throw new BiruniError("INVALID_REQUEST", "traveller.age must be a number");
    if (input.traveller.age < config.minAge) throw new BiruniError("POLICY_BLOCKED", "Biruni is not available to users under 18");
    if (!Array.isArray(input.itinerary?.legs) || !input.itinerary.legs.length) throw new BiruniError("INVALID_REQUEST", "trip needs at least one itinerary leg");
    const traveller: Traveller = { ...input.traveller, travellerId: input.traveller.travellerId ?? id("USR") };
    this.store.put("users", traveller.travellerId, traveller);
    if (traveller.aaConsentId) this.store.put("consents", traveller.aaConsentId, { consentId: traveller.aaConsentId, travellerId: traveller.travellerId, scope: ["SETU_AA_DEBITS_6M", "ZERODHA_HOLDINGS_READ"], grantedAt: nowIso() });
    const trip: TripState = {
      tripId: id("TRIP"),
      travellerId: traveller.travellerId,
      status: "BOOKED",
      itinerary: { ...input.itinerary, version: 1 },
      currentLocation: input.currentLocation,
      lastActions: [],
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    this.store.put("trips", trip.tripId, trip, { tripId: trip.tripId });
    this.store.put("itineraries", `${trip.tripId}-v1`, trip.itinerary, { tripId: trip.tripId });
    setRuntime(this.store, trip.tripId, { online: true, l4Active: false });
    bus.emitEvent({ tripId: trip.tripId, agent: "orchestrator", type: "TRIP_CREATED", detail: `${trip.itinerary.origin} → ${trip.itinerary.destination}` });
    return trip;
  }

  async prepareTrip(tripId: string) {
    await this.router.run("finance", { tripId, input: "refresh obligations" }, () => this.d.finance.refreshObligations(tripId));
    await this.router.run("travel", { tripId, input: "prefetch offline cache" }, () => this.d.travel.prefetch(tripId));
    return transitionTrip(this.store, tripId, "TRAVELLING");
  }

  /** Rename or archive a trip. */
  updateTrip(tripId: string, patch: { title?: string; archived?: boolean }) {
    const t = this.trip(tripId);
    const next: TripState = { ...t, updatedAt: nowIso() };
    if (patch.title !== undefined) next.title = String(patch.title).trim().slice(0, 80) || undefined;
    if (patch.archived !== undefined) next.archived = !!patch.archived;
    this.store.put("trips", tripId, next, { tripId });
    bus.emitEvent({ tripId, agent: "orchestrator", type: "TRIP_STATUS", detail: next.archived ? "Trip archived" : "Trip updated" });
    return next;
  }

  /** Delete a trip and its chats/plans/devices data. Refused while money or an undo window is in flight. */
  deleteTrip(tripId: string) {
    this.trip(tripId);
    const inc = this.currentIncident(tripId);
    if (inc && !["CLOSED", "UNDONE"].includes(inc.step)) throw new BiruniError("POLICY_BLOCKED", "A recovery is still running on this trip: finish or undo it first");
    return { deleted: this.store.deleteTrip(tripId), kept: "finance ledger and audit log (append-only)" };
  }

  trip(tripId: string) {
    const t = this.store.get<TripState>("trips", tripId);
    if (!t) throw new BiruniError("INVALID_REQUEST", `unknown trip ${tripId}`);
    return t;
  }

  currentIncident(tripId: string): Incident | undefined {
    const t = this.trip(tripId);
    return t.incidentId ? this.store.get<Incident>("incidents", t.incidentId) : undefined;
  }

  // ---------- conversation ----------

  async handleMessage(tripId: string, text: string) {
    const trip = this.trip(tripId);
    this.memory.push(tripId, { role: "traveller", text, at: nowIso() });
    const rt = getRuntime(this.store, tripId);
    const proposal = await this.d.models.propose(text, rt.online);
    const steps = plan(proposal.intent, trip, this.currentIncident(tripId));
    bus.emitEvent({ tripId, agent: "orchestrator", type: "INTENT", detail: `Intent ${proposal.intent} (${proposal.source}) → ${steps.map((s) => s.do).join(", ")}` });
    const replies: string[] = [];
    for (const s of steps) {
      switch (s.do) {
        case "START_RECOVERY":
          replies.push("I'm handling this.");
          await this.reportDisruption(tripId, text);
          break;
        case "UNDO":
          replies.push((await this.undo(s.incidentId)) ? "Undoing it now." : "The undo window has closed.");
          break;
        case "APPROVE":
          await this.approve(s.incidentId);
          replies.push("Approved.");
          break;
        case "DECLINE":
          await this.decline(s.incidentId);
          replies.push("Okay, I won't do that. You're in control.");
          break;
        case "MARK_VERIFIED_WAY_HOME":
          await this.markVerifiedWayHome(tripId);
          replies.push("Got it — you have a verified way home, so I'll stand down.");
          break;
        case "STATUS":
          replies.push(this.statusLine(tripId));
          break;
        case "REPLY":
          replies.push(s.text);
      }
    }
    const reply = replies.join(" ");
    this.memory.push(tripId, { role: "biruni", text: reply, at: nowIso() });
    return { intent: proposal.intent, source: proposal.source, reply, state: this.snapshot(tripId) };
  }

  // ---------- recovery control ----------

  async reportDisruption(tripId: string, description: string, affectedLegId?: string): Promise<Incident> {
    const trip = this.trip(tripId);
    const leg = affectedLegId
      ? trip.itinerary.legs.find((l) => l.legId === affectedLegId)
      : trip.itinerary.legs.find((l) => l.status === "CONFIRMED" || l.status === "PLANNED");
    const inc: Incident = {
      incidentId: id("INC"),
      tripId,
      description,
      affectedLegId: leg?.legId,
      step: "DISRUPTION_DETECTED",
      options: [],
      hasVerifiedWayHome: false,
      timeline: [{ at: nowIso(), step: "DISRUPTION_DETECTED", detail: description }],
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    this.store.put("incidents", inc.incidentId, inc, { tripId, incidentId: inc.incidentId });
    transitionTrip(this.store, tripId, "DISRUPTED");
    this.store.put("trips", tripId, { ...this.trip(tripId), incidentId: inc.incidentId }, { tripId });
    bus.emitEvent({ tripId, incidentId: inc.incidentId, agent: "orchestrator", type: "DISRUPTION", detail: description });

    this.d.finance.openIncident(inc.incidentId, tripId);
    activateL4(this.store, tripId, inc.incidentId);
    transitionTrip(this.store, tripId, "RECOVERY_ACTIVE");
    bus.emitEvent({ tripId, incidentId: inc.incidentId, agent: "orchestrator", type: "L4", detail: "L4 recovery authority activated" });
    return this.runRecovery(inc.incidentId);
  }

  async runRecovery(incidentId: string): Promise<Incident> {
    const inc = this.store.get<Incident>("incidents", incidentId)!;
    try {
      return await this.router.run("recovery", { tripId: inc.tripId, incidentId, input: { step: inc.step } }, () => this.d.recovery.run(incidentId), (r) => r.step !== "CLOSED");
    } catch (e) {
      // Restarts exhausted: hand control back rather than guess.
      deactivateL4(this.store, inc.tripId);
      if (this.trip(inc.tripId).status !== "AWAITING_TRAVELLER") transitionTrip(this.store, inc.tripId, "AWAITING_TRAVELLER");
      await this.d.voice.say(inc.tripId, "I ran into a problem and stopped automatic recovery. Nothing further will be charged. Over to you.", { incidentId, kind: "HANDOFF" });
      return this.store.get<Incident>("incidents", incidentId)!;
    }
  }

  async undo(incidentId: string) {
    const inc = this.store.get<Incident>("incidents", incidentId);
    if (!inc?.undoActionId) return false;
    return this.d.undo.cancel(inc.undoActionId);
  }

  async approve(incidentId: string) {
    const inc = this.store.get<Incident>("incidents", incidentId);
    const p = inc?.pendingApproval;
    if (!inc || !p) throw new BiruniError("INVALID_REQUEST", "nothing pending approval");
    const approvalId = id("APR");
    this.store.put("consents", approvalId, { approvalId, incidentId, kind: p.kind, reason: p.reason, approvedAt: nowIso() }, { tripId: inc.tripId, incidentId });
    if (p.kind === "ALERT_CONTACT") {
      await this.d.recovery.alertContact(inc, approvalId);
      this.store.put("incidents", incidentId, { ...inc, pendingApproval: undefined }, { tripId: inc.tripId, incidentId });
      return this.store.get<Incident>("incidents", incidentId)!;
    }
    transitionTrip(this.store, inc.tripId, "RECOVERY_ACTIVE");
    return this.router.run("recovery", { tripId: inc.tripId, incidentId, input: { approvalId } }, () => this.d.recovery.executeApproved(incidentId, approvalId), (r) => r.step !== "CLOSED");
  }

  async decline(incidentId: string) {
    const inc = this.store.get<Incident>("incidents", incidentId);
    if (!inc) throw new BiruniError("INVALID_REQUEST", "unknown incident");
    this.d.recovery.close(inc, "Traveller declined; control stays with traveller");
  }

  async markVerifiedWayHome(tripId: string) {
    const inc = this.currentIncident(tripId);
    if (inc && inc.step !== "CLOSED") {
      const next = { ...inc, hasVerifiedWayHome: true };
      this.store.put("incidents", inc.incidentId, next, { tripId, incidentId: inc.incidentId });
      // Mid-flight steps pick the flag up at their next checkpoint; idle ones close now.
      if (["AWAITING_TRAVELLER", "ESCALATED_SAFETY", "UNDONE"].includes(inc.step)) this.d.recovery.close(next, "Stop: traveller has a verified way home");
    }
    const t = this.trip(tripId);
    if (t.status !== "TRAVELLING") transitionTrip(this.store, tripId, "TRAVELLING");
  }

  // ---------- device signals ----------

  setConnectivity(tripId: string, online: boolean) {
    const rt = setRuntime(this.store, tripId, { online });
    bus.emitEvent({ tripId, agent: "orchestrator", type: "CONNECTIVITY", detail: online ? "Online: Nemotron + live rails" : "Offline: on-device model + cached data, logged cash only" });
    return rt;
  }

  /** Spec §22 critical battery: send location + itinerary + emergency info per policy. */
  async battery(tripId: string, pct: number) {
    setRuntime(this.store, tripId, { batteryPct: pct });
    if (pct > config.criticalBatteryPct) return { action: "NONE" };
    const trip = this.trip(tripId);
    const traveller = this.store.get<Traveller>("users", trip.travellerId)!;
    if (!traveller.emergencyContact) return { action: "NO_CONTACT" };
    const legs = trip.itinerary.legs.filter((l) => l.status === "CONFIRMED" || l.status === "PLANNED").map((l) => `${l.from}→${l.to} ${l.departure.slice(0, 16)}`).join("; ");
    const text = `Biruni: ${traveller.name}'s phone is at ${pct}% battery. Last location: ${trip.currentLocation?.name ?? "unknown"}. Itinerary: ${legs}. Emergency number: 112.`;
    if (traveller.emergencyAutoAlertOptIn) {
      await this.d.voice.say(tripId, text, { to: "EMERGENCY_CONTACT", kind: "BATTERY_ALERT" });
      return { action: "ALERTED" };
    }
    await this.d.voice.say(tripId, `Your battery is at ${pct}%. Should I send your location and itinerary to ${traveller.emergencyContact.name}?`, { kind: "APPROVAL_REQUEST" });
    return { action: "ASKED" };
  }

  // ---------- views ----------

  statusLine(tripId: string) {
    const t = this.trip(tripId);
    const inc = this.currentIncident(tripId);
    return `Trip ${t.itinerary.origin} → ${t.itinerary.destination}: ${t.status}${inc ? `, incident ${inc.step}` : ""}.`;
  }

  snapshot(tripId: string) {
    const trip = this.trip(tripId);
    const incident = this.currentIncident(tripId);
    const traveller = this.store.get<Traveller>("users", trip.travellerId);
    let ledger;
    try {
      ledger = incident ? this.d.finance.ledger(incident.incidentId) : undefined;
    } catch {
      ledger = undefined;
    }
    const undoMs = incident?.undoActionId ? this.d.undo.remainingMs(incident.undoActionId) : 0;
    return {
      trip,
      traveller: traveller && { name: traveller.name, dailyCeiling: traveller.dailyCeiling, preferredLanguage: traveller.preferredLanguage },
      runtime: getRuntime(this.store, tripId),
      incident,
      ledger,
      obligations: this.d.finance.obligationMap(trip.travellerId),
      undoRemainingMs: undoMs,
      voice: this.d.voice.transcript(tripId).slice(-12),
      models: this.d.models.describe(),
    };
  }
}

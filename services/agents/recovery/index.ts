// Recovery agent (spec §4.3, §14). Stateless: every step is checkpointed on
// the incident, so a restarted agent resumes where the last one stopped.
import type { BookingRecord, Incident, PaymentRecord, RecoveryStep, Route, StopReason, Traveller, TripState, UndoAction } from "../../../packages/domain";
import type { Store } from "../../../packages/db";
import { VENDOR_LADDER, checkNecessary, checkSafety, classifyDisruption, stopReasonFor } from "../../../packages/policy";
import { inr, nowIso } from "../../../packages/shared";
import { bus } from "../../../packages/events";
import type { AgentMcp } from "../../mcp/client";
import type { FinanceAgent } from "../finance";
import type { TravelAgent } from "../travel";
import type { BookingAgent } from "../booking";
import type { VoiceAgent } from "../voice";
import type { ModelRouter } from "../../models";
import { deactivateL4, getRuntime } from "../../orchestrator/authority";
import { assertRecoveryTransition, transitionTrip } from "../../orchestrator/state-machine";
import { UndoManager } from "./undo";

export type RecoveryDeps = {
  finance: FinanceAgent;
  travel: TravelAgent;
  booking: BookingAgent;
  voice: VoiceAgent;
  models: ModelRouter;
  undo: UndoManager;
};

const pad = (n: number) => String(n + 1).padStart(3, "0");

export class RecoveryAgent {
  /** Fault injection for the restart demo: crash once right after the payment succeeds. */
  faults: { crashAfterPayment?: boolean } = {};

  constructor(private store: Store, private mcp: AgentMcp, private d: RecoveryDeps) {}

  // ---------- persistence helpers ----------

  private load(incidentId: string) {
    const inc = this.store.get<Incident>("incidents", incidentId);
    if (!inc) throw new Error(`unknown incident ${incidentId}`);
    return inc;
  }
  private save(inc: Incident, step: RecoveryStep, detail: string, patch: Partial<Incident> = {}): Incident {
    assertRecoveryTransition(inc.step, step);
    const next: Incident = { ...inc, ...patch, step, updatedAt: nowIso(), timeline: [...inc.timeline, { at: nowIso(), step, detail }] };
    this.store.put("incidents", inc.incidentId, next, { tripId: inc.tripId, incidentId: inc.incidentId });
    bus.emitEvent({ tripId: inc.tripId, incidentId: inc.incidentId, agent: "recovery", type: "STEP", detail: `${step}: ${detail}`, data: { step } });
    return next;
  }
  private trip(tripId: string) {
    return this.store.get<TripState>("trips", tripId)!;
  }

  // ---------- main loop (resumable) ----------

  async run(incidentId: string): Promise<Incident> {
    let inc = this.load(incidentId);
    for (;;) {
      switch (inc.step) {
        case "DISRUPTION_DETECTED": {
          const online = getRuntime(this.store, inc.tripId).online;
          const proposal = await this.d.models.propose(inc.description, online);
          const cls = classifyDisruption(inc.description, proposal.disruptionClass);
          inc = this.save(inc, "CLASSIFIED", `Classified ${cls} (rules${proposal.source !== "RULES" ? " + " + proposal.source.toLowerCase() : ""})`, { classification: cls });
          break;
        }
        case "CLASSIFIED": {
          const safety = checkSafety(inc.classification);
          if (!safety.pass) return this.escalateSafety(inc);
          if (inc.hasVerifiedWayHome) return this.stop(inc, "VERIFIED_WAY_HOME", "You already have a verified way home, so I'm not booking anything.");
          const trip = this.trip(inc.tripId);
          const leg = trip.itinerary.legs.find((l) => l.legId === inc.affectedLegId);
          const from = leg?.from ?? trip.itinerary.origin;
          const online = getRuntime(this.store, inc.tripId).online;
          const raw = await this.d.travel.alternatives(inc.tripId, inc.incidentId, from, leg?.to ?? trip.itinerary.destination, online);
          const options = [...raw].sort((a, b) => VENDOR_LADDER.indexOf(a.vendorRung) - VENDOR_LADDER.indexOf(b.vendorRung) || a.price - b.price);
          if (!options.length) return this.stop(inc, "ALL_PATHS_FAILED", "I couldn't find any alternative route. Over to you — tell me what you'd like to do.");
          inc = this.save(inc, "OPTIONS_GENERATED", `${options.length} options (${online ? "live" : "offline cache"}): ${options.map((o) => `${o.vendorName} ${inr(o.price)}`).join(", ")}`, { options });
          break;
        }
        case "OPTIONS_GENERATED": {
          const trip = this.trip(inc.tripId);
          if (!this.d.finance.obligationMap(trip.travellerId) && getRuntime(this.store, inc.tripId).online) await this.d.finance.refreshObligations(inc.tripId);
          const dest = trip.itinerary.legs.find((l) => l.legId === inc.affectedLegId)?.to ?? trip.itinerary.destination;
          const needed = inc.options.map((o, i) => ({ o, i })).filter(({ o }) => checkNecessary(inc, o, dest).pass);
          const safe = needed.filter(({ o }) => this.d.finance.checkObligation(inc.tripId, o.price).pass);
          if (!safe.length) {
            const best = needed[0] ?? { o: inc.options[0], i: 0 };
            const why = this.d.finance.checkObligation(inc.tripId, best.o.price).reason;
            return this.stop(inc, "OBLIGATION_AT_RISK", `The best option is ${best.o.vendorName} at ${inr(best.o.price)}, but paying it would touch money already committed to your obligations (${why}). Should I book it anyway?`, best);
          }
          inc = this.save(inc, "OBLIGATION_CHECKED", `Obligation check passed for ${safe.length} option(s)`, { eligible: safe.map((s) => s.i) });
          break;
        }
        case "OBLIGATION_CHECKED": {
          const ok = (inc.eligible ?? []).filter((i) => this.d.finance.checkAuthority(inc.incidentId, inc.options[i].price).pass);
          if (!ok.length) {
            const i = inc.eligible![0];
            const o = inc.options[i];
            const l = this.d.finance.ledger(inc.incidentId);
            return this.stop(inc, "AUTHORITY_EXHAUSTED", `The best option is ${o.vendorName} at ${inr(o.price)}. That's above what I can spend on my own (${inr(l.remainingIncident)} left for this incident, ${inr(l.remainingDaily)} left today). Do you approve?`, { o, i });
          }
          const l = this.d.finance.ledger(inc.incidentId);
          inc = this.save(inc, "AUTHORITY_CHECKED", `Within ₹${l.incidentLimit} incident authority (remaining ${inr(l.remainingIncident)})`, { eligible: ok });
          break;
        }
        case "AUTHORITY_CHECKED":
        case "EXECUTING": {
          inc = inc.step === "EXECUTING" ? inc : this.save(inc, "EXECUTING", "Running vendor ladder");
          return this.executeLadder(inc, inc.eligible ?? []);
        }
        default:
          return inc; // waiting on undo window, traveller, or already closed
      }
    }
  }

  // ---------- vendor ladder + execution ----------

  private async executeLadder(inc: Incident, candidates: number[], approval?: { approvalId: string; overrideObligation?: boolean }): Promise<Incident> {
    const trip = this.trip(inc.tripId);
    for (const i of candidates) {
      const route = inc.options[i];
      if (route.vendorRung === "LOCAL_TRANSPORT") {
        const ref = trip.itinerary.legs.find((l) => l.legId === inc.affectedLegId)?.cost ?? route.price;
        const v = await this.mcp.call("vendor_verify", { tripId: inc.tripId, incidentId: inc.incidentId, vendorId: route.vendorId, quotedPrice: route.price, referenceFare: ref });
        if (!v.success || !(v.data as { pass: boolean }).pass) {
          bus.emitEvent({ tripId: inc.tripId, incidentId: inc.incidentId, agent: "recovery", type: "LADDER", detail: `Skipped ${route.vendorName}: ${(v.data as any)?.reason ?? v.error?.message}` });
          continue;
        }
      }
      const payKey = `${inc.incidentId}-PAY-${pad(i)}`;
      const pay = await this.mcp.call(
        "payment_execute",
        { tripId: inc.tripId, incidentId: inc.incidentId, operation: "charge", amount: route.price, vendorId: route.vendorId, rung: route.vendorRung, idempotencyKey: payKey },
        approval ? { approval } : undefined,
      );
      if (!pay.success) {
        const stop = stopReasonFor(pay.error?.code);
        if (stop) return this.stop(inc, stop, `I couldn't pay ${route.vendorName}: ${pay.error?.message}.`, { o: route, i });
        bus.emitEvent({ tripId: inc.tripId, incidentId: inc.incidentId, agent: "recovery", type: "LADDER", detail: `${route.vendorRung} failed (${pay.error?.code}), next rung` });
        continue;
      }
      const payment = pay.data as PaymentRecord;
      if (this.faults.crashAfterPayment) {
        this.faults.crashAfterPayment = false;
        throw new Error("simulated recovery-agent crash after payment, before checkpoint");
      }
      const bk = await this.d.booking.book(inc.tripId, inc.incidentId, route, payment.paymentId, `${inc.incidentId}-BOOK-${pad(i)}`);
      if (!bk.success) {
        await this.refund(inc, payment);
        continue;
      }
      const booking = bk.data as BookingRecord;
      const prevVersion = trip.itinerary.version;
      const itin = this.d.booking.applyReplacement(inc.tripId, inc.affectedLegId, route, booking);
      const undo = this.d.undo.open(inc.tripId, inc.incidentId, route.price, payment.paymentId, booking.bookingId);
      const l = this.d.finance.ledger(inc.incidentId);
      inc = this.save(inc, "UNDO_WINDOW_OPEN", `Booked ${route.vendorName} ${inr(route.price)}, PNR ${booking.pnr}`, {
        chosenOption: route,
        paymentId: payment.paymentId,
        bookingId: booking.bookingId,
        undoActionId: undo.undoId,
        newItineraryVersion: itin.version,
        pendingApproval: undefined,
      });
      bus.emitEvent({ tripId: inc.tripId, incidentId: inc.incidentId, agent: "booking", type: "ITINERARY_VERSION", detail: `v${prevVersion} → v${itin.version}` });
      const obligationNote = approval ? "You approved this." : "This is within your recovery authority and does not touch a protected obligation.";
      await this.d.voice.say(
        inc.tripId,
        `Your ${inc.description.toLowerCase().includes("bus") ? "bus" : "trip"} was disrupted. I found an alternative: ${route.vendorName}${route.mode === "OTHER" ? "" : " " + route.mode.toLowerCase()} at ${route.departure.slice(11, 16)}, for ${inr(route.price)}. ${obligationNote} I have booked it. ${approval ? "" : `Remaining authority: ${inr(l.remainingIncident)}. `}Say "undo" in the next ${Math.round(this.d.undo.remainingMs(undo.undoId) / 1000)} seconds to reverse it.`,
        { incidentId: inc.incidentId, kind: "ACTION_READBACK" },
      );
      this.recordAction(inc.tripId, { kind: "PAYMENT", summary: `Paid ${route.vendorName}`, amount: route.price });
      return inc;
    }
    return this.stop(inc, "ALL_PATHS_FAILED", "Every recovery option failed. Over to you — tell me how you'd like to proceed.");
  }

  /** Traveller approved a spend that was outside autonomous bounds. */
  async executeApproved(incidentId: string, approvalId: string): Promise<Incident> {
    let inc = this.load(incidentId);
    const p = inc.pendingApproval;
    if (!p || p.kind !== "SPEND" || p.optionIndex === undefined) throw new Error("nothing to approve");
    inc = this.save(inc, "EXECUTING", `Traveller approved ${p.route?.vendorName} (${p.reason})`);
    return this.executeLadder(inc, [p.optionIndex], { approvalId, overrideObligation: p.reason === "OBLIGATION_AT_RISK" });
  }

  // ---------- undo window outcomes ----------

  async onUndoExpired(u: UndoAction) {
    let inc = this.load(u.incidentId);
    if (inc.step !== "UNDO_WINDOW_OPEN") return;
    const checks = await this.verify(inc);
    const allOk = Object.values(checks).every(Boolean);
    if (!allOk) return this.stop(inc, "ALL_PATHS_FAILED", `I couldn't verify the new booking (${Object.entries(checks).filter(([, v]) => !v).map(([k]) => k).join(", ")}). Please check with the operator.`);
    inc = this.save(inc, "VERIFIED", `Verified payment, booking, vendor, itinerary`);
    const route = inc.chosenOption!;
    const booking = this.store.get<BookingRecord>("bookings", inc.bookingId!)!;
    const text = `You're back on track. ${route.vendorName}, ${route.from} to ${route.to}, departs ${route.departure.slice(11, 16)}. PNR ${booking.pnr}. Paid ${inr(route.price)}.`;
    await this.d.voice.say(inc.tripId, text, { incidentId: inc.incidentId, kind: "FINAL_READBACK" });
    inc = this.save(inc, "READBACK_SENT", "Voice readback sent", { readback: text });
    this.close(inc, "Recovered");
    transitionTrip(this.store, inc.tripId, "TRAVELLING");
  }

  async onUndoCancelled(u: UndoAction) {
    let inc = this.load(u.incidentId);
    if (inc.bookingId) await this.d.booking.cancel(inc.tripId, inc.incidentId, inc.bookingId);
    const payment = inc.paymentId ? this.store.get<PaymentRecord>("payments", inc.paymentId) : undefined;
    if (payment) await this.refund(inc, payment);
    const v = inc.newItineraryVersion;
    if (v) this.d.booking.revertItinerary(inc.tripId, v - 1);
    inc = this.save(inc, "UNDONE", `Undone: booking cancelled, ${inr(u.amount)} refunded, itinerary restored`);
    await this.d.voice.say(inc.tripId, `Done — I cancelled that booking and refunded ${inr(u.amount)}. What would you like to do instead?`, { incidentId: inc.incidentId, kind: "UNDO_READBACK" });
    inc = this.save(inc, "AWAITING_TRAVELLER", "Control returned to traveller after undo", { stopReason: undefined });
    deactivateL4(this.store, inc.tripId);
    transitionTrip(this.store, inc.tripId, "AWAITING_TRAVELLER");
  }

  private async refund(inc: Incident, payment: PaymentRecord) {
    const r = await this.mcp.call("payment_execute", { tripId: inc.tripId, incidentId: inc.incidentId, operation: "refund", paymentId: payment.paymentId, idempotencyKey: `${payment.idempotencyKey}-REFUND` });
    if (r.success) this.d.finance.restore(payment.idempotencyKey);
    return r;
  }

  private async verify(inc: Incident) {
    const pay = await this.mcp.call("payment_execute", { tripId: inc.tripId, incidentId: inc.incidentId, operation: "status", paymentId: inc.paymentId! });
    const payOk = pay.success && (pay.data as any).local === "SUCCESS" && (pay.data as any).rail?.status === "SUCCESS";
    const bookingOk = await this.d.booking.verify(inc.tripId, inc.incidentId, inc.bookingId!);
    const r = inc.chosenOption!;
    const vendorOk = r.vendorRung !== "LOCAL_TRANSPORT" || this.store.list<any>("tool_calls", { incidentId: inc.incidentId }).some((c) => c.tool === "vendor_verify" && c.args.vendorId === r.vendorId && c.result?.data?.pass);
    const trip = this.trip(inc.tripId);
    const itineraryOk = trip.itinerary.version === inc.newItineraryVersion && trip.itinerary.legs.some((l) => l.status === "CONFIRMED" && l.bookingRef && l.legId === `LEG-${inc.bookingId}`);
    return { payment: payOk, booking: bookingOk, vendor: vendorOk, itinerary: itineraryOk };
  }

  // ---------- stop conditions (spec §10) ----------

  private async stop(inc: Incident, reason: StopReason, message: string, option?: { o: Route; i: number }): Promise<Incident> {
    const spendable = reason === "AUTHORITY_EXHAUSTED" || reason === "OBLIGATION_AT_RISK";
    inc = this.save(inc, "AWAITING_TRAVELLER", `Stop: ${reason}`, {
      stopReason: reason,
      pendingApproval: spendable && option ? { kind: "SPEND", route: option.o, optionIndex: option.i, reason, message } : undefined,
    });
    deactivateL4(this.store, inc.tripId);
    transitionTrip(this.store, inc.tripId, "AWAITING_TRAVELLER");
    await this.d.voice.say(inc.tripId, message, { incidentId: inc.incidentId, kind: spendable ? "APPROVAL_REQUEST" : "HANDOFF" });
    return inc;
  }

  private async escalateSafety(inc: Incident): Promise<Incident> {
    const trip = this.trip(inc.tripId);
    const traveller = this.store.get<Traveller>("users", trip.travellerId)!;
    inc = this.save(inc, "ESCALATED_SAFETY", "Safety involved: autonomous execution stopped", { stopReason: "SAFETY_INVOLVED" });
    deactivateL4(this.store, inc.tripId);
    transitionTrip(this.store, inc.tripId, "AWAITING_TRAVELLER");
    await this.d.voice.say(inc.tripId, "This sounds like a safety issue. I've stopped all automatic actions. If you are in danger, call 112 now.", { incidentId: inc.incidentId, kind: "SAFETY" });
    if (traveller.emergencyContact && traveller.emergencyAutoAlertOptIn) {
      await this.alertContact(inc);
    } else if (traveller.emergencyContact) {
      inc = this.save(inc, "AWAITING_TRAVELLER", "Asking before alerting emergency contact", {
        pendingApproval: { kind: "ALERT_CONTACT", reason: "SAFETY_INVOLVED", message: `Should I alert ${traveller.emergencyContact.name}?` },
      });
      await this.d.voice.say(inc.tripId, `Should I alert ${traveller.emergencyContact.name}? Say yes or no.`, { incidentId: inc.incidentId, kind: "APPROVAL_REQUEST" });
    }
    return this.load(inc.incidentId);
  }

  async alertContact(inc: Incident, approvalId?: string) {
    const trip = this.trip(inc.tripId);
    const next = trip.itinerary.legs.filter((l) => l.status === "CONFIRMED" || l.status === "PLANNED").map((l) => `${l.from}→${l.to} ${l.departure.slice(0, 16)}`).join("; ");
    const text = `Biruni safety alert for your contact. Last known location: ${trip.currentLocation?.name ?? "unknown"}. Itinerary: ${next || "none"}. Reported: "${inc.description}". Emergency number: 112.`;
    return this.d.voice.say(inc.tripId, text, { incidentId: inc.incidentId, kind: "EMERGENCY_ALERT", to: "EMERGENCY_CONTACT", approvalId });
  }

  close(inc: Incident, detail: string) {
    deactivateL4(this.store, inc.tripId);
    return this.save(inc, "CLOSED", detail, { pendingApproval: undefined });
  }

  private recordAction(tripId: string, a: { kind: "PAYMENT" | "BOOKING"; summary: string; amount?: number }) {
    const t = this.trip(tripId);
    const lastActions = [...t.lastActions, { actionId: `ACT-${t.lastActions.length + 1}`, at: nowIso(), ...a }].slice(-20);
    this.store.put("trips", tripId, { ...t, lastActions }, { tripId });
  }
}

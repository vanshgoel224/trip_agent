// 30-second undo window (spec §11). Persisted in undo_actions so a restart
// rehydrates open windows. On the phone this timer is owned by the offline
// model runtime; here it is a deterministic server timer with the same contract.
import type { UndoAction } from "../../../packages/domain";
import type { Store } from "../../../packages/db";
import { config, id, nowIso } from "../../../packages/shared";
import { bus } from "../../../packages/events";

type Handlers = { onExpire(u: UndoAction): Promise<void>; onCancel(u: UndoAction): Promise<void> };

export class UndoManager {
  private timers = new Map<string, NodeJS.Timeout>();
  private handlers?: Handlers;

  constructor(private store: Store, private windowMs = config.undoWindowMs) {}

  bind(h: Handlers) {
    this.handlers = h;
  }

  open(tripId: string, incidentId: string, amount: number, paymentId?: string, bookingId?: string): UndoAction {
    const now = Date.now();
    const u: UndoAction = { undoId: id("UNDO"), tripId, incidentId, paymentId, bookingId, amount, openedAt: new Date(now).toISOString(), expiresAt: new Date(now + this.windowMs).toISOString(), status: "OPEN" };
    this.store.put("undo_actions", u.undoId, u, { tripId, incidentId });
    this.schedule(u);
    bus.emitEvent({ tripId, incidentId, agent: "recovery", type: "UNDO_OPEN", detail: `Undo available for ${Math.round(this.windowMs / 1000)}s`, data: u });
    return u;
  }

  private schedule(u: UndoAction) {
    const ms = Math.max(0, new Date(u.expiresAt).getTime() - Date.now());
    const t = setTimeout(() => void this.expire(u.undoId), ms);
    this.timers.set(u.undoId, t);
  }

  private async expire(undoId: string) {
    this.timers.delete(undoId);
    const u = this.store.get<UndoAction>("undo_actions", undoId);
    if (!u || u.status !== "OPEN") return;
    const next = { ...u, status: "EXPIRED" as const };
    this.store.put("undo_actions", undoId, next, { tripId: u.tripId, incidentId: u.incidentId });
    bus.emitEvent({ tripId: u.tripId, incidentId: u.incidentId, agent: "recovery", type: "UNDO_EXPIRED", detail: "Undo window closed — verifying outcome" });
    try {
      await this.handlers?.onExpire(next);
    } catch (e) {
      bus.emitEvent({ tripId: u.tripId, incidentId: u.incidentId, agent: "recovery", type: "AGENT_FAILED", detail: `post-undo verification failed: ${e instanceof Error ? e.message : e}` });
    }
  }

  /** Returns false when the window has already closed. */
  async cancel(undoId: string): Promise<boolean> {
    const u = this.store.get<UndoAction>("undo_actions", undoId);
    if (!u || u.status !== "OPEN" || Date.now() > new Date(u.expiresAt).getTime()) return false;
    clearTimeout(this.timers.get(undoId));
    this.timers.delete(undoId);
    const next = { ...u, status: "CANCELLED" as const };
    this.store.put("undo_actions", undoId, next, { tripId: u.tripId, incidentId: u.incidentId });
    bus.emitEvent({ tripId: u.tripId, incidentId: u.incidentId, agent: "recovery", type: "UNDO_CANCELLED", detail: "Traveller pressed undo — compensating" });
    await this.handlers?.onCancel(next);
    this.store.put("undo_actions", undoId, { ...next, status: "COMPENSATED", compensatedAt: nowIso() }, { tripId: u.tripId, incidentId: u.incidentId });
    return true;
  }

  /** After a restart: resume every open window (expired ones fire immediately). */
  rehydrate() {
    const open = this.store.list<UndoAction>("undo_actions").filter((u) => u.status === "OPEN" && !this.timers.has(u.undoId));
    open.forEach((u) => this.schedule(u));
    return open.length;
  }

  remainingMs(undoId: string) {
    const u = this.store.get<UndoAction>("undo_actions", undoId);
    return u && u.status === "OPEN" ? Math.max(0, new Date(u.expiresAt).getTime() - Date.now()) : 0;
  }

  stopAll() {
    this.timers.forEach((t) => clearTimeout(t));
    this.timers.clear();
  }
}

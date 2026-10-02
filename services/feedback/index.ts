// Feedback: 👍/👎 on replies, 1–5 ratings for vendors/recoveries/trips, free-text
// comments, and anything the traveller tells a chat ("the bus was awful").
// Vendor ratings flow back into the vendor directory, so the vendor ladder's
// review check (min 3.5★) reflects real traveller experience.
import type { Store } from "../../packages/db";
import { id, nowIso } from "../../packages/shared";
import { bus } from "../../packages/events";
import { simulator } from "../integrations/simulator";

export type FeedbackKind = "message" | "recovery" | "vendor" | "trip" | "feature" | "general";
export type FeedbackEntry = {
  feedbackId: string;
  kind: FeedbackKind;
  rating?: number; // message: -1/1; others: 1–5
  comment?: string;
  tripId?: string;
  chatId?: string;
  messageId?: string;
  incidentId?: string;
  vendorId?: string;
  about?: string;
  source: "ui" | "chat" | "voice";
  at: string;
};

export class Feedback {
  constructor(private store: Store) {}

  record(f: Omit<FeedbackEntry, "feedbackId" | "at">): FeedbackEntry {
    if (f.rating !== undefined) {
      const ok = f.kind === "message" ? f.rating === 1 || f.rating === -1 : Number.isInteger(f.rating) && f.rating >= 1 && f.rating <= 5;
      if (!ok) throw new Error(f.kind === "message" ? "message rating must be 1 or -1" : "rating must be a whole number 1–5");
    }
    if (f.rating === undefined && !f.comment?.trim()) throw new Error("give a rating or a comment");
    const e: FeedbackEntry = { feedbackId: id("FB"), at: nowIso(), ...f, comment: f.comment?.trim().slice(0, 1000) };
    this.store.put("feedback", e.feedbackId, e, { tripId: f.tripId, incidentId: f.incidentId, key: f.kind });
    if (e.kind === "vendor" && e.vendorId && e.rating) this.applyVendorRating(e.vendorId, e.rating);
    bus.emitEvent({ tripId: f.tripId ?? "*", agent: "feedback", type: "FEEDBACK", detail: `${e.kind}${e.rating !== undefined ? ` ${e.rating > 0 && e.kind === "message" ? "👍" : e.kind === "message" ? "👎" : e.rating + "★"}` : ""}${e.comment ? `: ${e.comment.slice(0, 80)}` : ""}` });
    return e;
  }

  /** Running average into the vendor directory used by vendor_verify. */
  private applyVendorRating(vendorId: string, rating: number) {
    const v = simulator.vendors.get(vendorId);
    if (!v) return;
    const n = v.reviewCount + 1;
    simulator.vendors.set(vendorId, { ...v, rating: Math.round(((v.rating * v.reviewCount + rating) / n) * 100) / 100, reviewCount: n });
  }

  list(filter: { kind?: FeedbackKind; tripId?: string } = {}) {
    return this.store.list<FeedbackEntry>("feedback", { ...(filter.kind ? { key: filter.kind } : {}), ...(filter.tripId ? { tripId: filter.tripId } : {}) }).reverse();
  }

  summary() {
    const all = this.list();
    const by = (k: FeedbackKind) => all.filter((f) => f.kind === k && f.rating !== undefined);
    const avg = (xs: FeedbackEntry[]) => (xs.length ? Math.round((xs.reduce((s, f) => s + f.rating!, 0) / xs.length) * 100) / 100 : null);
    const msgs = by("message");
    return {
      total: all.length,
      messages: { up: msgs.filter((f) => f.rating === 1).length, down: msgs.filter((f) => f.rating === -1).length },
      avgVendor: avg(by("vendor")),
      avgRecovery: avg(by("recovery")),
      avgTrip: avg(by("trip")),
      recentComments: all.filter((f) => f.comment).slice(0, 10).map((f) => ({ kind: f.kind, rating: f.rating, comment: f.comment, at: f.at })),
    };
  }

  csv() {
    const cols = ["at", "kind", "rating", "about", "vendorId", "tripId", "chatId", "messageId", "incidentId", "source", "comment"] as const;
    const q = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    return [cols.join(","), ...this.list().map((f) => cols.map((c) => q((f as any)[c])).join(","))].join("\n");
  }
}

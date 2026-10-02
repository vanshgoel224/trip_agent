// Finance agent — SINGLE WRITER of the obligation map and the ₹2,000
// per-incident authority ledger (spec §4.2, §17). Everyone else asks.
import type { AuthorityLedger, ObligationMap, TripState, Traveller } from "../../../packages/domain";
import type { FinanceCapability, Store } from "../../../packages/db";
import { buildObligationMap, checkAuthority, checkObligationSafe, inferObligations, type CheckResult } from "../../../packages/policy";
import { config, id, nowIso, todayKey } from "../../../packages/shared";
import { bus } from "../../../packages/events";
import type { AgentMcp } from "../../mcp/client";

type Hold = {
  reference: string; // idempotency key of the spend
  incidentId: string;
  tripId: string;
  travellerId: string;
  day: string;
  amount: number;
  travellerApproved: boolean; // traveller-approved spend does not consume autonomous authority
  state: "RESERVED" | "COMMITTED" | "RELEASED" | "RESTORED";
  committedAt?: string;
};

export class FinanceAgent {
  private cap: FinanceCapability;
  private mcp?: AgentMcp;

  constructor(private store: Store) {
    this.cap = store.issueFinanceCapability();
  }

  attach(mcp: AgentMcp) {
    this.mcp = mcp;
  }

  private trip(tripId: string) {
    const t = this.store.get<TripState>("trips", tripId);
    if (!t) throw new Error(`unknown trip ${tripId}`);
    return t;
  }
  private traveller(travellerId: string) {
    const u = this.store.get<Traveller>("users", travellerId);
    if (!u) throw new Error(`unknown traveller ${travellerId}`);
    return u;
  }

  // ---------- Obligation map ----------

  async refreshObligations(tripId: string): Promise<ObligationMap> {
    if (!this.mcp) throw new Error("finance agent has no MCP client");
    const trip = this.trip(tripId);
    const res = await this.mcp.call("financial_context", { tripId, months: 6 });
    if (!res.success) throw new Error(`financial_context failed: ${res.error?.message}`);
    const { balance, debits } = res.data as { balance: number; debits: { date: string; narration: string; amount: number }[] };
    // Zerodha is context only: recorded for the traveller's picture, never counted as spendable.
    const holdings = await this.mcp.call("holdings_context", { tripId });
    const map = buildObligationMap(balance, inferObligations(debits));
    this.store.put("obligations", `MAP-${trip.travellerId}`, { ...map, holdingsContext: holdings.data ?? [] }, { tripId, key: trip.travellerId }, this.cap);
    bus.emitEvent({ tripId, agent: "finance", type: "OBLIGATIONS_REFRESHED", detail: `${map.obligations.length} obligations, free balance ₹${map.freeBalance}`, data: map });
    return this.obligationMap(trip.travellerId)!;
  }

  /** Obligation map with spends committed since the last refresh deducted. */
  obligationMap(travellerId: string, excludeRef?: string): ObligationMap | undefined {
    const map = this.store.get<ObligationMap>("obligations", `MAP-${travellerId}`);
    if (!map) return undefined;
    const spentSince = this.holds()
      .filter((h) => h.reference !== excludeRef && h.travellerId === travellerId && h.state === "COMMITTED" && (h.committedAt ?? "") >= map.refreshedAt)
      .reduce((s, h) => s + h.amount, 0);
    const balance = map.accountBalance - spentSince;
    return { ...map, accountBalance: balance, freeBalance: Math.max(0, balance - map.committedTotal) };
  }

  /** excludeRef: a retry of the same action must not be blocked by its own earlier spend. */
  checkObligation(tripId: string, amount: number, excludeRef?: string): CheckResult {
    const map = this.obligationMap(this.trip(tripId).travellerId, excludeRef);
    if (!map) return { pass: false, code: "OBLIGATION_BLOCKED", reason: "No obligation map: cannot prove money is uncommitted" };
    return checkObligationSafe(map, amount);
  }

  // ---------- Authority ledger ----------

  openIncident(incidentId: string, tripId: string) {
    const trip = this.trip(tripId);
    if (this.store.get("authority_ledgers", `INC-${incidentId}`)) return;
    this.store.put(
      "authority_ledgers",
      `INC-${incidentId}`,
      { incidentId, tripId, travellerId: trip.travellerId, incidentLimit: config.incidentAuthority, openedOn: todayKey() },
      { tripId, incidentId },
      this.cap,
    );
  }

  private holds(): Hold[] {
    return this.store.list<Hold>("transactions").filter((h) => "state" in h);
  }

  ledger(incidentId: string, excludeRef?: string): AuthorityLedger {
    const inc = this.store.get<{ incidentLimit: number; travellerId: string }>("authority_ledgers", `INC-${incidentId}`);
    if (!inc) throw new Error(`no authority ledger for ${incidentId}`);
    const traveller = this.traveller(inc.travellerId);
    const live = (h: Hold) => h.reference !== excludeRef && !h.travellerApproved && (h.state === "RESERVED" || h.state === "COMMITTED");
    const all = this.holds();
    const incidentSpent = all.filter((h) => h.incidentId === incidentId && live(h)).reduce((s, h) => s + h.amount, 0);
    const dailySpent = all.filter((h) => h.travellerId === inc.travellerId && h.day === todayKey() && live(h)).reduce((s, h) => s + h.amount, 0);
    return {
      incidentId,
      incidentLimit: inc.incidentLimit,
      incidentSpent,
      dailyLimit: traveller.dailyCeiling,
      dailySpent,
      remainingIncident: Math.max(0, inc.incidentLimit - incidentSpent),
      remainingDaily: Math.max(0, traveller.dailyCeiling - dailySpent),
    };
  }

  checkAuthority(incidentId: string, amount: number, excludeRef?: string): CheckResult {
    return checkAuthority(this.ledger(incidentId, excludeRef), amount);
  }

  private txn(h: Hold, kind: "RESERVE" | "COMMIT" | "RELEASE" | "RESTORE") {
    const txnId = id("TXN");
    this.store.put("transactions", txnId, { txnId, incidentId: h.incidentId, tripId: h.tripId, kind, amount: h.amount, reference: h.reference, at: nowIso() }, { tripId: h.tripId, incidentId: h.incidentId, key: `${h.reference}:${kind}` }, this.cap);
  }

  /** Idempotent per reference: reserving the same key twice returns the existing hold. */
  reserve(incidentId: string, amount: number, reference: string, travellerApproved = false): Hold {
    const existing = this.store.get<Hold>("transactions", `HOLD-${reference}`);
    if (existing && existing.state !== "RELEASED") return existing;
    const inc = this.store.get<{ tripId: string; travellerId: string }>("authority_ledgers", `INC-${incidentId}`);
    if (!inc) throw new Error(`no authority ledger for ${incidentId}`);
    const hold: Hold = { reference, incidentId, tripId: inc.tripId, travellerId: inc.travellerId, day: todayKey(), amount, travellerApproved, state: "RESERVED" };
    this.store.tx(() => {
      this.store.put("transactions", `HOLD-${reference}`, hold, { tripId: inc.tripId, incidentId, key: reference }, this.cap);
      this.txn(hold, "RESERVE");
    });
    return hold;
  }

  private transition(reference: string, from: Hold["state"][], to: Hold["state"], kind: "COMMIT" | "RELEASE" | "RESTORE") {
    const h = this.store.get<Hold>("transactions", `HOLD-${reference}`);
    if (!h || !from.includes(h.state)) return h;
    const next: Hold = { ...h, state: to, ...(to === "COMMITTED" ? { committedAt: nowIso() } : {}) };
    this.store.tx(() => {
      this.store.put("transactions", `HOLD-${reference}`, next, { tripId: h.tripId, incidentId: h.incidentId, key: reference }, this.cap);
      this.txn(next, kind);
    });
    bus.emitEvent({ tripId: h.tripId, incidentId: h.incidentId, agent: "finance", type: `LEDGER_${kind}`, detail: `${kind.toLowerCase()} ₹${h.amount} (${reference})`, data: this.ledger(h.incidentId) });
    return next;
  }

  commit(reference: string) {
    return this.transition(reference, ["RESERVED"], "COMMITTED", "COMMIT");
  }
  release(reference: string) {
    return this.transition(reference, ["RESERVED"], "RELEASED", "RELEASE");
  }
  /** Refund after undo: authority and balance come back. Implementation decision (spec is silent). */
  restore(reference: string) {
    return this.transition(reference, ["COMMITTED"], "RESTORED", "RESTORE");
  }
}

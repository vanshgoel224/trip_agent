// Group expense splitting (Splitwise-style). Separate from the recovery
// authority ledger: this money was spent by the group and is only being shared
// out. Optional sync to a real Splitwise account when SPLITWISE_API_KEY is set.
import type { Store } from "../../../packages/db";
import { id, inr, nowIso } from "../../../packages/shared";
import { bus } from "../../../packages/events";
import { bestMatch } from "../../../packages/shared/fuzzy";

export type Expense = {
  expenseId: string;
  groupId: string; // trip id, or "default"
  description: string;
  amount: number; // INR
  paidBy: string;
  shares: Record<string, number>; // person -> owed share (sums to amount)
  kind: "EXPENSE" | "SETTLEMENT";
  at: string;
  splitwiseId?: number;
};

const title = (n: string) => n.replace(/\b\p{L}/gu, (c) => c.toUpperCase());
const norm = (n: string) => {
  const t = n.trim().replace(/\s+/g, " ");
  return /^(i|me|myself|mai|main|mein|mujhe|maine|self)$/i.test(t) ? "Me" : title(t.toLowerCase());
};
const round2 = (n: number) => Math.round(n * 100) / 100;

export class ExpenseAgent {
  constructor(private store: Store) {}

  /** Known people in this group. "raahul", "RAHUL", "Rahul " all resolve to the existing "Rahul". */
  private resolve(groupId: string, name: string) {
    const n = norm(name);
    if (n === "Me") return n;
    const people = new Set<string>();
    for (const x of this.list(groupId)) for (const p of [x.paidBy, ...Object.keys(x.shares)]) people.add(p);
    return bestMatch(n, [...people], (p) => p, 0.8)?.item ?? n;
  }

  add(groupId: string, e: { description: string; amount: number; paidBy: string; splitAmong?: string[]; exactShares?: Record<string, number>; confirmDuplicate?: boolean }): Expense {
    if (!(e.amount > 0)) throw new Error("amount must be positive");
    const paidBy = this.resolve(groupId, e.paidBy);
    // Duplicate guard: models re-read chat history and may record the same expense twice.
    const dup = this.list(groupId).find((x) => x.kind === "EXPENSE" && x.paidBy === paidBy && Math.abs(x.amount - e.amount) < 0.01 && Date.now() - new Date(x.at).getTime() < 10 * 60_000);
    if (dup && !e.confirmDuplicate)
      throw new Error(`Already recorded: ${dup.paidBy} paid ${inr(dup.amount)} for "${dup.description}" (${dup.expenseId}). Not adding it again; only if the traveller confirms this is a separate second expense, call add_expense with confirm_duplicate=true.`);
    let shares: Record<string, number>;
    if (e.exactShares && Object.keys(e.exactShares).length) {
      shares = Object.fromEntries(Object.entries(e.exactShares).map(([k, v]) => [this.resolve(groupId, k), round2(v)]));
      const sum = Object.values(shares).reduce((a, b) => a + b, 0);
      if (Math.abs(sum - e.amount) > 1) throw new Error(`exact shares add up to ${inr(sum)}, not ${inr(e.amount)}`);
    } else {
      const people = [...new Set((e.splitAmong?.length ? e.splitAmong : [paidBy]).map((p) => this.resolve(groupId, p)))];
      const each = Math.floor((e.amount * 100) / people.length) / 100;
      shares = Object.fromEntries(people.map((p) => [p, each]));
      shares[people[0]] = round2(e.amount - each * (people.length - 1)); // rounding remainder
    }
    const x: Expense = { expenseId: id("EXP"), groupId, description: e.description, amount: round2(e.amount), paidBy, shares, kind: "EXPENSE", at: nowIso() };
    this.store.put("expenses", x.expenseId, x, { key: groupId });
    bus.emitEvent({ tripId: groupId, agent: "expenses", type: "EXPENSE", detail: `${paidBy} paid ${inr(x.amount)} for ${x.description}, split ${Object.keys(shares).join(", ")}` });
    return x;
  }

  settle(groupId: string, from: string, to: string, amount: number): Expense {
    const f = this.resolve(groupId, from), t = this.resolve(groupId, to);
    const x: Expense = { expenseId: id("SET"), groupId, description: `${f} paid ${t}`, amount: round2(amount), paidBy: f, shares: { [t]: round2(amount) }, kind: "SETTLEMENT", at: nowIso() };
    this.store.put("expenses", x.expenseId, x, { key: groupId });
    return x;
  }

  remove(expenseId: string) {
    const x = this.store.get<Expense>("expenses", expenseId);
    if (!x) return false;
    this.store.delete("expenses", expenseId);
    return true;
  }

  list(groupId: string) {
    return this.store.list<Expense>("expenses", { key: groupId });
  }

  /** Net balance per person: positive = is owed money. */
  balances(groupId: string): Record<string, number> {
    const bal: Record<string, number> = {};
    for (const x of this.list(groupId)) {
      bal[x.paidBy] = round2((bal[x.paidBy] ?? 0) + x.amount);
      for (const [p, s] of Object.entries(x.shares)) bal[p] = round2((bal[p] ?? 0) - s);
    }
    return bal;
  }

  /** Fewest-transfers settle-up plan (greedy largest creditor ↔ largest debtor). */
  settlementPlan(groupId: string): { from: string; to: string; amount: number }[] {
    const bal = Object.entries(this.balances(groupId)).filter(([, v]) => Math.abs(v) >= 0.01);
    const cred = bal.filter(([, v]) => v > 0).map(([p, v]) => ({ p, v })).sort((a, b) => b.v - a.v);
    const debt = bal.filter(([, v]) => v < 0).map(([p, v]) => ({ p, v: -v })).sort((a, b) => b.v - a.v);
    const plan: { from: string; to: string; amount: number }[] = [];
    let i = 0, j = 0;
    while (i < debt.length && j < cred.length) {
      const amt = round2(Math.min(debt[i].v, cred[j].v));
      if (amt >= 0.01) plan.push({ from: debt[i].p, to: cred[j].p, amount: amt });
      debt[i].v = round2(debt[i].v - amt);
      cred[j].v = round2(cred[j].v - amt);
      if (debt[i].v < 0.01) i++;
      if (cred[j].v < 0.01) j++;
    }
    return plan;
  }
}

// ---------- optional real Splitwise sync ----------
// Splitwise API v3.0 with a personal API key from https://secure.splitwise.com/apps
// (Bearer token). Endpoints used: get_current_user, get_groups, create_expense.
// Not exercised with a real key yet; verify against Splitwise's API docs.
export const splitwiseConfigured = () => !!process.env.SPLITWISE_API_KEY;

async function sw(path: string, init?: RequestInit) {
  const res = await fetch(`https://secure.splitwise.com/api/v3.0/${path}`, {
    ...init,
    headers: { authorization: `Bearer ${process.env.SPLITWISE_API_KEY}`, "content-type": "application/json", ...(init?.headers ?? {}) },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Splitwise HTTP ${res.status}: ${(await res.text()).slice(0, 160)}`);
  return res.json() as Promise<any>;
}

export async function splitwiseGroups() {
  const j = await sw("get_groups");
  return (j.groups ?? []).map((g: any) => ({ id: g.id, name: g.name, members: (g.members ?? []).map((m: any) => ({ id: m.id, name: [m.first_name, m.last_name].filter(Boolean).join(" ") })) }));
}

/** Pushes an equal split to a Splitwise group, matching people by first name. */
export async function splitwisePush(x: Expense, groupId: number) {
  const groups = await splitwiseGroups();
  const g = groups.find((gr: any) => gr.id === groupId);
  if (!g) throw new Error(`Splitwise group ${groupId} not found`);
  const me = (await sw("get_current_user")).user;
  const find = (name: string) => (name === "Me" ? me.id : g.members.find((m: any) => m.name.toLowerCase().startsWith(name.toLowerCase()))?.id);
  const body: Record<string, unknown> = { cost: x.amount.toFixed(2), description: x.description, currency_code: "INR", group_id: groupId };
  const people = [...new Set([x.paidBy, ...Object.keys(x.shares)])];
  people.forEach((p, k) => {
    const uid = find(p);
    if (!uid) throw new Error(`${p} is not in Splitwise group "${g.name}"`);
    body[`users__${k}__user_id`] = uid;
    body[`users__${k}__paid_share`] = (p === x.paidBy ? x.amount : 0).toFixed(2);
    body[`users__${k}__owed_share`] = (x.shares[p] ?? 0).toFixed(2);
  });
  const j = await sw("create_expense", { method: "POST", body: JSON.stringify(body) });
  if (j.errors && Object.keys(j.errors).length) throw new Error(`Splitwise: ${JSON.stringify(j.errors).slice(0, 200)}`);
  return j.expenses?.[0]?.id as number | undefined;
}

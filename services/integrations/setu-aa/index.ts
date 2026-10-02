// Setu Account Aggregator — six months of debits, consented data only (spec §7).
import type { Debit } from "../../../packages/domain";
import { BiruniError } from "../../../packages/shared";
import { notImplemented, requireEnv } from "../live-stub";
import { simulator } from "../simulator";

export interface FinancialDataProvider {
  fetch(consentId: string, months: number): Promise<{ balance: number; debits: Debit[] }>;
}

export class MockSetuProvider implements FinancialDataProvider {
  async fetch(consentId: string, months: number) {
    const acct = simulator.accounts.get(consentId);
    if (!acct) throw new BiruniError("AUTH_FAILURE", "no active AA consent for this handle");
    const cutoff = new Date();
    cutoff.setUTCMonth(cutoff.getUTCMonth() - months);
    return { balance: acct.balance, debits: acct.debits.filter((d) => new Date(d.date) >= cutoff) };
  }
}

/**
 * Live Setu AA (FIU) adapter. Contract from docs.setu.co/data/account-aggregator:
 *   base: sandbox https://fiu-sandbox.setu.co, production https://fiu.setu.co
 *   headers: Authorization: Bearer <token>, x-product-instance-id
 *   POST /consents  -> {id, url (traveller approves here), status: PENDING → ACTIVE}
 *   GET  /consents/:id
 *   POST /sessions {consentId, dataRange, format:"json"} -> {id}
 *   GET  /sessions/:id -> {status, fips[].accounts[].data.account.{summary.currentBalance, transactions.transaction[]}}
 * Token acquisition isn't in the pages above: set SETU_ACCESS_TOKEN (from Setu's auth flow).
 */
export class SetuProvider implements FinancialDataProvider {
  private base = (process.env.SETU_API_URL || "https://fiu-sandbox.setu.co").replace(/\/$/, "");
  constructor() {
    requireEnv("SETU_ACCESS_TOKEN", "SETU_PRODUCT_INSTANCE_ID");
  }
  private async call(method: string, path: string, body?: unknown) {
    const res = await fetch(`${this.base}${path}`, {
      method,
      headers: { "content-type": "application/json", authorization: `Bearer ${process.env.SETU_ACCESS_TOKEN}`, "x-product-instance-id": process.env.SETU_PRODUCT_INSTANCE_ID! },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new BiruniError(res.status === 401 ? "AUTH_FAILURE" : "EXTERNAL_FAILURE", `Setu HTTP ${res.status}: ${(await res.text()).slice(0, 160)}`, res.status >= 500);
    return res.json() as Promise<any>;
  }
  /** Starts consent; the traveller approves at the returned url. vua = <mobile>@setu (sandbox). */
  async createConsent(vua: string, months = 6) {
    const to = new Date();
    const from = new Date(to);
    from.setUTCMonth(from.getUTCMonth() - months);
    return this.call("POST", "/consents", {
      consentDuration: { unit: "MONTH", value: "1" },
      vua,
      dataRange: { from: from.toISOString(), to: to.toISOString() },
      context: [],
    }) as Promise<{ id: string; url: string; status: string }>;
  }
  async fetch(consentId: string, months: number) {
    const c = await this.call("GET", `/consents/${consentId}`);
    if (c.status !== "ACTIVE") throw new BiruniError("USER_REQUIRED", `AA consent is ${c.status}; traveller must approve it first`);
    const to = new Date();
    const from = new Date(to);
    from.setUTCMonth(from.getUTCMonth() - months);
    const session = await this.call("POST", "/sessions", { consentId, dataRange: { from: from.toISOString(), to: to.toISOString() }, format: "json" });
    let data: any;
    for (let i = 0; i < 10; i++) {
      data = await this.call("GET", `/sessions/${session.id}`);
      if (["COMPLETED", "PARTIAL"].includes(data.status)) break;
      await new Promise((r) => setTimeout(r, 1500));
    }
    if (!["COMPLETED", "PARTIAL"].includes(data?.status)) throw new BiruniError("TIMEOUT", "AA data not ready yet", true);
    let balance = 0;
    const debits: Debit[] = [];
    for (const fip of data.fips ?? [])
      for (const acc of fip.accounts ?? []) {
        const a = acc.data?.account;
        balance += Number(a?.summary?.currentBalance ?? 0);
        for (const t of a?.transactions?.transaction ?? [])
          if (t.type === "DEBIT") debits.push({ date: String(t.valueDate ?? t.transactionTimestamp).slice(0, 10), narration: String(t.narration ?? ""), amount: Number(t.amount) });
      }
    return { balance: Math.round(balance), debits };
  }
}

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

export class SetuProvider implements FinancialDataProvider {
  constructor() {
    requireEnv("SETU_API_KEY", "SETU_API_URL");
  }
  fetch(): Promise<never> {
    return notImplemented("setu-aa", "fetch");
  }
}

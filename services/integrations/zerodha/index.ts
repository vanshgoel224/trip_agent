// Zerodha — financial context ONLY. Hard rule (spec §7, §22): holdings are
// never sold for recovery. This interface intentionally has no sell/order method.
import { notImplemented, requireEnv } from "../live-stub";
import { simulator } from "../simulator";

export type Holding = { symbol: string; qty: number; lastPrice: number };

export interface HoldingsProvider {
  holdings(consentId: string): Promise<Holding[]>;
}

export class MockZerodhaProvider implements HoldingsProvider {
  async holdings(consentId: string) {
    return simulator.holdings.get(consentId) ?? [];
  }
}

export class ZerodhaProvider implements HoldingsProvider {
  constructor() {
    requireEnv("ZERODHA_API_KEY", "ZERODHA_API_SECRET");
  }
  holdings(): Promise<never> {
    return notImplemented("zerodha", "holdings");
  }
}

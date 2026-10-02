// Zerodha — financial context ONLY. Hard rule (spec §7, §22): holdings are
// never sold for recovery. This interface intentionally has no sell/order method.
import { createHash } from "node:crypto";
import { BiruniError } from "../../../packages/shared";
import { requireEnv } from "../live-stub";
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

/**
 * Live Kite Connect v3 adapter (read-only). Contract from kite.trade/docs/connect/v3:
 *   login:  https://kite.zerodha.com/connect/login?v=3&api_key=...  → redirect with request_token
 *   POST https://api.kite.trade/session/token  api_key, request_token, checksum=SHA256(api_key+request_token+api_secret)
 *   GET  https://api.kite.trade/portfolio/holdings   headers X-Kite-Version: 3, Authorization: token api_key:access_token
 * The access token expires daily (~6 AM). There is deliberately no order/sell method.
 */
export class ZerodhaProvider implements HoldingsProvider {
  constructor() {
    requireEnv("ZERODHA_API_KEY", "ZERODHA_API_SECRET");
  }
  static loginUrl() {
    return `https://kite.zerodha.com/connect/login?v=3&api_key=${encodeURIComponent(process.env.ZERODHA_API_KEY ?? "")}`;
  }
  static async exchange(requestToken: string): Promise<string> {
    const key = process.env.ZERODHA_API_KEY!, secret = process.env.ZERODHA_API_SECRET!;
    const checksum = createHash("sha256").update(key + requestToken + secret).digest("hex");
    const res = await fetch("https://api.kite.trade/session/token", {
      method: "POST",
      headers: { "X-Kite-Version": "3", "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ api_key: key, request_token: requestToken, checksum }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new BiruniError("AUTH_FAILURE", `Kite session HTTP ${res.status}`);
    const j = (await res.json()) as { data?: { access_token?: string } };
    if (!j.data?.access_token) throw new BiruniError("AUTH_FAILURE", "Kite returned no access_token");
    process.env.ZERODHA_ACCESS_TOKEN = j.data.access_token; // RAM only; re-login daily
    return j.data.access_token;
  }
  async holdings(): Promise<Holding[]> {
    const token = process.env.ZERODHA_ACCESS_TOKEN;
    if (!token) throw new BiruniError("USER_REQUIRED", "Zerodha not logged in today: open /api/zerodha/login");
    const res = await fetch("https://api.kite.trade/portfolio/holdings", {
      headers: { "X-Kite-Version": "3", authorization: `token ${process.env.ZERODHA_API_KEY}:${token}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new BiruniError(res.status === 403 ? "AUTH_FAILURE" : "EXTERNAL_FAILURE", `Kite holdings HTTP ${res.status}`);
    const j = (await res.json()) as { data?: { tradingsymbol: string; quantity: number; last_price: number }[] };
    return (j.data ?? []).map((h) => ({ symbol: h.tradingsymbol, qty: h.quantity, lastPrice: h.last_price }));
  }
}

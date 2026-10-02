// Pine Labs — payments (spec §7). Every call reaches here only through the
// MCP finance + compliance + authority + idempotency middleware.
import type { Route } from "../../../packages/domain";
import { randomUUID } from "node:crypto";
import { BiruniError, id } from "../../../packages/shared";
import { notImplemented, requireEnv } from "../live-stub";
import { simulator } from "../simulator";

export type ChargeRequest = {
  idempotencyKey: string;
  amount: number;
  vendorId: string;
  rung: Route["vendorRung"];
  tripId: string;
};
export type ChargeStatus = { found: boolean; status?: "SUCCESS" | "FAILED" | "REFUNDED"; externalRef?: string; amount?: number };

export interface PaymentProvider {
  charge(req: ChargeRequest): Promise<{ externalRef: string; status: "SUCCESS" }>;
  refund(externalRef: string, amount: number, idempotencyKey: string): Promise<{ refundRef: string; status: "REFUNDED" }>;
  status(idempotencyKey: string): Promise<ChargeStatus>;
}

/** Provider-side ledger: simulates what the payment rail itself knows. */
export class MockPaymentProvider implements PaymentProvider {
  charges = new Map<string, { externalRef: string; amount: number; status: "SUCCESS" | "REFUNDED"; tripId: string }>();
  chargeCalls = 0;

  async charge(req: ChargeRequest) {
    this.chargeCalls++;
    const sim = simulator.trip(req.tripId);
    if (sim.faults.declineRungs?.includes(req.rung)) throw new BiruniError("EXTERNAL_FAILURE", `${req.rung} declined`, false);
    // Real rails dedupe on idempotency key; the mock does too.
    const prior = this.charges.get(req.idempotencyKey);
    if (prior) return { externalRef: prior.externalRef, status: "SUCCESS" as const };
    const externalRef = req.rung === "LOGGED_CASH" ? id("CASHLOG") : id("PL");
    this.charges.set(req.idempotencyKey, { externalRef, amount: req.amount, status: "SUCCESS", tripId: req.tripId });
    if (sim.faults.paymentTimeoutAfterCharge) {
      sim.faults.paymentTimeoutAfterCharge = false; // one-shot fault
      throw new BiruniError("TIMEOUT", "Pine Labs response timed out after request was sent", true);
    }
    return { externalRef, status: "SUCCESS" as const };
  }

  async refund(externalRef: string, _amount: number, _key: string) {
    for (const c of this.charges.values()) if (c.externalRef === externalRef) c.status = "REFUNDED";
    return { refundRef: id("RF"), status: "REFUNDED" as const };
  }

  async status(idempotencyKey: string): Promise<ChargeStatus> {
    const c = this.charges.get(idempotencyKey);
    return c ? { found: true, status: c.status, externalRef: c.externalRef, amount: c.amount } : { found: false };
  }
}

/**
 * Live Pine Labs Online (Plural) adapter. Contract from pinelabs.com/docs/online-payments/api:
 *   POST {base}/api/auth/v1/token           {client_id, client_secret, grant_type:"client_credentials"}
 *   POST {base}/api/pay/v1/paymentlink      amount in paise; merchant_payment_link_reference is idempotent
 *   GET  {base}/api/pay/v1/orders/reference/{merchant_order_reference}
 *   POST {base}/api/pay/v1/refunds/{order_id}
 *   headers: Authorization: Bearer, Request-ID (uuid), Request-Timestamp (ISO UTC)
 * Base: sandbox https://pluraluat.v2.pinepg.in, production https://api.pluralpay.in.
 * A gateway cannot silently debit the traveller: charge() creates a payment link and reports
 * USER_REQUIRED with the link, unless a pre-authorised mandate flow is set up with Pine Labs.
 * Order status values used below ("PROCESSED" = paid) are an assumption to verify in sandbox.
 */
export class PineLabsProvider implements PaymentProvider {
  private base = (process.env.PINELABS_API_URL || "https://pluraluat.v2.pinepg.in").replace(/\/$/, "");
  private token?: { value: string; exp: number };
  constructor() {
    requireEnv("PINELABS_CLIENT_ID", "PINELABS_API_KEY");
  }
  private async auth() {
    if (this.token && this.token.exp > Date.now() + 60_000) return this.token.value;
    const res = await fetch(`${this.base}/api/auth/v1/token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_id: process.env.PINELABS_CLIENT_ID, client_secret: process.env.PINELABS_API_KEY, grant_type: "client_credentials" }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new BiruniError("AUTH_FAILURE", `Pine Labs token HTTP ${res.status}`);
    const j = (await res.json()) as { access_token: string; expires_at?: string; expires_in?: number };
    this.token = { value: j.access_token, exp: j.expires_at ? Date.parse(j.expires_at) : Date.now() + (j.expires_in ?? 600) * 1000 };
    return this.token.value;
  }
  private async call(method: string, path: string, body?: unknown) {
    const res = await fetch(`${this.base}${path}`, {
      method,
      headers: { authorization: `Bearer ${await this.auth()}`, "content-type": "application/json", "Request-ID": randomUUID(), "Request-Timestamp": new Date().toISOString() },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status >= 500 || res.status === 429) throw new BiruniError(res.status === 429 ? "RATE_LIMIT" : "EXTERNAL_FAILURE", `Pine Labs HTTP ${res.status}`, true);
    if (!res.ok) throw new BiruniError("EXTERNAL_FAILURE", `Pine Labs HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return res.json() as Promise<any>;
  }
  async charge(req: ChargeRequest): Promise<{ externalRef: string; status: "SUCCESS" }> {
    if (req.rung === "LOGGED_CASH") return { externalRef: id("CASHLOG"), status: "SUCCESS" };
    const s = await this.status(req.idempotencyKey);
    if (s.found && s.status === "SUCCESS") return { externalRef: s.externalRef!, status: "SUCCESS" };
    const link = await this.call("POST", "/api/pay/v1/paymentlink", {
      amount: { value: Math.round(req.amount * 100), currency: "INR" },
      description: `Biruni recovery ${req.idempotencyKey} (${req.vendorId})`,
      merchant_payment_link_reference: req.idempotencyKey,
      expire_by: new Date(Date.now() + 2 * 3600_000).toISOString(),
      allowed_payment_methods: ["UPI", "CARD"],
    });
    throw new BiruniError("USER_REQUIRED", `Traveller must complete the Pine Labs payment: ${link.payment_link}`);
  }
  async refund(externalRef: string, amount: number, idempotencyKey: string) {
    const j = await this.call("POST", `/api/pay/v1/refunds/${encodeURIComponent(externalRef)}`, {
      merchant_order_reference: idempotencyKey,
      refund_amount: { value: Math.round(amount * 100), currency: "INR" },
    });
    return { refundRef: String(j.order_id ?? j.refund_id ?? idempotencyKey), status: "REFUNDED" as const };
  }
  async status(idempotencyKey: string): Promise<ChargeStatus> {
    try {
      const j = await this.call("GET", `/api/pay/v1/orders/reference/${encodeURIComponent(idempotencyKey)}`);
      const o = j.data ?? j;
      const st = String(o.status ?? "");
      return { found: true, status: st === "PROCESSED" ? "SUCCESS" : st === "REFUNDED" ? "REFUNDED" : st === "FAILED" ? "FAILED" : undefined, externalRef: o.order_id, amount: o.order_amount?.value ? o.order_amount.value / 100 : undefined };
    } catch (e) {
      if (String(e).includes("HTTP 404")) return { found: false };
      throw e;
    }
  }
}

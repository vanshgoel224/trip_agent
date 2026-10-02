// Pine Labs — payments (spec §7). Every call reaches here only through the
// MCP finance + compliance + authority + idempotency middleware.
import type { Route } from "../../../packages/domain";
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

export class PineLabsProvider implements PaymentProvider {
  constructor() {
    requireEnv("PINELABS_API_KEY", "PINELABS_CLIENT_ID", "PINELABS_API_URL");
  }
  charge(): Promise<never> {
    return notImplemented("pine-labs", "charge");
  }
  refund(): Promise<never> {
    return notImplemented("pine-labs", "refund");
  }
  status(): Promise<never> {
    return notImplemented("pine-labs", "status");
  }
}

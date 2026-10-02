// Compliance agent — owns the autonomous-action audit log, policy checks and
// incident trace (spec §4.4, §19). Every MCP call is evaluated and audited here.
import type { AuditRecord, Incident, Traveller, TripState } from "../../../packages/domain";
import type { Store } from "../../../packages/db";
import type { CheckResult } from "../../../packages/policy";
import { config, id, nowIso } from "../../../packages/shared";
import { bus } from "../../../packages/events";
import type { ToolName } from "../../mcp/schemas";
import { getRuntime } from "../../orchestrator/authority";

export type ComplianceCtx = { agent: string; approval?: { approvalId: string; overrideObligation?: boolean } };

export class ComplianceAgent {
  constructor(private store: Store) {}

  evaluate(tool: ToolName, args: Record<string, any>, ctx: ComplianceCtx): CheckResult {
    const trip = this.store.get<TripState>("trips", args.tripId);
    if (!trip) return { pass: false, code: "POLICY_BLOCKED", reason: "Unknown trip" };
    const traveller = this.store.get<Traveller>("users", trip.travellerId);
    if (!traveller) return { pass: false, code: "POLICY_BLOCKED", reason: "Unknown traveller" };
    if (traveller.age < config.minAge) return { pass: false, code: "POLICY_BLOCKED", reason: "Biruni is not available to users under 18" };

    const rt = getRuntime(this.store, trip.tripId);

    if ((tool === "financial_context" || tool === "holdings_context") && !traveller.aaConsentId)
      return { pass: false, code: "POLICY_BLOCKED", reason: "No consent on file: consented data only" };

    if (tool === "voice_speak" && args.to === "EMERGENCY_CONTACT" && !traveller.emergencyAutoAlertOptIn && !ctx.approval)
      return { pass: false, code: "USER_REQUIRED", reason: "Traveller has not opted in to automatic emergency alerts" };

    if (tool === "payment_execute" && args.operation === "charge") {
      const inc = this.store.get<Incident>("incidents", args.incidentId);
      if (!inc || inc.tripId !== trip.tripId) return { pass: false, code: "POLICY_BLOCKED", reason: "Charge must belong to an open incident on this trip" };
      if (inc.classification === "SAFETY" && !ctx.approval)
        return { pass: false, code: "POLICY_BLOCKED", reason: "Safety incident: no autonomous spending" };
      if (!rt.l4Active && !ctx.approval) return { pass: false, code: "POLICY_BLOCKED", reason: "L4 recovery authority not active" };
      if (!rt.online && args.rung !== "LOGGED_CASH")
        return { pass: false, code: "POLICY_BLOCKED", reason: "Offline: only logged cash is possible" };
      if (args.rung === "LOCAL_TRANSPORT" && !this.vendorVerified(args.incidentId, args.vendorId))
        return { pass: false, code: "POLICY_BLOCKED", reason: "Local transport vendor not verified" };
    }
    return { pass: true, reason: "Policy checks passed" };
  }

  private vendorVerified(incidentId: string, vendorId: string) {
    return this.store
      .list<{ tool: string; args: any; status: string; result?: any }>("tool_calls", { incidentId })
      .some((c) => c.tool === "vendor_verify" && c.args.vendorId === vendorId && c.status === "SUCCESS" && c.result?.data?.pass);
  }

  audit(r: Omit<AuditRecord, "auditId" | "timestamp">): string {
    const rec: AuditRecord = { auditId: id("AUD"), timestamp: nowIso(), ...r };
    this.store.put("audit_logs", rec.auditId, rec, { tripId: rec.tripId, incidentId: rec.incidentId });
    bus.emitEvent({ tripId: rec.tripId, incidentId: rec.incidentId, agent: "compliance", type: "AUDIT", detail: `${rec.tool}.${rec.action} → ${rec.result} (${rec.reasonCode})`, data: rec });
    return rec.auditId;
  }

  trace(incidentId: string): AuditRecord[] {
    return this.store.list<AuditRecord>("audit_logs", { incidentId });
  }
}

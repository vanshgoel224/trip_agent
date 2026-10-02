// Biruni's own MCP server (spec §6). Every invocation runs the fixed pipeline:
//   auth → schema → finance → compliance → authority → idempotency →
//   external API (safe retries) → normalized result → audit log
// Raw vendor APIs are never exposed to models or agents.
import type { AgentName, ToolResult } from "../../packages/domain";
import type { Store } from "../../packages/db";
import { BiruniError, nowIso } from "../../packages/shared";
import { bus } from "../../packages/events";
import type { Providers } from "../integrations";
import type { FinanceAgent } from "../agents/finance";
import type { ComplianceAgent } from "../agents/compliance";
import { authenticate, sleep, toBiruniError } from "./middleware";
import { schemas, type ToolName } from "./schemas";
import { TOOLS, newToolCallId, type ToolDef } from "./tools";

export type CallContext = {
  agent: AgentName;
  token: string;
  /** Present when the traveller explicitly approved this action (not autonomous). */
  approval?: { approvalId: string; overrideObligation?: boolean };
};

type ToolCallRow = {
  toolCallId: string;
  tool: ToolName;
  agent: AgentName;
  args: Record<string, unknown>;
  idempotencyKey?: string;
  status: "RUNNING" | "SUCCESS" | "FAILED" | "BLOCKED" | "AMBIGUOUS";
  result?: ToolResult;
  startedAt: string;
  finishedAt?: string;
};

const MAX_ATTEMPTS = 3;

export class BiruniMcpServer {
  constructor(
    private store: Store,
    private providers: Providers,
    private finance: FinanceAgent,
    private compliance: ComplianceAgent,
  ) {}

  listTools() {
    return Object.values(TOOLS).map((t) => ({ name: t.name, rail: t.rail, description: t.description, provisional: true }));
  }

  async call(tool: ToolName, rawArgs: unknown, ctx: CallContext): Promise<ToolResult> {
    const def = TOOLS[tool] as ToolDef<any> | undefined;
    const toolCallId = newToolCallId();
    const argsObj = (rawArgs ?? {}) as Record<string, any>;
    const tripId = String(argsObj.tripId ?? "");
    const incidentId = argsObj.incidentId as string | undefined;
    const row: ToolCallRow = { toolCallId, tool, agent: ctx.agent, args: argsObj, status: "RUNNING", startedAt: nowIso() };

    let obligationCheck: "PASS" | "FAIL" = "PASS";
    let complianceCheck: "PASS" | "FAIL" = "PASS";
    let amount: number | undefined;
    let authorityBefore: number | undefined;
    let reserved: string | undefined;

    const finish = (result: Omit<ToolResult, "auditId" | "toolCallId">, reasonCode: string, status: ToolCallRow["status"]): ToolResult => {
      let authorityAfter: number | undefined;
      if (incidentId && amount) {
        try {
          authorityAfter = this.finance.ledger(incidentId).remainingIncident;
        } catch {
          /* no ledger yet */
        }
      }
      const auditId = this.compliance.audit({
        tripId,
        incidentId,
        agent: ctx.agent,
        tool,
        action: String(argsObj.operation ?? tool),
        reasonCode,
        amount,
        authorityBefore,
        authorityAfter,
        obligationCheck,
        complianceCheck,
        result: status === "BLOCKED" ? "BLOCKED" : result.success ? "SUCCESS" : "FAILED",
      });
      const full: ToolResult = { ...result, toolCallId, auditId };
      this.store.put("tool_calls", toolCallId, { ...row, status, result: full, finishedAt: nowIso() }, { tripId, incidentId, key: row.idempotencyKey });
      bus.emitEvent({ tripId, incidentId, agent: ctx.agent, type: "MCP_CALL", detail: `MCP → ${tool}${argsObj.operation ? "." + argsObj.operation : ""}: ${full.status}`, data: { tool, status: full.status, error: full.error } });
      return full;
    };
    const fail = (e: BiruniError, status: ToolCallRow["status"] = "BLOCKED") =>
      finish({ success: false, status: e.code, error: { code: e.code, message: e.message, retryable: e.retryable } }, e.code, status);

    // 1. Authentication
    if (!def) return fail(new BiruniError("INVALID_REQUEST", `unknown tool ${tool}`));
    try {
      authenticate(ctx.agent, ctx.token, def.allowedAgents);
    } catch (e) {
      return fail(toBiruniError(e));
    }

    // 2. Schema validation
    const parsed = schemas[tool].safeParse(rawArgs);
    if (!parsed.success) return fail(new BiruniError("INVALID_REQUEST", parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")));
    const args = parsed.data as any;
    row.args = args;
    row.idempotencyKey = def.idempotencyKey(args);
    const spend = def.spend(args);
    if (spend > 0) {
      amount = spend;
      try {
        authorityBefore = this.finance.ledger(args.incidentId).remainingIncident;
      } catch {
        return fail(new BiruniError("POLICY_BLOCKED", "spend requires an open incident with an authority ledger"));
      }
    }

    // 3. Finance check (obligation guard)
    if (spend > 0) {
      const r = this.finance.checkObligation(tripId, spend, row.idempotencyKey);
      if (!r.pass && !ctx.approval?.overrideObligation) {
        obligationCheck = "FAIL";
        return fail(new BiruniError("OBLIGATION_BLOCKED", r.reason));
      }
    }

    // 4. Compliance check
    const c = this.compliance.evaluate(tool, args, ctx);
    if (!c.pass) {
      complianceCheck = "FAIL";
      return fail(new BiruniError((c.code as any) ?? "POLICY_BLOCKED", c.reason));
    }

    // 5. Authority check (₹2,000 cumulative per incident + daily ceiling)
    if (spend > 0 && !ctx.approval) {
      const r = this.finance.checkAuthority(args.incidentId, spend, row.idempotencyKey);
      if (!r.pass) return fail(new BiruniError("AUTHORITY_EXCEEDED", r.reason));
    }

    // 6. Idempotency check: never repeat a consequential action that already succeeded.
    if (row.idempotencyKey) {
      const prior = this.store
        .list<ToolCallRow>("tool_calls", { key: row.idempotencyKey })
        .filter((p) => p.tool === tool);
      const done = prior.find((p) => p.status === "SUCCESS");
      if (done) return finish({ success: true, status: "ALREADY_COMPLETED", data: done.result?.data }, "ALREADY_COMPLETED", "SUCCESS");
      if (def.reconcile && prior.some((p) => p.status === "AMBIGUOUS" || p.status === "RUNNING")) {
        const rec = await def.reconcile(args, this.deps());
        if (rec.completed) {
          if (spend > 0) (this.finance.reserve(args.incidentId, spend, row.idempotencyKey, !!ctx.approval), this.finance.commit(row.idempotencyKey));
          return finish({ success: true, status: "ALREADY_COMPLETED", data: rec.data }, "RECONCILED", "SUCCESS");
        }
      }
    }

    // Reserve authority before money moves; commit or release afterwards.
    if (spend > 0) {
      this.finance.reserve(args.incidentId, spend, row.idempotencyKey!, !!ctx.approval);
      reserved = row.idempotencyKey;
    }
    this.store.put("tool_calls", toolCallId, row, { tripId, incidentId, key: row.idempotencyKey });

    // 7. External API with safe retries
    let lastErr: BiruniError | undefined;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const data = await def.execute(args, this.deps());
        if (reserved) this.finance.commit(reserved);
        // 8. Normalized result
        return finish({ success: true, status: "SUCCESS", data }, attempt > 1 ? `SUCCESS_AFTER_RETRY_${attempt}` : "SUCCESS", "SUCCESS");
      } catch (e) {
        lastErr = toBiruniError(e);
        const retryable = lastErr.retryable && ["TIMEOUT", "NETWORK_FAILURE", "EXTERNAL_FAILURE"].includes(lastErr.code);
        if (!retryable) break;
        if (row.idempotencyKey) {
          // Consequential: ask the rail whether the money/booking already went through.
          this.store.put("tool_calls", toolCallId, { ...row, status: "AMBIGUOUS" }, { tripId, incidentId, key: row.idempotencyKey });
          if (def.reconcile) {
            const rec = await def.reconcile(args, this.deps());
            if (rec.completed) {
              if (reserved) this.finance.commit(reserved);
              bus.emitEvent({ tripId, incidentId, agent: "mcp", type: "RECONCILED", detail: `${tool}: ${lastErr.code} but rail shows completed — no second attempt` });
              return finish({ success: true, status: "RECONCILED", data: rec.data }, `RECONCILED_AFTER_${lastErr.code}`, "SUCCESS");
            }
          } else break; // no way to prove it did not happen: do not retry blindly
        }
        await sleep(25 * attempt);
      }
    }
    if (reserved) this.finance.release(reserved);
    return fail(lastErr ?? new BiruniError("EXTERNAL_FAILURE", "unknown failure"), "FAILED");
  }

  private deps() {
    return { store: this.store, providers: this.providers };
  }
}

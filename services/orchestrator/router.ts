// Agent routing with independent restart (spec §18): every invocation is an
// AgentRun row; a failed agent is restarted from persisted state, never from
// hidden memory.
import type { AgentName, AgentRun } from "../../packages/domain";
import type { Store } from "../../packages/db";
import { id, nowIso } from "../../packages/shared";
import { bus } from "../../packages/events";

export const MAX_AGENT_ATTEMPTS = 3;

export class AgentRouter {
  constructor(private store: Store) {}

  async run<T>(agent: AgentName, ctx: { tripId: string; incidentId?: string; input: unknown }, fn: () => Promise<T>, waiting?: (r: T) => boolean): Promise<T> {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= MAX_AGENT_ATTEMPTS; attempt++) {
      const run: AgentRun = { runId: id("RUN"), tripId: ctx.tripId, incidentId: ctx.incidentId, agent, input: ctx.input, status: "RUNNING", attempt, startedAt: nowIso() };
      this.store.put("agent_runs", run.runId, run, { tripId: ctx.tripId, incidentId: ctx.incidentId });
      bus.emitEvent({ tripId: ctx.tripId, incidentId: ctx.incidentId, agent, type: "AGENT_RUN", detail: `${agent} started${attempt > 1 ? ` (restart #${attempt - 1})` : ""}` });
      try {
        const out = await fn();
        const status = waiting?.(out) ? "WAITING" : "COMPLETED";
        this.store.put("agent_runs", run.runId, { ...run, status, output: summarize(out), finishedAt: nowIso() }, { tripId: ctx.tripId, incidentId: ctx.incidentId });
        return out;
      } catch (e) {
        lastErr = e;
        const msg = e instanceof Error ? e.message : String(e);
        this.store.put("agent_runs", run.runId, { ...run, status: "FAILED", error: msg, finishedAt: nowIso() }, { tripId: ctx.tripId, incidentId: ctx.incidentId });
        bus.emitEvent({ tripId: ctx.tripId, incidentId: ctx.incidentId, agent, type: "AGENT_FAILED", detail: `${agent} failed: ${msg}${attempt < MAX_AGENT_ATTEMPTS ? " — restarting from checkpoint" : ""}` });
      }
    }
    throw lastErr;
  }

  runs(filter: { tripId?: string; incidentId?: string }) {
    return this.store.list<AgentRun>("agent_runs", filter);
  }
}

function summarize(out: unknown) {
  if (out && typeof out === "object" && "step" in (out as any)) return { step: (out as any).step, stopReason: (out as any).stopReason };
  return out;
}

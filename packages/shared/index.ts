import { randomUUID } from "node:crypto";
import type { ErrorCode } from "../domain";

export const id = (prefix: string) => `${prefix}-${randomUUID().slice(0, 8).toUpperCase()}`;

export const nowIso = () => new Date().toISOString();

export const todayKey = (d = new Date()) => d.toISOString().slice(0, 10);

// Formatters live in one module shared with the app (apps/web/modules/format.js).
import { inr as fmtInr } from "../../apps/web/modules/format.js";
export * as fmt from "../../apps/web/modules/format.js";
export const inr = (n: number) => fmtInr(n);

export class BiruniError extends Error {
  constructor(
    public code: ErrorCode,
    message: string,
    public retryable = false,
  ) {
    super(message);
  }
}

// Spec §25: retry only timeouts, temporary network failures and 5xx.
export const RETRYABLE: ErrorCode[] = ["TIMEOUT", "NETWORK_FAILURE", "EXTERNAL_FAILURE"];

export const config = {
  port: Number(process.env.PORT ?? 8787),
  dbPath: process.env.BIRUNI_DB_PATH ?? "biruni.db",
  incidentAuthority: 2000, // spec §8 — cumulative per disruption, not per transaction
  undoWindowMs: Number(process.env.UNDO_WINDOW_MS ?? 30_000), // spec §11
  // "auto" (default): each rail is live when its key is set, simulated otherwise.
  providerMode: (process.env.PROVIDER_MODE ?? "auto") as "auto" | "mock" | "live",
  criticalBatteryPct: Number(process.env.CRITICAL_BATTERY_PCT ?? 5),
  minAge: 18,
  // Per-agent service tokens used by the MCP auth middleware. In production
  // these come from a secret store; the prototype derives them from JWT_SECRET.
  serviceSecret: process.env.JWT_SECRET ?? "dev-only-secret-change-me",
};

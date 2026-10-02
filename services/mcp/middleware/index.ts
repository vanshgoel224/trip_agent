import { createHmac, timingSafeEqual } from "node:crypto";
import type { AgentName, ErrorCode } from "../../../packages/domain";
import { BiruniError, config } from "../../../packages/shared";

// ---------- Authentication ----------
// Each agent gets a service token derived from the server secret. Tokens are
// server-side only and never reach the browser.
export const serviceToken = (agent: AgentName) => createHmac("sha256", config.serviceSecret).update(`agent:${agent}`).digest("hex");

export function authenticate(agent: AgentName, token: string, allowed: AgentName[]) {
  const expected = Buffer.from(serviceToken(agent));
  const got = Buffer.from(token);
  if (expected.length !== got.length || !timingSafeEqual(expected, got)) throw new BiruniError("AUTH_FAILURE", `bad service token for ${agent}`);
  if (!allowed.includes(agent)) throw new BiruniError("AUTH_FAILURE", `${agent} is not allowed to call this tool`);
}

// ---------- Retry policy (spec §25) ----------
export const isRetryable = (code: ErrorCode) => code === "TIMEOUT" || code === "NETWORK_FAILURE" || code === "RATE_LIMIT";

export function toBiruniError(e: unknown): BiruniError {
  if (e instanceof BiruniError) return e;
  const msg = e instanceof Error ? e.message : String(e);
  return new BiruniError("EXTERNAL_FAILURE", msg, false);
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

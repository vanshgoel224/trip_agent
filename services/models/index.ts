// Model layer (spec §5). Online: Nemotron Ultra. Offline: Qwen 4B on the phone.
// Both are reached through an OpenAI-compatible /chat/completions endpoint so
// any compatible model can be swapped in without touching tool contracts or
// guardrails. The model only PROPOSES (intent, disruption class); deterministic
// policy decides. With no model configured, rule-based fallbacks are used.
import { z } from "zod";
import type { DisruptionClass } from "../../packages/domain";
import { containsFuzzy } from "../../packages/shared/fuzzy";

export type Intent = "REPORT_DISRUPTION" | "UNDO" | "APPROVE" | "DECLINE" | "STATUS" | "VERIFIED_WAY_HOME" | "OTHER";

const ProposalSchema = z.object({
  intent: z.enum(["REPORT_DISRUPTION", "UNDO", "APPROVE", "DECLINE", "STATUS", "VERIFIED_WAY_HOME", "OTHER"]),
  disruptionClass: z.enum(["SAFETY", "ROUTE_BLOCKED", "LOGISTICAL"]).optional(),
});
export type Proposal = z.infer<typeof ProposalSchema> & { source: "ONLINE_MODEL" | "OFFLINE_MODEL" | "RULES" };

type Endpoint = { baseUrl: string; apiKey?: string; model: string };

// Defaults: Nemotron Ultra on NVIDIA's hosted API (enabled once ONLINE_MODEL_API_KEY
// is set), Qwen on a local Ollama server (its OpenAI-compatible /v1 endpoint).
export const DEFAULT_ONLINE = { baseUrl: "https://integrate.api.nvidia.com/v1", model: "nvidia/nemotron-3-ultra-550b-a55b" };
export const DEFAULT_OFFLINE = { baseUrl: "http://localhost:11434/v1", model: "qwen3:4b" };

// Temporary stand-in for Nemotron: Gemini via Google's OpenAI-compatible endpoint
// (https://ai.google.dev/gemini-api/docs/openai). Used only when GEMINI_API_KEY is
// set and ONLINE_MODEL_API_KEY is not. GEMINI_MODEL pins a model; otherwise one
// is picked from the key's own model list (see resolveGeminiModel).
export const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai";
let geminiModel: string | undefined = process.env.GEMINI_MODEL || undefined;
let geminiStrong: string | undefined;
/** A stronger (slower) Gemini model for harder jobs, e.g. low-resource language translation. */
export const geminiStrongModel = () => geminiStrong;

export function onlineEndpoint(): Endpoint | undefined {
  const apiKey = process.env.ONLINE_MODEL_API_KEY;
  if (apiKey) {
    return {
      baseUrl: process.env.ONLINE_MODEL_BASE_URL || DEFAULT_ONLINE.baseUrl,
      model: process.env.ONLINE_MODEL_NAME || DEFAULT_ONLINE.model,
      apiKey,
    };
  }
  const gemini = process.env.GEMINI_API_KEY;
  if (gemini) return { baseUrl: GEMINI_BASE_URL, model: geminiModel ?? "(auto)", apiKey: gemini };
  return undefined;
}

/** Lists the models this Gemini key can use and picks a fast text model. */
export async function resolveGeminiModel(apiKey: string, timeoutMs = 10000): Promise<{ model: string; available: string[] }> {
  const res = await fetch(`${GEMINI_BASE_URL}/models`, { headers: { authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`Gemini model list HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const j = (await res.json()) as { data?: { id: string }[] };
  const available = (j.data ?? []).map((m) => m.id.replace(/^models\//, ""));
  const text = available.filter((m) => m.startsWith("gemini") && !/embed|image|tts|audio|live|vision|thinking|transcribe|robotics|computer-use|omni|customtools/.test(m));
  // Newest numbered version first: older ones get retired for new keys.
  const version = (m: string) => Number(m.match(/^gemini-(\d+(?:\.\d+)?)/)?.[1] ?? 0);
  const byNewest = [...text].sort((a, b) => version(b) - version(a));
  // Intent classification is a small job: the newest stable flash-lite measured ~0.7s
  // vs 3-28s for full flash in testing, with the same answers.
  const pick = byNewest.find((m) => /-flash-lite$/.test(m)) ?? byNewest.find((m) => /-flash$/.test(m)) ?? byNewest[0];
  if (!pick) throw new Error("no usable Gemini text model for this key");
  geminiModel = pick;
  geminiStrong = byNewest.find((m) => /-flash$/.test(m)) ?? pick;
  return { model: pick, available };
}

export const isGeminiAuto = (ep: Endpoint) => ep.baseUrl === GEMINI_BASE_URL && ep.model === "(auto)";

export function offlineEndpoint(): Endpoint | undefined {
  // OFFLINE_MODEL_CONFIG is JSON: {"baseUrl":"http://localhost:11434/v1","model":"qwen3:4b"}
  // Set it to "off" to skip the local model entirely.
  const raw = process.env.OFFLINE_MODEL_CONFIG;
  if (raw === "off") return undefined;
  if (!raw) return DEFAULT_OFFLINE;
  try {
    const c = JSON.parse(raw);
    return c.baseUrl && c.model ? c : undefined;
  } catch {
    return undefined;
  }
}

/** Pull the JSON object out of a reply, ignoring any <think>…</think> reasoning block. */
export function extractJson(raw: string): unknown {
  const text = raw.replace(/<think>[\s\S]*?<\/think>/gi, "");
  const end = text.lastIndexOf("}");
  for (let start = text.lastIndexOf("{", end); start >= 0; start = text.lastIndexOf("{", start - 1)) {
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch {
      /* widen to the previous "{" */
    }
  }
  throw new Error("no JSON object in model reply");
}

const SYSTEM = `You classify a traveller's message for a travel-recovery agent.
Return ONLY JSON: {"intent": one of REPORT_DISRUPTION|UNDO|APPROVE|DECLINE|STATUS|VERIFIED_WAY_HOME|OTHER,
"disruptionClass": optional, one of SAFETY|ROUTE_BLOCKED|LOGISTICAL}.
SAFETY = any risk to the person. ROUTE_BLOCKED = the route is physically blocked. LOGISTICAL = cancellations, delays, missed connections.`;

/** One retry on 429/503 (provider overload), within the same overall timeout. */
export const GENERIC_SYSTEM = "You are a precise assistant. Follow the user's instructions exactly and return only what they ask for.";

export async function chat(ep: Endpoint, user: string, timeoutMs: number, system = SYSTEM): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  try {
    return await chatOnce(ep, user, timeoutMs, system);
  } catch (e) {
    const left = deadline - Date.now();
    if (!/HTTP (429|503)/.test(String(e)) || left < 1500) throw e;
    await new Promise((r) => setTimeout(r, 500));
    return chatOnce(ep, user, left - 500, system);
  }
}

async function chatOnce(ep: Endpoint, user: string, timeoutMs: number, system = SYSTEM): Promise<string> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${ep.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      signal: ctrl.signal,
      headers: { "content-type": "application/json", ...(ep.apiKey ? { authorization: `Bearer ${ep.apiKey}` } : {}) },
      body: JSON.stringify({ model: ep.model, temperature: 0, max_tokens: 1024, messages: [{ role: "system", content: system }, { role: "user", content: user }] }),
    });
    if (!res.ok) throw new Error(`model HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const j = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    return j.choices?.[0]?.message?.content ?? "";
  } finally {
    clearTimeout(t);
  }
}

export function rulesProposal(text: string): Proposal {
  const t = text.toLowerCase().trim();
  const has = (...w: string[]) => w.some((x) => t.includes(x)) || containsFuzzy(t, w.filter((x) => x.length >= 5));
  let intent: Intent = "OTHER";
  if (/^(undo|cancel that|ruko|wapas|revert)\b/.test(t) || has("undo")) intent = "UNDO";
  else if (/^(yes|haan|ha|ok|okay|approve|go ahead|book it|theek hai)\b/.test(t)) intent = "APPROVE";
  else if (/^(no|nahi|nahin|decline|don't|dont|leave it)\b/.test(t)) intent = "DECLINE";
  else if (has("already on", "found a way", "got a ride", "i'm on a", "i am on a", "reached")) intent = "VERIFIED_WAY_HOME";
  else if (has("cancel", "canceled", "cancelled", "cancellation", "delay", "delayed", "missed", "stuck", "stranded", "blocked", "landslide", "flood", "strike", "bandh", "accident", "unsafe", "help", "breakdown", "broke down", "overbooked"))
    intent = "REPORT_DISRUPTION";
  else if (has("status", "where", "what's happening", "kya hua", "update")) intent = "STATUS";
  return { intent, source: "RULES" };
}

// ---------- Tool-calling chat (the conversational agent) ----------

export type ChatMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | null;
  tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string }; [k: string]: unknown }[];
  tool_call_id?: string;
  [k: string]: unknown; // provider extras (e.g. Gemini thought signatures) are echoed back untouched
};
export type ToolSpec = { type: "function"; function: { name: string; description: string; parameters: Record<string, unknown> } };

/** Resolves the endpoint for this connectivity state (online: Nemotron/Gemini, offline: Qwen). */
export async function resolveEndpoint(online: boolean): Promise<Endpoint | undefined> {
  return (await endpointChain(online))[0];
}

// Local model health: a quick ping (cached 30 s) so a stopped Ollama is skipped instantly.
let localHealth: { ok: boolean; at: number; key: string } | undefined;
export async function localReachable(ep = offlineEndpoint()): Promise<boolean> {
  if (!ep) return false;
  const key = `${ep.baseUrl}|${ep.model}`;
  if (localHealth && localHealth.key === key && Date.now() - localHealth.at < 30_000) return localHealth.ok;
  let ok = false;
  try {
    const res = await fetch(`${ep.baseUrl.replace(/\/$/, "")}/models`, { signal: AbortSignal.timeout(800) });
    ok = res.ok;
  } catch {
    ok = false;
  }
  localHealth = { ok, at: Date.now(), key };
  return ok;
}

/**
 * Model fallback chain, best first:
 *   online:  Nemotron (ONLINE_MODEL_API_KEY) or Gemini stand-in → local Qwen (if reachable)
 *   offline: local Qwen
 *   MODEL_PRIMARY=local puts local Qwen first even when online.
 * If every model fails, callers fall back to deterministic rules.
 */
export async function endpointChain(online: boolean): Promise<(Endpoint & { tier: "online" | "local" })[]> {
  const out: (Endpoint & { tier: "online" | "local" })[] = [];
  const local = offlineEndpoint();
  const localOk = local ? await localReachable(local) : false;
  let remote: Endpoint | undefined;
  if (online) {
    remote = onlineEndpoint();
    if (remote && isGeminiAuto(remote)) {
      try {
        remote = { ...remote, model: (await resolveGeminiModel(remote.apiKey!)).model };
      } catch {
        remote = undefined;
      }
    }
  }
  const preferLocal = (process.env.MODEL_PRIMARY ?? "online") === "local" || !online;
  if (preferLocal && local && localOk) out.push({ ...local, tier: "local" });
  if (remote) out.push({ ...remote, tier: "online" });
  if (!preferLocal && local && localOk) out.push({ ...local, tier: "local" });
  return out;
}

export async function chatWithTools(ep: Endpoint, messages: ChatMessage[], tools: ToolSpec[], timeoutMs: number): Promise<ChatMessage> {
  const once = async (ms: number) => {
    const res = await fetch(`${ep.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      signal: AbortSignal.timeout(ms),
      headers: { "content-type": "application/json", ...(ep.apiKey ? { authorization: `Bearer ${ep.apiKey}` } : {}) },
      body: JSON.stringify({ model: ep.model, temperature: 0.2, max_tokens: 1024, messages, tools, tool_choice: "auto" }),
    });
    if (!res.ok) throw new Error(`model HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const j = (await res.json()) as { choices?: { message?: ChatMessage }[] };
    const msg = j.choices?.[0]?.message;
    if (!msg) throw new Error("model returned no message");
    return msg;
  };
  const start = Date.now();
  try {
    return await once(timeoutMs);
  } catch (e) {
    const left = timeoutMs - (Date.now() - start);
    if (!/HTTP (429|503)/.test(String(e))) throw e;
    // Honour the provider's suggested delay (Gemini sends retryDelay "Ns") when it fits.
    const hinted = Number(String(e).match(/retryDelay"?:\s*"?(\d+(?:\.\d+)?)s/)?.[1] ?? 0.7) * 1000;
    const wait = Math.min(Math.max(hinted, 700), 12_000);
    if (left < wait + 2000) throw e;
    await new Promise((r) => setTimeout(r, wait));
    return once(left - wait);
  }
}

export class ModelRouter {
  lastError?: string;

  constructor(private timeoutMs = Number(process.env.MODEL_TIMEOUT_MS ?? 15000)) {}

  describe() {
    return {
      online: onlineEndpoint() ? { model: onlineEndpoint()!.model, role: "recovery planning, obligation inference, negotiation" } : "not configured (rules fallback)",
      offline: offlineEndpoint() ? { model: offlineEndpoint()!.model, role: "cache lookups, voice relay, notes, undo timer" } : "not configured (rules fallback)",
      lastError: this.lastError ?? null,
    };
  }

  async propose(text: string, online: boolean): Promise<Proposal> {
    let ep = online ? onlineEndpoint() : offlineEndpoint();
    if (ep) {
      try {
        if (isGeminiAuto(ep)) ep = { ...ep, model: (await resolveGeminiModel(ep.apiKey!)).model };
        const raw = await chat(ep, text, this.timeoutMs);
        const p = ProposalSchema.parse(extractJson(raw));
        this.lastError = undefined;
        return { ...p, source: online ? "ONLINE_MODEL" : "OFFLINE_MODEL" };
      } catch (e) {
        // Fall through to deterministic rules; keep the reason visible in /api/health.
        this.lastError = `${online ? "online" : "offline"}: ${e instanceof Error ? e.message : e}`;
      }
    }
    return rulesProposal(text);
  }
}

export type { DisruptionClass };

// Model layer (spec §5). Online: Nemotron Ultra. Offline: Qwen 4B on the phone.
// Both are reached through an OpenAI-compatible /chat/completions endpoint so
// any compatible model can be swapped in without touching tool contracts or
// guardrails. The model only PROPOSES (intent, disruption class); deterministic
// policy decides. With no model configured, rule-based fallbacks are used.
import { z } from "zod";
import type { DisruptionClass } from "../../packages/domain";

export type Intent = "REPORT_DISRUPTION" | "UNDO" | "APPROVE" | "DECLINE" | "STATUS" | "VERIFIED_WAY_HOME" | "OTHER";

const ProposalSchema = z.object({
  intent: z.enum(["REPORT_DISRUPTION", "UNDO", "APPROVE", "DECLINE", "STATUS", "VERIFIED_WAY_HOME", "OTHER"]),
  disruptionClass: z.enum(["SAFETY", "ROUTE_BLOCKED", "LOGISTICAL"]).optional(),
});
export type Proposal = z.infer<typeof ProposalSchema> & { source: "ONLINE_MODEL" | "OFFLINE_MODEL" | "RULES" };

type Endpoint = { baseUrl: string; apiKey?: string; model: string };

function onlineEndpoint(): Endpoint | undefined {
  const baseUrl = process.env.ONLINE_MODEL_BASE_URL;
  const model = process.env.ONLINE_MODEL_NAME;
  if (!baseUrl || !model) return undefined;
  return { baseUrl, apiKey: process.env.ONLINE_MODEL_API_KEY, model };
}

function offlineEndpoint(): Endpoint | undefined {
  // OFFLINE_MODEL_CONFIG is JSON: {"baseUrl":"http://localhost:11434/v1","model":"<qwen tag>"}
  const raw = process.env.OFFLINE_MODEL_CONFIG;
  if (!raw) return undefined;
  try {
    const c = JSON.parse(raw);
    return c.baseUrl && c.model ? c : undefined;
  } catch {
    return undefined;
  }
}

const SYSTEM = `You classify a traveller's message for a travel-recovery agent.
Return ONLY JSON: {"intent": one of REPORT_DISRUPTION|UNDO|APPROVE|DECLINE|STATUS|VERIFIED_WAY_HOME|OTHER,
"disruptionClass": optional, one of SAFETY|ROUTE_BLOCKED|LOGISTICAL}.
SAFETY = any risk to the person. ROUTE_BLOCKED = the route is physically blocked. LOGISTICAL = cancellations, delays, missed connections.`;

async function chat(ep: Endpoint, user: string, timeoutMs: number): Promise<string> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${ep.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      signal: ctrl.signal,
      headers: { "content-type": "application/json", ...(ep.apiKey ? { authorization: `Bearer ${ep.apiKey}` } : {}) },
      body: JSON.stringify({ model: ep.model, temperature: 0, messages: [{ role: "system", content: SYSTEM }, { role: "user", content: user }] }),
    });
    if (!res.ok) throw new Error(`model HTTP ${res.status}`);
    const j = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    return j.choices?.[0]?.message?.content ?? "";
  } finally {
    clearTimeout(t);
  }
}

export function rulesProposal(text: string): Proposal {
  const t = text.toLowerCase().trim();
  const has = (...w: string[]) => w.some((x) => t.includes(x));
  let intent: Intent = "OTHER";
  if (/^(undo|cancel that|ruko|wapas|revert)\b/.test(t) || has("undo")) intent = "UNDO";
  else if (/^(yes|haan|ha|ok|okay|approve|go ahead|book it|theek hai)\b/.test(t)) intent = "APPROVE";
  else if (/^(no|nahi|nahin|decline|don't|dont|leave it)\b/.test(t)) intent = "DECLINE";
  else if (has("already on", "found a way", "got a ride", "i'm on a", "i am on a", "reached")) intent = "VERIFIED_WAY_HOME";
  else if (has("cancel", "delay", "missed", "stuck", "stranded", "blocked", "landslide", "flood", "strike", "bandh", "accident", "unsafe", "help", "breakdown", "broke down", "overbooked"))
    intent = "REPORT_DISRUPTION";
  else if (has("status", "where", "what's happening", "kya hua", "update")) intent = "STATUS";
  return { intent, source: "RULES" };
}

export class ModelRouter {
  constructor(private timeoutMs = Number(process.env.MODEL_TIMEOUT_MS ?? 4000)) {}

  describe() {
    return {
      online: onlineEndpoint() ? { model: onlineEndpoint()!.model, role: "recovery planning, obligation inference, negotiation" } : "not configured (rules fallback)",
      offline: offlineEndpoint() ? { model: offlineEndpoint()!.model, role: "cache lookups, voice relay, notes, undo timer" } : "not configured (rules fallback)",
    };
  }

  async propose(text: string, online: boolean): Promise<Proposal> {
    const ep = online ? onlineEndpoint() : offlineEndpoint();
    if (ep) {
      try {
        const raw = await chat(ep, text, this.timeoutMs);
        const json = raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1);
        const p = ProposalSchema.parse(JSON.parse(json));
        return { ...p, source: online ? "ONLINE_MODEL" : "OFFLINE_MODEL" };
      } catch {
        // fall through to deterministic rules
      }
    }
    return rulesProposal(text);
  }
}

export type { DisruptionClass };

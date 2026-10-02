// Bring-your-own-model: each user picks providers (priority order) and enters keys
// in the app; they're stored in that user's encrypted vault. Env vars remain the
// server-wide default when a user hasn't configured anything.
import { AsyncLocalStorage } from "node:async_hooks";
import Anthropic from "@anthropic-ai/sdk";

export type ProviderId = "anthropic" | "openai" | "gemini" | "nvidia" | "deepseek" | "openrouter" | "groq" | "mistral" | "together" | "ollama" | "hermes" | "custom";

export type ProviderConfig = { id: string; provider: ProviderId; apiKey?: string; baseUrl?: string; model?: string; enabled?: boolean };

/** Presets. Base URLs are the providers' documented OpenAI-compatible endpoints;
 *  model lists are suggestions — "Load models" asks the provider for its real list. */
export const PRESETS: Record<ProviderId, { label: string; baseUrl: string; defaultModel: string; models: string[]; tools: boolean; local?: boolean; keyHint: string }> = {
  anthropic: { label: "Anthropic (Claude)", baseUrl: "https://api.anthropic.com", defaultModel: "claude-opus-5-5", models: ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-4-5", "claude-fable-5-1"], tools: true, keyHint: "sk-ant-… from console.anthropic.com" },
  gemini: { label: "Google Gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", defaultModel: "(auto)", models: [], tools: true, keyHint: "Google AI Studio key" },
  nvidia: { label: "NVIDIA (Nemotron)", baseUrl: "https://integrate.api.nvidia.com/v1", defaultModel: "nvidia/nemotron-3-ultra-550b-a55b", models: ["nvidia/nemotron-3-ultra-550b-a55b", "nvidia/llama-3.1-nemotron-ultra-253b-v1", "nvidia/nemotron-3-super-120b-a12b"], tools: true, keyHint: "nvapi-… from build.nvidia.com" },
  deepseek: { label: "DeepSeek", baseUrl: "https://api.deepseek.com/v1", defaultModel: "deepseek-chat", models: ["deepseek-chat", "deepseek-reasoner"], tools: true, keyHint: "platform.deepseek.com key (verify model names with Load models)" },
  openai: { label: "OpenAI", baseUrl: "https://api.openai.com/v1", defaultModel: "", models: [], tools: true, keyHint: "sk-… — pick a model with Load models" },
  openrouter: { label: "OpenRouter (any model)", baseUrl: "https://openrouter.ai/api/v1", defaultModel: "", models: [], tools: true, keyHint: "sk-or-… — pick a model with Load models" },
  groq: { label: "Groq", baseUrl: "https://api.groq.com/openai/v1", defaultModel: "", models: [], tools: true, keyHint: "gsk_…" },
  mistral: { label: "Mistral", baseUrl: "https://api.mistral.ai/v1", defaultModel: "", models: [], tools: true, keyHint: "Mistral La Plateforme key" },
  together: { label: "Together AI", baseUrl: "https://api.together.xyz/v1", defaultModel: "", models: [], tools: true, keyHint: "Together key" },
  ollama: { label: "Ollama (local)", baseUrl: "http://localhost:11434/v1", defaultModel: "qwen3:4b", models: [], tools: true, local: true, keyHint: "no key; runs on your computer" },
  hermes: { label: "Hermes Agent (local, tools off)", baseUrl: "http://127.0.0.1:8642/v1", defaultModel: "", models: [], tools: false, local: true, keyHint: "API_SERVER_KEY from ~/.hermes/.env" },
  custom: { label: "Custom OpenAI-compatible", baseUrl: "", defaultModel: "", models: [], tools: true, keyHint: "any /v1/chat/completions server" },
};

export type Endpoint = { baseUrl: string; apiKey?: string; model: string; provider?: ProviderId; tools?: boolean };

// Per-request user model settings (multi-user), without threading them through every call.
const als = new AsyncLocalStorage<ProviderConfig[] | undefined>();
export const withModels = <T>(providers: ProviderConfig[] | undefined, fn: () => T) => als.run(providers, fn);
export const currentProviders = () => als.getStore();

export function toEndpoint(p: ProviderConfig): Endpoint | undefined {
  const pre = PRESETS[p.provider];
  if (!pre || p.enabled === false) return undefined;
  const baseUrl = (p.baseUrl || pre.baseUrl).replace(/\/$/, "");
  const model = p.model || pre.defaultModel;
  if (!baseUrl) return undefined;
  if (!pre.local && !p.apiKey) return undefined;
  return { baseUrl, apiKey: p.apiKey, model: model || "(auto)", provider: p.provider, tools: pre.tools };
}

/** Lists models from a provider (OpenAI-compatible /models, or Anthropic's Models API). */
export async function listModels(p: ProviderConfig): Promise<string[]> {
  const pre = PRESETS[p.provider];
  if (p.provider === "anthropic") {
    const c = new Anthropic({ apiKey: p.apiKey, maxRetries: 0, timeout: 10_000, ...(p.baseUrl ? { baseURL: p.baseUrl } : {}) });
    const out: string[] = [];
    for await (const m of c.models.list()) out.push(m.id);
    return out;
  }
  const res = await fetch(`${(p.baseUrl || pre.baseUrl).replace(/\/$/, "")}/models`, { headers: p.apiKey ? { authorization: `Bearer ${p.apiKey}` } : {}, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 160)}`);
  const j = (await res.json()) as { data?: { id: string }[]; models?: { name: string }[] };
  return (j.data?.map((m) => m.id.replace(/^models\//, "")) ?? j.models?.map((m) => m.name) ?? []).sort();
}

// ---------- Anthropic adapter (official SDK, Messages API) ----------

type OAIMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | null;
  tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
  _anthropic?: unknown[]; // raw content blocks, echoed back unchanged (thinking blocks must be)
  [k: string]: unknown;
};
type OAITool = { type: "function"; function: { name: string; description: string; parameters: Record<string, unknown> } };

const anthropicClients = new Map<string, Anthropic>();
const anthropicClient = (key: string, baseURL?: string) => {
  const k = `${baseURL}|${key}`;
  let c = anthropicClients.get(k);
  if (!c) anthropicClients.set(k, (c = new Anthropic({ apiKey: key, maxRetries: 1, ...(baseURL ? { baseURL } : {}) })));
  return c;
};
// Models that take output_config.effort and the server-side refusal fallback.
const CURRENT_GEN = /^claude-(opus-5|sonnet-5-5|fable-5)/;

const parseArgs = (s: string) => {
  try {
    return JSON.parse(s || "{}");
  } catch {
    return {};
  }
};

/** OpenAI-style conversation in, OpenAI-style assistant message out — Messages API in between. */
export async function anthropicChat(ep: Endpoint, messages: OAIMessage[], tools: OAITool[] | undefined, timeoutMs: number): Promise<OAIMessage> {
  const system = messages.filter((m) => m.role === "system").map((m) => String(m.content ?? "")).join("\n\n");
  const out: Anthropic.Beta.BetaMessageParam[] = [];
  for (const m of messages) {
    if (m.role === "system") continue;
    if (m.role === "user") out.push({ role: "user", content: String(m.content ?? "") });
    else if (m.role === "assistant") {
      if (m._anthropic) out.push({ role: "assistant", content: m._anthropic as Anthropic.Beta.BetaContentBlockParam[] });
      else if (m.tool_calls?.length)
        out.push({
          role: "assistant",
          content: [...(m.content ? [{ type: "text" as const, text: String(m.content) }] : []), ...m.tool_calls.map((tc) => ({ type: "tool_use" as const, id: tc.id, name: tc.function.name, input: parseArgs(tc.function.arguments) }))],
        });
      else out.push({ role: "assistant", content: String(m.content ?? "") || "…" });
    } else if (m.role === "tool") {
      // All tool results for one assistant turn go in a single user message.
      const block: Anthropic.Beta.BetaToolResultBlockParam = { type: "tool_result", tool_use_id: String(m.tool_call_id), content: String(m.content ?? "") };
      const last = out.at(-1);
      if (last && last.role === "user" && Array.isArray(last.content) && last.content.every((b) => (b as { type: string }).type === "tool_result")) (last.content as Anthropic.Beta.BetaToolResultBlockParam[]).push(block);
      else out.push({ role: "user", content: [block] });
    }
  }
  const current = CURRENT_GEN.test(ep.model);
  try {
    const r = await anthropicClient(ep.apiKey!, ep.baseUrl).beta.messages.create(
      {
        model: ep.model,
        max_tokens: 16000,
        ...(system ? { system } : {}),
        messages: out,
        ...(tools?.length ? { tools: tools.map((t) => ({ name: t.function.name, description: t.function.description, input_schema: t.function.parameters as Anthropic.Beta.BetaTool.InputSchema })) } : {}),
        ...(current
          ? {
              output_config: { effort: (process.env.ANTHROPIC_EFFORT as "low" | "medium" | "high") || "medium" },
              // Server-side refusal fallback (routes by refusal category; no model list to maintain).
              betas: ["server-side-fallback-2026-07-01"],
              fallbacks: "default" as const,
            }
          : {}),
      },
      { timeout: timeoutMs },
    );
    const text = r.content.filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text").map((b) => b.text).join("");
    const uses = r.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
    if (r.stop_reason === "refusal") return { role: "assistant", content: text || "I can't help with that request.", _anthropic: r.content };
    return {
      role: "assistant",
      content: text || null,
      tool_calls: uses.length ? uses.map((b) => ({ id: b.id, type: "function" as const, function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } })) : undefined,
      _anthropic: r.content,
    };
  } catch (e) {
    // Normalise to the "model HTTP <status>" shape the fallback chain understands.
    if (e instanceof Anthropic.APIError) throw new Error(`model HTTP ${e.status ?? "error"}: ${e.message.slice(0, 160)}`);
    throw e;
  }
}

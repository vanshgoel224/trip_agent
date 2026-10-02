// Entry point for every chat message: persists the turn, runs the chat agent
// (LLM + tools) and falls back to the deterministic rules when no model is
// reachable. Also hosts voice translation (STT → translate → TTS).
import type { Store } from "../packages/db";
import type { Orchestrator } from "./orchestrator";
import type { ChatAgent } from "./orchestrator/chat-agent";
import type { Chats, ChatMode, CustomSpec } from "./orchestrator/chats";
import type { MemoryGraph } from "./memory";
import type { VoiceAgent } from "./agents/voice";
import { chat as modelChat, GENERIC_SYSTEM, endpointChain, geminiStrongModel, type ModelRouter } from "./models";
import { bestMatch, containsFuzzy, editDistance, normalize, rank } from "../packages/shared/fuzzy";

// Languages for translation. Gnani (voice) covers the first ten; the rest use
// text translation plus the browser's speech engines where the device has them.
export const LANGUAGES: { code: string; name: string; gnani: boolean }[] = [
  { code: "en-IN", name: "English", gnani: true }, { code: "hi-IN", name: "Hindi", gnani: true },
  { code: "bn-IN", name: "Bengali", gnani: true }, { code: "ta-IN", name: "Tamil", gnani: true },
  { code: "te-IN", name: "Telugu", gnani: true }, { code: "kn-IN", name: "Kannada", gnani: true },
  { code: "ml-IN", name: "Malayalam", gnani: true }, { code: "mr-IN", name: "Marathi", gnani: true },
  { code: "gu-IN", name: "Gujarati", gnani: true }, { code: "pa-IN", name: "Punjabi", gnani: true },
  { code: "or-IN", name: "Odia", gnani: false }, { code: "as-IN", name: "Assamese", gnani: false },
  { code: "ur-IN", name: "Urdu", gnani: false }, { code: "ne-NP", name: "Nepali", gnani: false },
  { code: "kok-IN", name: "Konkani", gnani: false }, { code: "mai-IN", name: "Maithili", gnani: false },
  { code: "sd-IN", name: "Sindhi", gnani: false }, { code: "ks-IN", name: "Kashmiri", gnani: false },
  { code: "doi-IN", name: "Dogri", gnani: false }, { code: "mni-IN", name: "Manipuri (Meitei)", gnani: false },
  { code: "sat-IN", name: "Santali", gnani: false }, { code: "sa-IN", name: "Sanskrit", gnani: false },
  { code: "brx-IN", name: "Bodo", gnani: false },
];
const langName = (code: string) => LANGUAGES.find((l) => l.code === code)?.name ?? code;

/** "Tamil", "tamill", "ta", "ta-IN", "तमिल"-ish names → BCP-47 code. */
export function resolveLanguage(input: string | undefined): string | undefined {
  if (!input) return undefined;
  const exact = LANGUAGES.find((l) => l.code.toLowerCase() === input.toLowerCase() || l.code.split("-")[0] === input.toLowerCase());
  return exact?.code ?? bestMatch(input, LANGUAGES, (l) => [l.name, l.code], 0.7)?.item.code;
}

// Slash commands, case-insensitive and typo-tolerant ("/Recal", "/forgt", "/BTW").
const COMMANDS: Record<string, "recall" | "forget" | "btw"> = { recall: "recall", memory: "recall", yaad: "recall", remember: "recall", forget: "forget", bhool: "forget", delete: "forget", btw: "btw", aside: "btw" };
export function parseCommand(text: string): { cmd: "recall" | "forget" | "btw"; arg: string } | undefined {
  const m = text.match(/^\s*\/\s*([\p{L}]+)\s*([\s\S]*)$/u);
  if (!m) return undefined;
  const word = normalize(m[1]);
  const arg = m[2].trim();
  if (!arg) return undefined;
  if (COMMANDS[word]) return { cmd: COMMANDS[word], arg };
  for (const [k, v] of Object.entries(COMMANDS)) if (k.length >= 4 && editDistance(word, k, 1) <= 1) return { cmd: v, arg };
  return undefined;
}

// Unicode blocks per language, to catch a model answering in the wrong script.
const SCRIPTS: Record<string, RegExp> = {
  hi: /[\u0900-\u097F]/, mr: /[\u0900-\u097F]/, ne: /[\u0900-\u097F]/, kok: /[\u0900-\u097F]/, mai: /[\u0900-\u097F]/,
  sa: /[\u0900-\u097F]/, doi: /[\u0900-\u097F]/, brx: /[\u0900-\u097F]/, bn: /[\u0980-\u09FF]/, as: /[\u0980-\u09FF]/,
  pa: /[\u0A00-\u0A7F]/, gu: /[\u0A80-\u0AFF]/, or: /[\u0B00-\u0B7F]/, ta: /[\u0B80-\u0BFF]/, te: /[\u0C00-\u0C7F]/,
  kn: /[\u0C80-\u0CFF]/, ml: /[\u0D00-\u0D7F]/, ur: /[\u0600-\u06FF]/, ks: /[\u0600-\u06FF]/, sd: /[\u0600-\u06FF]/,
  mni: /[\u0980-\u09FF\uABC0-\uABFF]/, sat: /[\u1C50-\u1C7F]/, en: /[A-Za-z]/,
};
/** Share of letters in the expected script (1 = all correct). */
export function scriptScore(text: string, code: string): number {
  const re = SCRIPTS[code.split("-")[0]];
  if (!re) return 1;
  const letters = [...text].filter((ch) => /\p{L}/u.test(ch));
  return letters.length ? letters.filter((ch) => re.test(ch)).length / letters.length : 0;
}

type Deps = { store: Store; orchestrator: Orchestrator; chats: Chats; chatAgent: ChatAgent; memory: MemoryGraph; voice: VoiceAgent; models: ModelRouter };

// Which function-chat a General message belongs to, by the tools it used.
const TOOL_HOME: Record<string, ChatMode> = {
  add_expense: "splitwise", list_expenses: "splitwise", get_balances: "splitwise", settle_up: "splitwise", remove_expense: "splitwise", splitwise_groups: "splitwise", splitwise_push: "splitwise",
  report_disruption: "recovery", approve_pending: "recovery", decline_pending: "recovery", undo_last_action: "recovery", mark_verified_way_home: "recovery", search_alternative_routes: "recovery",
  where_am_i: "maps", find_place: "maps", nearby_places: "maps", directions: "maps",
  discover_places: "discover",
  calendar_list_events: "calendar", calendar_add_event: "calendar", add_activity: "calendar", update_activity: "calendar", remove_activity: "calendar",
  get_budget: "budget",
  start_deal: "negotiate", deal_reply: "negotiate", deal_cancel: "negotiate",
  delivery_quote: "delivery", delivery_book: "delivery", delivery_track: "delivery", delivery_cancel: "delivery", delivery_list: "delivery",
};
const TRANSLATE_RE = /\b(translate|translation|anuvad|in (hindi|tamil|telugu|kannada|malayalam|marathi|gujarati|punjabi|bengali|odia|urdu|assamese|konkani|english))\b|\b(kaise bolte|ko .* mein kya kehte)\b/i;

/** Function chats a General exchange should also be filed under. */
export function routeTargets(text: string, tools: string[]): ChatMode[] {
  const modes = new Set<ChatMode>();
  for (const t of tools) {
    const m = TOOL_HOME[t.replace(/\(.*$/, "")];
    if (m) modes.add(m);
  }
  if (TRANSLATE_RE.test(text) || containsFuzzy(text, ["translate", "translation", "anuvad"])) modes.add("translate");
  return [...modes];
}

export class Conversation {
  constructor(private d: Deps) {}

  /** Google-style chat search over titles and message text: case-, accent- and typo-tolerant. */
  searchChats(q: string) {
    if (normalize(q).length < 2) return [];
    const docs = this.d.chats.list().map((c) => {
      const msgs = this.d.chats.messages(c.chatId);
      return { c, msgs };
    });
    return rank(q, docs, ({ c, msgs }) => [c.title, ...msgs.slice(-40).map((m) => m.text.slice(0, 300))], 0.6)
      .slice(0, 20)
      .map(({ item, score }) => {
        const snippet = item.msgs.map((m) => m.text).find((t) => bestMatch(q, [t], (x) => x, 0.6)) ?? "";
        return { chatId: item.c.chatId, title: item.c.title, mode: item.c.mode, emoji: item.c.emoji, score: Math.round(score * 100) / 100, snippet: snippet.slice(0, 140) };
      });
  }

  newChat(mode: ChatMode, tripId?: string, title?: string, custom?: CustomSpec, emoji?: string) {
    const c = this.d.chats.create(mode, tripId, title, custom, emoji);
    this.d.memory.upsertNode("chat", `${c.title} (${c.chatId})`, c.chatId, { mode });
    return c;
  }

  async send(chatId: string, text: string, hints: { targetLanguage?: string; sourceLanguage?: string } = {}) {
    const started = Date.now();
    const chat = this.d.chats.get(chatId);
    if (!chat) throw new Error("unknown chat");
    const clean = text.trim().slice(0, 4000);
    if (!clean) throw new Error("empty message");
    // /btw: side question, answered but never stored (no history, no memory, no auto-filing, read-only tools).
    const command = parseCommand(clean);
    if (command?.cmd === "btw") {
      const q = command.arg;
      const out = (await this.d.chatAgent.respond(chat, q, undefined, { ephemeral: true })) ?? { reply: "My language model isn't connected, so I can't answer side questions right now.", source: "RULES", tools: [] };
      const message = { messageId: "EPHEMERAL", chatId, role: "assistant" as const, text: out.reply, at: new Date().toISOString(), source: `btw · not saved · ${out.source}`, tools: out.tools };
      return { chat, message, tools: out.tools, source: out.source, copiedTo: [], ephemeral: true };
    }

    this.d.chats.add(chatId, { role: "user", text: clean });

    if (command?.cmd === "forget") {
      const gone = this.d.memory.forget(command.arg);
      const msg = this.d.chats.add(chatId, { role: "assistant", text: gone.length ? `Forgotten: ${gone.join(", ")}.` : `Nothing in memory matched "${command.arg}".`, source: "MEMORY" });
      return { chat: this.d.chats.get(chatId), message: msg, tools: ["forget"], source: "MEMORY", copiedTo: [] };
    }

    // Quick recall: answered straight from the memory graph, no model call.
    if (command?.cmd === "recall") {
      const hits = this.d.memory.search(command.arg);
      const reply = hits.length
        ? hits.slice(0, 6).map((h) => `• ${h.label} (${h.type})${h.facts.length ? ": " + h.facts.slice(0, 5).join("; ") : ""}`).join("\n")
        : `Nothing in memory about "${command.arg}" yet.`;
      const msg = this.d.chats.add(chatId, { role: "assistant", text: reply, source: "MEMORY" });
      return { chat: this.d.chats.get(chatId), message: msg, tools: ["quick_recall"], source: "MEMORY", copiedTo: [] };
    }

    const hint = chat.mode === "translate" && hints.targetLanguage
      ? `Translator settings from the app: source ${hints.sourceLanguage && hints.sourceLanguage !== "auto" ? langName(hints.sourceLanguage) : "auto-detect"}, target ${langName(hints.targetLanguage)} (use this target unless the latest message names another language).`
      : undefined;
    let out = await this.d.chatAgent.respond(chat, clean, hint);
    if (!out) {
      // No model reachable: deterministic rules (disruption/undo/approve/status) still work.
      if (chat.tripId) {
        const r = await this.d.orchestrator.handleMessage(chat.tripId, clean);
        out = { reply: r.reply, source: "RULES", tools: [] };
      } else {
        out = { reply: "My language model isn't connected (set GEMINI_API_KEY or ONLINE_MODEL_API_KEY). Without it I can only handle trip disruptions.", source: "RULES", tools: [] };
      }
    }
    const msg = this.d.chats.add(chatId, { role: "assistant", text: out.reply, source: out.source, tools: out.tools, ms: Date.now() - started });

    // Auto-file General messages into the matching function chat (created if needed).
    const copiedTo: { chatId: string; mode: ChatMode; title: string }[] = [];
    if (chat.mode === "general") {
      for (const mode of routeTargets(clean, out.tools)) {
        const target = this.d.chats.findLatest(mode, chat.tripId) ?? this.newChat(mode, chat.tripId);
        this.d.chats.add(target.chatId, { role: "user", text: clean, copiedFrom: chatId });
        this.d.chats.add(target.chatId, { role: "assistant", text: out.reply, source: out.source, tools: out.tools, copiedFrom: chatId });
        copiedTo.push({ chatId: target.chatId, mode, title: this.d.chats.get(target.chatId)!.title });
      }
    }
    return { chat: this.d.chats.get(chatId), message: msg, tools: out.tools, source: out.source, copiedTo };
  }

  /** Text translation between any two languages via the LLM, with a script sanity check. */
  async translate(text: string, from: string, to: string): Promise<{ translation: string; pronunciation?: string; source: string; warning?: string }> {
    const chain = await endpointChain(true).catch(() => []);
    if (!chain.length) throw new Error("Translation needs a language model: set GEMINI_API_KEY / ONLINE_MODEL_API_KEY, or run local Qwen (Ollama)");
    let ep = chain[0];
    const prompt = `Translate from ${from === "auto" ? "the detected language" : langName(from)} to ${langName(to)}. Write the translation ONLY in ${langName(to)}'s own script. Return ONLY JSON: {"translation": "<in ${langName(to)} script>", "pronunciation": "<Latin-script reading>"}.\nText: ${text}`;
    const run = async (model: string) => {
      const raw = await modelChat({ ...ep, model }, prompt, 20_000, GENERIC_SYSTEM);
      const body = raw.replace(/<think>[\s\S]*?<\/think>/gi, "");
      const j = JSON.parse(body.slice(body.indexOf("{"), body.lastIndexOf("}") + 1));
      return { translation: String(j.translation ?? "").trim(), pronunciation: j.pronunciation as string | undefined, source: model };
    };
    let out: Awaited<ReturnType<typeof run>>;
    try {
      out = await run(ep.model);
    } catch (e) {
      if (!chain[1]) throw e;
      ep = chain[1]; // fallback model
      out = await run(ep.model);
    }
    if (scriptScore(out.translation, to) < 0.85) {
      const strong = geminiStrongModel();
      if (strong && strong !== ep.model) out = await run(strong).catch(() => out);
    }
    const score = scriptScore(out.translation, to);
    return score < 0.85 ? { ...out, warning: `Output may not be fully in ${langName(to)} script (${Math.round(score * 100)}% match); double-check with a native speaker.` } : out;
  }

  /** Voice translation: speech (or text) in → translated text + speech out. */
  async voiceTranslate(input: { text?: string; audioBase64?: string; mime?: string; from: string; to: string }) {
    const heard = await this.d.voice.transcribe(input, input.from === "auto" ? "en-IN" : input.from);
    if (!heard.text.trim()) throw new Error("Didn't catch any speech");
    const t = await this.translate(heard.text, input.from, input.to);
    const speech = await this.d.voice.synthesize(t.translation, input.to).catch((e) => ({ channel: `TTS_FAILED: ${(e as Error).message}`, audioUrl: undefined }));
    return { heard: heard.text, sttChannel: heard.channel, ...t, ...speech };
  }
}

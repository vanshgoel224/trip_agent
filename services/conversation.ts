// Entry point for every chat message: persists the turn, runs the chat agent
// (LLM + tools) and falls back to the deterministic rules when no model is
// reachable. Also hosts voice translation (STT → translate → TTS).
import type { Store } from "../packages/db";
import type { Orchestrator } from "./orchestrator";
import type { ChatAgent } from "./orchestrator/chat-agent";
import type { Chats, ChatMode } from "./orchestrator/chats";
import type { MemoryGraph } from "./memory";
import type { VoiceAgent } from "./agents/voice";
import { chat as modelChat, resolveEndpoint, type ModelRouter } from "./models";

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

type Deps = { store: Store; orchestrator: Orchestrator; chats: Chats; chatAgent: ChatAgent; memory: MemoryGraph; voice: VoiceAgent; models: ModelRouter };

export class Conversation {
  constructor(private d: Deps) {}

  newChat(mode: ChatMode, tripId?: string, title?: string) {
    const c = this.d.chats.create(mode, tripId, title);
    this.d.memory.upsertNode("chat", `${c.title} (${c.chatId})`, c.chatId, { mode });
    return c;
  }

  async send(chatId: string, text: string) {
    const chat = this.d.chats.get(chatId);
    if (!chat) throw new Error("unknown chat");
    const clean = text.trim().slice(0, 4000);
    if (!clean) throw new Error("empty message");
    this.d.chats.add(chatId, { role: "user", text: clean });
    let out = await this.d.chatAgent.respond(chat, clean);
    if (!out) {
      // No model reachable: deterministic rules (disruption/undo/approve/status) still work.
      if (chat.tripId) {
        const r = await this.d.orchestrator.handleMessage(chat.tripId, clean);
        out = { reply: r.reply, source: "RULES", tools: [] };
      } else {
        out = { reply: "My language model isn't connected (set GEMINI_API_KEY or ONLINE_MODEL_API_KEY). Without it I can only handle trip disruptions.", source: "RULES", tools: [] };
      }
    }
    const msg = this.d.chats.add(chatId, { role: "assistant", text: out.reply, source: out.source, tools: out.tools });
    return { chat: this.d.chats.get(chatId), message: msg, tools: out.tools, source: out.source };
  }

  /** Text translation between any two languages via the LLM. */
  async translate(text: string, from: string, to: string): Promise<{ translation: string; pronunciation?: string; source: string }> {
    const ep = await resolveEndpoint(true).catch(() => undefined);
    if (!ep) throw new Error("Translation needs a language model: set GEMINI_API_KEY or ONLINE_MODEL_API_KEY");
    const prompt = `Translate from ${from === "auto" ? "the detected language" : langName(from)} to ${langName(to)}. Return ONLY JSON: {"translation": "<in native script>", "pronunciation": "<Latin-script reading of the translation>"}.\nText: ${text}`;
    const raw = await modelChat(ep, prompt, 20_000);
    const body = raw.replace(/<think>[\s\S]*?<\/think>/gi, "");
    const j = JSON.parse(body.slice(body.indexOf("{"), body.lastIndexOf("}") + 1));
    return { translation: String(j.translation ?? "").trim(), pronunciation: j.pronunciation, source: ep.model };
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

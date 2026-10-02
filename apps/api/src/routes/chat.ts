// Routes: chats, memory graph (graphify format), translation & voice.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { createBiruni } from "../../../../services/runtime";
import { SCENARIOS, createCustomTrip, seedScenario, type ScenarioName } from "../../../../services/integrations/scenarios";
import { CHAT_MODES, DEFAULT_EMOJI, TOOL_GROUPS, type ChatMode } from "../../../../services/orchestrator/chats";
import { LANGUAGES } from "../../../../services/conversation";
import { audioCache } from "../../../../services/agents/voice";
import { GoogleCalendar } from "../../../../services/integrations/google-calendar";
import { redditConfigured } from "../../../../services/integrations/reddit";
import { youtubeConfigured } from "../../../../services/integrations/youtube";
import { splitwiseConfigured } from "../../../../services/agents/expenses";
import { providerStatus } from "../../../../services/integrations";
import { ZerodhaProvider } from "../../../../services/integrations/zerodha";
import { SetuProvider } from "../../../../services/integrations/setu-aa";
import { chat as modelChat, GENERIC_SYSTEM, endpointChain, listModels, onlineEndpoint, offlineEndpoint, PRESETS, type ProviderConfig } from "../../../../services/models";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { Vault, type Cipher } from "../../../../packages/db/vault";
import { authorized, handleRemoteMcp, remoteMcpEnabled } from "../../../../services/mcp/remote";
import { WebSocketServer } from "ws";
import { Telephony } from "../../../../services/telephony";
import type { Biruni } from "../../../../services/runtime";
import { mkdir, writeFile } from "node:fs/promises";
import { bus, type BiruniEvent } from "../../../../packages/events";
import { BiruniError, config } from "../../../../packages/shared";
import type { Incident, TripState } from "../../../../packages/domain";

import type { RouteFn } from "../http";
import { rt, me, cal, spaces } from "../spaces";

export default function register(route: RouteFn) {
// ---------- chats ----------
route("GET", "/api/chat-modes", () => Object.entries(CHAT_MODES).map(([mode, m]) => ({ mode, label: m.label, icon: DEFAULT_EMOJI[mode as ChatMode] ?? m.icon })));
route("GET", "/api/chats", () => rt().chats.list());
route("GET", "/api/chats/search", (_r, _b, _p, url) => rt().conversation.searchChats(url.searchParams.get("q") ?? ""));
route("GET", "/api/tool-groups", () => Object.entries(TOOL_GROUPS).map(([id, g]) => ({ id, label: g.label })));
route("POST", "/api/chats/:chatId/rename", (_r, body, p) => rt().chats.update(p.chatId, { title: body.title !== undefined ? String(body.title) : undefined, emoji: body.emoji }));
route("POST", "/api/chats", (_r, body) => {
  if (!(body.mode in CHAT_MODES)) throw new BiruniError("INVALID_REQUEST", "unknown chat mode");
  return rt().conversation.newChat(body.mode as ChatMode, body.tripId || undefined, body.title, body.custom, body.emoji);
});
route("GET", "/api/chats/:chatId", (_r, _b, p) => {
  const chat = rt().chats.get(p.chatId);
  if (!chat) throw new BiruniError("INVALID_REQUEST", "unknown chat");
  return { chat, messages: rt().chats.messages(p.chatId) };
});
route("POST", "/api/chats/:chatId/messages", (_r, body, p) => rt().conversation.send(p.chatId, String(body.text ?? ""), { targetLanguage: body.targetLanguage, sourceLanguage: body.sourceLanguage }));
route("POST", "/api/chats/:chatId/trip", (_r, body, p) => rt().chats.update(p.chatId, { tripId: body.tripId || undefined }));
route("POST", "/api/chats/:chatId/delete", (_r, _b, p) => (rt().chats.remove(p.chatId), { ok: true }));

// ---------- memory graph (graphify format) ----------
route("GET", "/api/memory/graph", () => rt().memory.exportGraphify());
route("GET", "/api/memory/report", () => ({ markdown: rt().memory.report() }));
route("GET", "/api/memory/recall", (_r, _b, _p, url) => rt().memory.search(url.searchParams.get("q") ?? ""));
route("POST", "/api/memory/export", async () => {
  const dir = process.env.MEMORY_OUT_DIR || "memory-out";
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "graph.json"), JSON.stringify(rt().memory.exportGraphify(), null, 2));
  await writeFile(join(dir, "GRAPH_REPORT.md"), rt().memory.report());
  return { written: [join(dir, "graph.json"), join(dir, "GRAPH_REPORT.md")] };
});

// ---------- translation & voice ----------
route("GET", "/api/languages", () => LANGUAGES.map((l) => ({ ...l, gnaniVoice: l.gnani && rt().voice.live })));
route("POST", "/api/translate", (_r, body) => rt().conversation.translate(String(body.text ?? ""), body.from ?? "auto", body.to ?? "hi-IN"));
route("POST", "/api/voice/translate", (_r, body) => rt().conversation.voiceTranslate({ text: body.text, audioBase64: body.audioBase64, mime: body.mime, from: body.from ?? "auto", to: body.to ?? "hi-IN" }));
route("POST", "/api/voice/tts", (_r, body) => rt().voice.synthesize(String(body.text ?? "").slice(0, 1000), body.language ?? "en-IN"));
route("POST", "/api/voice/stt", (_r, body) => rt().voice.transcribe({ audioBase64: body.audioBase64, mime: body.mime, text: body.text }, body.language ?? "en-IN"));
}

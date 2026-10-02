// Separate chats per function, each with its own purpose and toolset.
// Messages persist in the DB; long-term facts go to the shared memory graph.
import type { Store } from "../../packages/db";
import { id, nowIso } from "../../packages/shared";

export type ChatMode = "general" | "recovery" | "translate" | "splitwise" | "discover" | "maps" | "calendar" | "budget" | "custom";

const CORE = ["get_trip_status", "remember", "recall_memory", "speak"];
const RECOVERY = ["report_disruption", "approve_pending", "decline_pending", "undo_last_action", "mark_verified_way_home", "search_alternative_routes"];
const ACTIVITIES = ["add_activity", "update_activity", "remove_activity"];
const EXPENSES = ["add_expense", "list_expenses", "get_balances", "settle_up", "remove_expense", "splitwise_groups", "splitwise_push"];
const CAL = ["calendar_list_events", "calendar_add_event"];
const MAPS = ["where_am_i", "find_place", "nearby_places", "directions"];

export const CHAT_MODES: Record<ChatMode, { label: string; icon: string; prompt: string; tools: string[] }> = {
  general: {
    label: "General assistant",
    icon: "✦",
    prompt: "Handle anything about the trip; use any tool.",
    tools: [...CORE, ...RECOVERY, ...ACTIVITIES, ...EXPENSES, ...CAL, ...MAPS, "get_budget", "discover_places"],
  },
  recovery: {
    label: "Disruption recovery",
    icon: "⚠",
    prompt: "Focus on getting the traveller moving again after a disruption. Report disruptions immediately; explain what Biruni booked, the undo window, and anything waiting for approval.",
    tools: [...CORE, ...RECOVERY, "get_budget", ...MAPS],
  },
  translate: {
    label: "Translator",
    icon: "文",
    prompt:
      "You are an interpreter. Translate ONLY the traveller's latest message, faithfully and exactly — never answer it, never reuse earlier sentences. Target language: the one named in the latest message; else the last target they asked for in this chat; else Hindi if the message is English, English otherwise. Reply with: the translation in native script, then a line with Latin-script pronunciation, then (only if useful) one line on politeness or local usage. Nothing else. If they ask to hear it, call speak with the translation and the right BCP-47 code.",
    tools: ["speak", "remember", "recall_memory"],
  },
  splitwise: {
    label: "Split expenses",
    icon: "₹",
    prompt: "Track group expenses like Splitwise. Earlier expenses in this chat are ALREADY saved: record only new expenses from the latest message. Record each expense with who paid and who shares it, keep balances, and suggest the fewest transfers to settle up. Use 'Me' for the traveller. Confirm amounts in ₹.",
    tools: [...EXPENSES, "remember", "recall_memory"],
  },
  discover: {
    label: "Discover places",
    icon: "◎",
    prompt: "Find lesser-known places, food and tips using Reddit, YouTube and OpenStreetMap; summarise briefly with why each is worth it, and offer to add picks to the trip.",
    tools: [...CORE, "discover_places", ...ACTIVITIES, ...MAPS],
  },
  maps: {
    label: "Maps & location",
    icon: "⌖",
    prompt: "Help with where the traveller is, what is nearby (ATMs, hospitals, food, police, transport) and how to get places, using OpenStreetMap data and their live location.",
    tools: [...CORE, ...MAPS, "add_activity"],
  },
  calendar: {
    label: "Calendar & plans",
    icon: "▦",
    prompt: "Manage the traveller's plans and Google Calendar: read upcoming events, add trip plans, flag clashes with the itinerary.",
    tools: [...CORE, ...CAL, ...ACTIVITIES],
  },
  custom: {
    label: "Custom chat",
    icon: "✎",
    prompt: "Follow the traveller's own instructions for this chat.",
    tools: [...CORE],
  },
  budget: {
    label: "Budget & money",
    icon: "◈",
    prompt: "Explain the traveller's recovery authority, free balance after protected obligations, and group expenses. Never suggest touching protected money or selling investments.",
    tools: [...CORE, "get_budget", "list_expenses", "get_balances"],
  },
};

/** Tool groups a custom chat can enable. */
export const TOOL_GROUPS: Record<string, { label: string; tools: string[] }> = {
  trip: { label: "Trip status & disruption recovery", tools: ["get_trip_status", ...RECOVERY] },
  plans: { label: "Plans & activities", tools: ACTIVITIES },
  expenses: { label: "Split expenses", tools: EXPENSES },
  maps: { label: "Maps & live location", tools: MAPS },
  calendar: { label: "Calendar", tools: CAL },
  discover: { label: "Discover places (Reddit/YouTube)", tools: ["discover_places"] },
  budget: { label: "Budget & obligations", tools: ["get_budget"] },
  voice: { label: "Speak aloud", tools: ["speak"] },
};

export type CustomSpec = { instructions: string; groups: string[] };
export type Chat = { chatId: string; mode: ChatMode; title: string; tripId?: string; custom?: CustomSpec; createdAt: string; updatedAt: string };

/** Tools and prompt for a chat, including custom chats. */
export function chatProfile(chat: Chat): { label: string; prompt: string; tools: string[] } {
  const base = CHAT_MODES[chat.mode] ?? CHAT_MODES.general;
  if (chat.mode !== "custom" || !chat.custom) return base;
  const tools = new Set(["remember", "recall_memory", ...chat.custom.groups.flatMap((g) => TOOL_GROUPS[g]?.tools ?? [])]);
  return { label: chat.title, prompt: `The traveller set up this chat with these instructions — follow them: """${chat.custom.instructions.slice(0, 2000)}"""`, tools: [...tools] };
}
export type StoredMessage = { messageId: string; chatId: string; role: "user" | "assistant"; text: string; at: string; source?: string; tools?: string[]; copiedFrom?: string };

export class Chats {
  constructor(private store: Store) {}

  create(mode: ChatMode, tripId?: string, title?: string, custom?: CustomSpec): Chat {
    if (!CHAT_MODES[mode]) throw new Error(`unknown chat mode ${mode}`);
    if (mode === "custom") {
      if (!custom?.instructions?.trim()) throw new Error("a custom chat needs instructions");
      custom = { instructions: custom.instructions.trim().slice(0, 2000), groups: (custom.groups ?? []).filter((g) => g in TOOL_GROUPS) };
    }
    const c: Chat = { chatId: id("CHAT"), mode, title: title?.trim().slice(0, 60) || CHAT_MODES[mode].label, tripId, custom: mode === "custom" ? custom : undefined, createdAt: nowIso(), updatedAt: nowIso() };
    this.store.put("chats", c.chatId, c, { tripId, key: mode });
    return c;
  }

  get(chatId: string) {
    return this.store.get<Chat>("chats", chatId);
  }

  /** Most recent chat of a mode for this trip (or with no trip). */
  findLatest(mode: ChatMode, tripId?: string) {
    return this.list().find((c) => c.mode === mode && (c.tripId ?? "") === (tripId ?? ""));
  }

  list(): Chat[] {
    return this.store.list<Chat>("chats").sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  update(chatId: string, patch: Partial<Pick<Chat, "title" | "tripId">>) {
    if (patch.title !== undefined) patch.title = patch.title.trim().slice(0, 60) || undefined;
    const c = this.get(chatId);
    if (!c) throw new Error("unknown chat");
    const next = { ...c, ...patch, updatedAt: nowIso() };
    this.store.put("chats", chatId, next, { tripId: next.tripId, key: next.mode });
    return next;
  }

  remove(chatId: string) {
    for (const m of this.messages(chatId)) this.store.delete("chat_messages", m.messageId);
    this.store.delete("chats", chatId);
  }

  add(chatId: string, m: Omit<StoredMessage, "messageId" | "chatId" | "at">): StoredMessage {
    const msg: StoredMessage = { messageId: id("MSG"), chatId, at: nowIso(), ...m };
    this.store.put("chat_messages", msg.messageId, msg, { key: chatId });
    const c = this.get(chatId);
    if (c) {
      const title = c.mode !== "custom" && !m.copiedFrom && c.title === CHAT_MODES[c.mode].label && m.role === "user" ? m.text.slice(0, 48) : c.title;
      this.store.put("chats", chatId, { ...c, title, updatedAt: nowIso() }, { tripId: c.tripId, key: c.mode });
    }
    return msg;
  }

  messages(chatId: string): StoredMessage[] {
    return this.store.list<StoredMessage>("chat_messages", { key: chatId });
  }
}

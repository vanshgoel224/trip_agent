// Composition root: wires store, rails, MCP server, specialists and orchestrator.
import { Store } from "../packages/db";
import type { Cipher } from "../packages/db/vault";
import { config } from "../packages/shared";
import { createProviders, type Providers } from "./integrations";
import { seedVendors } from "./integrations/simulator";
import { FinanceAgent } from "./agents/finance";
import { ComplianceAgent } from "./agents/compliance";
import { VoiceAgent } from "./agents/voice";
import { TravelAgent } from "./agents/travel";
import { BookingAgent } from "./agents/booking";
import { RecoveryAgent } from "./agents/recovery";
import { UndoManager } from "./agents/recovery/undo";
import { BiruniMcpServer } from "./mcp/server";
import { mcpClientFor } from "./mcp/client";
import { ModelRouter } from "./models";
import { Orchestrator } from "./orchestrator";
import { ChatAgent } from "./orchestrator/chat-agent";
import { Chats } from "./orchestrator/chats";
import { ExpenseAgent } from "./agents/expenses";
import { MemoryGraph } from "./memory";
import { Devices } from "./devices";
import { McpConnections } from "./mcp-client";
import { Conversation } from "./conversation";
import { Delhivery } from "./integrations/delhivery";
import { PartnerHub } from "./integrations/partners";
import { OperatorFeed } from "./feed";
import { Telephony } from "./telephony";
import { Style } from "./style";
import { Autopilot } from "./autopilot";
import { ModelSettings } from "./models/settings";
import { Feedback } from "./feedback";
import { Negotiator } from "./negotiator";
import { GoogleCalendar } from "./integrations/google-calendar";
import { inr } from "../packages/shared";

export type Biruni = ReturnType<typeof createBiruni>;

export function createBiruni(opts: { dbPath?: string; undoWindowMs?: number; providers?: Providers; cipher?: Cipher; context?: <T>(fn: () => T) => T } = {}) {
  const store = new Store(opts.dbPath ?? ":memory:", opts.cipher);
  if (opts.cipher) store.encryptAll(); // migrate rows written before the PIN existed
  const providers = opts.providers ?? createProviders();
  seedVendors();

  const finance = new FinanceAgent(store);
  const compliance = new ComplianceAgent(store);
  const mcp = new BiruniMcpServer(store, providers, finance, compliance);
  finance.attach(mcpClientFor(mcp, "finance"));

  const voice = new VoiceAgent(store, mcpClientFor(mcp, "voice"), providers.voice);
  const travel = new TravelAgent(store, mcpClientFor(mcp, "travel"));
  const booking = new BookingAgent(store, mcpClientFor(mcp, "booking"));
  const undo = new UndoManager(store, opts.undoWindowMs ?? config.undoWindowMs);
  const models = new ModelRouter();
  const recovery = new RecoveryAgent(store, mcpClientFor(mcp, "recovery"), { finance, travel, booking, voice, models, undo });
  undo.bind({
    onExpire: async (u) => void (await recovery.onUndoExpired(u)),
    onCancel: async (u) => void (await recovery.onUndoCancelled(u)),
  });

  const orchestrator = new Orchestrator(store, { finance, recovery, travel, voice, undo, models });
  const rehydrated = undo.rehydrate();

  // Conversational layer
  const memory = new MemoryGraph(store);
  const expenses = new ExpenseAgent(store);
  const chats = new Chats(store);
  const devices = new Devices(store);
  devices.bind({
    escalate: (tripId, description) => orchestrator.reportDisruption(tripId, description),
    ask: (tripId, text) => voice.say(tripId, text, { kind: "CHECKIN" }),
  });
  const mcpClients = new McpConnections(store);
  const delhivery = new Delhivery(store);
  const partners = new PartnerHub(store);
  const feedback = new Feedback(store);
  const negotiator = new Negotiator(store);
  const chatAgent = new ChatAgent({ store, orchestrator, travel, booking, finance, expenses, memory, voice, chats, mcpClients, devices, delhivery, feedback, negotiator, partners });
  // A confirmed deal is recorded where the traveller will look for it.
  negotiator.onConfirmed(async (d) => {
    const done: string[] = [];
    const ist = new Date(Date.now() + 5.5 * 3600_000).toISOString();
    const date = (d.details.checkin ?? d.details.date ?? ist).slice(0, 10);
    const time = d.kind === "hotel" ? d.details.time ?? "14:00" : d.details.time ?? ist.slice(11, 16);
    const title = d.kind === "hotel" ? `Stay: ${d.counterparty.name} — ${d.goal}` : `${d.kind === "auto" ? "Auto" : "Taxi"} with ${d.counterparty.name} — ${d.goal}`;
    if (d.tripId) {
      booking.addActivity(d.tripId, { date, time, title, location: d.details.place ?? d.details.drop, cost: d.agreedPrice, notes: `Agreed ${inr(d.agreedPrice!)} by negotiation (${d.channel}); pay directly. Deal ${d.dealId}` });
      done.push("trip plans");
    }
    if (d.kind === "hotel") {
      memory.remember({ subject: "Me", subject_type: "traveller", relation: "booked stay at", object: d.counterparty.name, object_type: "place" }, d.dealId, "EXTRACTED");
      done.push("memory");
    }
    if (new GoogleCalendar(store).status().canWrite) {
      try {
        await new GoogleCalendar(store).add({ title, start: `${date}T${time}:00+05:30`, location: d.details.place, description: `Agreed ${inr(d.agreedPrice!)} via Biruni negotiator` });
        done.push("calendar");
      } catch {
        /* calendar optional */
      }
    }
    return done;
  });
  const modelSettings = new ModelSettings(store);
  const autopilot = new Autopilot({ store, orchestrator, voice, devices, runWithModels: (fn) => (opts.context ?? ((f) => f()))(() => modelSettings.run(fn)) });
  const telephony = new Telephony({ negotiator });
  const style = new Style(store);
  chatAgent.style = style;
  negotiator.telephony = telephony;
  const feed = new OperatorFeed({ store, autopilot, partners });
  autopilot.feedPoll = (tripId) => feed.poll(tripId);
  chatAgent.feed = feed;
  chatAgent.autopilotTick = (tripId) => autopilot.tick(tripId);
  const conversation = new Conversation({ store, orchestrator, chats, chatAgent, memory, voice, models });

  return {
    store, providers, mcp, finance, compliance, voice, travel, booking, recovery, undo, models, orchestrator, rehydrated,
    memory, expenses, chats, devices, mcpClients, chatAgent, conversation, delhivery, autopilot, feedback, negotiator, modelSettings, partners, feed, telephony, style,
    shutdown() {
      autopilot.stop();
      undo.stopAll();
      devices.stopAll();
      store.close();
    },
  };
}

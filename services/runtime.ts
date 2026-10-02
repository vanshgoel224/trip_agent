// Composition root: wires store, rails, MCP server, specialists and orchestrator.
import { Store } from "../packages/db";
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
import { Autopilot } from "./autopilot";
import { Feedback } from "./feedback";

export type Biruni = ReturnType<typeof createBiruni>;

export function createBiruni(opts: { dbPath?: string; undoWindowMs?: number; providers?: Providers } = {}) {
  const store = new Store(opts.dbPath ?? ":memory:");
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
  const feedback = new Feedback(store);
  const chatAgent = new ChatAgent({ store, orchestrator, travel, booking, finance, expenses, memory, voice, chats, mcpClients, devices, delhivery, feedback });
  const autopilot = new Autopilot({ store, orchestrator, voice, devices });
  const conversation = new Conversation({ store, orchestrator, chats, chatAgent, memory, voice, models });

  return {
    store, providers, mcp, finance, compliance, voice, travel, booking, recovery, undo, models, orchestrator, rehydrated,
    memory, expenses, chats, devices, mcpClients, chatAgent, conversation, delhivery, autopilot, feedback,
    shutdown() {
      autopilot.stop();
      undo.stopAll();
      devices.stopAll();
      store.close();
    },
  };
}

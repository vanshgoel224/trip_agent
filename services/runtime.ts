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

export type Biruni = ReturnType<typeof createBiruni>;

export function createBiruni(opts: { dbPath?: string; undoWindowMs?: number; providers?: Providers } = {}) {
  const store = new Store(opts.dbPath ?? ":memory:");
  const providers = opts.providers ?? createProviders();
  seedVendors();

  const finance = new FinanceAgent(store);
  const compliance = new ComplianceAgent(store);
  const mcp = new BiruniMcpServer(store, providers, finance, compliance);
  finance.attach(mcpClientFor(mcp, "finance"));

  const voice = new VoiceAgent(store, mcpClientFor(mcp, "voice"));
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

  return {
    store, providers, mcp, finance, compliance, voice, travel, booking, recovery, undo, models, orchestrator, rehydrated,
    shutdown() {
      undo.stopAll();
      store.close();
    },
  };
}

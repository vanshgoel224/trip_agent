// Remote MCP endpoint: lets an MCP client (Claude, an IDE, another agent) use a hosted
// Biruni over Streamable HTTP at /mcp. Stateless: a fresh MCP server per request.
// It exposes the agent, not the payment rails: money still only moves through the
// orchestrator under the ₹2,000 / daily-ceiling / obligation policy.
// Auth: Authorization: Bearer <BIRUNI_MCP_TOKEN>. No token configured → endpoint off.
import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import type { Biruni } from "../runtime";
import { CHAT_MODES, type ChatMode } from "../orchestrator/chats";

export const remoteMcpEnabled = () => (process.env.BIRUNI_MCP_TOKEN ?? "").length >= 24;

export function authorized(req: IncomingMessage) {
  const want = Buffer.from(`Bearer ${process.env.BIRUNI_MCP_TOKEN ?? ""}`);
  const got = Buffer.from(String(req.headers.authorization ?? ""));
  return remoteMcpEnabled() && got.length === want.length && timingSafeEqual(got, want);
}

const text = (v: unknown) => ({ content: [{ type: "text" as const, text: typeof v === "string" ? v : JSON.stringify(v, null, 2) }] });

function build(b: Biruni) {
  const s = new McpServer({ name: "biruni", version: "0.2.0" });
  s.registerTool(
    "biruni_chat",
    {
      description: "Send a message to Biruni, the Indian travel-recovery agent, and get its reply. It can check trip status, recover from cancellations (bounded to ₹2,000 per incident, 30 s undo), translate, split bills, find places, give directions and remember facts. Pass chatId to continue a conversation.",
      inputSchema: { text: z.string().min(1).max(4000), chatId: z.string().optional(), tripId: z.string().optional(), mode: z.enum(Object.keys(CHAT_MODES) as [ChatMode, ...ChatMode[]]).optional() },
    },
    async ({ text: t, chatId, tripId, mode }) => {
      const chat = chatId ? b.chats.get(chatId) : undefined;
      const id = chat?.chatId ?? b.conversation.newChat(mode ?? "general", tripId).chatId;
      const r = await b.modelSettings.run(() => b.conversation.send(id, t));
      return text({ chatId: id, reply: r.message.text, source: r.source, tools: r.tools });
    },
  );
  s.registerTool("biruni_trips", { description: "List the traveller's trips with their status.", inputSchema: {} }, async () =>
    text(b.store.list<any>("trips").map((t) => ({ tripId: t.tripId, status: t.status, from: t.itinerary?.legs?.[0]?.from, to: t.itinerary?.legs?.at(-1)?.to }))),
  );
  s.registerTool("biruni_trip_status", { description: "Full status of one trip: itinerary, open incident, authority used, pending approvals.", inputSchema: { tripId: z.string() } }, async ({ tripId }) => text(b.orchestrator.snapshot(tripId)));
  return s;
}

export async function handleRemoteMcp(b: Biruni, req: IncomingMessage, res: ServerResponse, body: unknown) {
  const server = build(b);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on("close", () => void (transport.close(), server.close()));
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
}

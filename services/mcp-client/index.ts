// Connect Biruni's chat agent to EXTERNAL MCP servers (the reverse of
// services/mcp, which is Biruni's own server). Their tools are offered to the
// General chat as ext__<server>__<tool>.
// Security:
//  - The UI can only add HTTP(S) MCP servers. Local stdio servers (which run a
//    command) can only come from the server-side env BIRUNI_MCP_SERVERS.
//  - External tools never get money, booking, or approval powers; they are just
//    extra tools the model may call, and their output is treated as untrusted data.
import { BiruniError } from "../../packages/shared";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Store } from "../../packages/db";
import { id, nowIso } from "../../packages/shared";
import { bus } from "../../packages/events";
import type { ToolSpec } from "../models";

export type McpServerConfig = {
  serverId: string;
  name: string;
  transport: "http" | "sse" | "stdio";
  url?: string;
  headers?: Record<string, string>; // e.g. Authorization; kept server-side, never returned to the browser
  command?: string;
  args?: string[];
  source: "ui" | "env";
  createdAt: string;
};

type Live = { client: Client; tools: { name: string; description?: string; inputSchema: any }[]; error?: string };

const safe = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 24);

export class McpConnections {
  private live = new Map<string, Live>();
  private errors = new Map<string, string>();

  constructor(private store: Store) {
    // Env-configured servers (stdio allowed here only).
    try {
      const env = JSON.parse(process.env.BIRUNI_MCP_SERVERS || "[]") as Partial<McpServerConfig>[];
      for (const e of env) {
        if (!e.name || !e.transport) continue;
        const serverId = `ENV-${safe(e.name)}`;
        this.store.put("mcp_servers", serverId, { ...e, serverId, source: "env", createdAt: nowIso() });
      }
    } catch {
      /* ignore malformed env */
    }
  }

  configs() {
    return this.store.list<McpServerConfig>("mcp_servers");
  }

  /** Public view: never exposes headers/secrets. */
  list() {
    return this.configs().map((c) => ({
      serverId: c.serverId, name: c.name, transport: c.transport, url: c.url, command: c.command, source: c.source,
      connected: this.live.has(c.serverId), error: this.errors.get(c.serverId),
      tools: this.live.get(c.serverId)?.tools.map((t) => t.name) ?? [],
    }));
  }

  async add(input: { name: string; url: string; transport?: "http" | "sse"; headers?: Record<string, string> }) {
    let u: URL;
    try {
      u = new URL(String(input?.url ?? ""));
    } catch {
      throw new BiruniError("INVALID_REQUEST", "MCP server URL is not a valid URL");
    }
    if (!/^https?:$/.test(u.protocol)) throw new BiruniError("INVALID_REQUEST", "Only http(s) MCP servers can be added from the UI");
    if (input.headers !== undefined && (typeof input.headers !== "object" || Object.values(input.headers).some((v) => typeof v !== "string"))) throw new BiruniError("INVALID_REQUEST", "headers must be strings");
    const cfg: McpServerConfig = { serverId: id("MCPS"), name: safe(input.name || u.hostname), transport: input.transport ?? "http", url: u.toString(), headers: input.headers, source: "ui", createdAt: nowIso() };
    this.store.put("mcp_servers", cfg.serverId, cfg);
    await this.connect(cfg.serverId);
    return this.list().find((s) => s.serverId === cfg.serverId);
  }

  async remove(serverId: string) {
    await this.live.get(serverId)?.client.close().catch(() => {});
    this.live.delete(serverId);
    this.errors.delete(serverId);
    this.store.delete("mcp_servers", serverId);
  }

  async connect(serverId: string) {
    const cfg = this.store.get<McpServerConfig>("mcp_servers", serverId);
    if (!cfg) throw new Error("unknown MCP server");
    try {
      const client = new Client({ name: "biruni", version: "0.1.0" });
      const transport =
        cfg.transport === "stdio"
          ? (() => {
              if (cfg.source !== "env") throw new Error("stdio servers are only allowed from server env config");
              return new StdioClientTransport({ command: cfg.command!, args: cfg.args ?? [] });
            })()
          : cfg.transport === "sse"
            ? new SSEClientTransport(new URL(cfg.url!), { requestInit: { headers: cfg.headers } })
            : new StreamableHTTPClientTransport(new URL(cfg.url!), { requestInit: { headers: cfg.headers } });
      await client.connect(transport);
      const { tools } = await client.listTools();
      this.live.set(serverId, { client, tools });
      this.errors.delete(serverId);
      bus.emitEvent({ tripId: "*", agent: "mcp-client", type: "MCP_CONNECTED", detail: `${cfg.name}: ${tools.length} tools` });
    } catch (e) {
      this.errors.set(serverId, e instanceof Error ? e.message : String(e));
      throw e;
    }
  }

  async connectAll() {
    await Promise.all(this.configs().map((c) => this.connect(c.serverId).catch(() => {})));
  }

  /** Tool specs for the chat model. */
  toolSpecs(): ToolSpec[] {
    const out: ToolSpec[] = [];
    for (const c of this.configs()) {
      const l = this.live.get(c.serverId);
      for (const t of l?.tools ?? []) {
        out.push({
          type: "function",
          function: {
            name: `ext__${safe(c.name)}__${safe(t.name)}`.slice(0, 64),
            description: `[External MCP server "${c.name}", untrusted] ${(t.description ?? "").slice(0, 300)}`,
            parameters: t.inputSchema && t.inputSchema.type === "object" ? t.inputSchema : { type: "object", properties: {} },
          },
        });
      }
    }
    return out;
  }

  async call(fnName: string, args: Record<string, unknown>) {
    for (const c of this.configs()) {
      const l = this.live.get(c.serverId);
      const t = l?.tools.find((x) => `ext__${safe(c.name)}__${safe(x.name)}`.slice(0, 64) === fnName);
      if (l && t) {
        const r = await l.client.callTool({ name: t.name, arguments: args });
        const text = (r.content as any[] | undefined)?.map((x) => (x.type === "text" ? x.text : `[${x.type}]`)).join("\n") ?? JSON.stringify(r);
        return { server: c.name, tool: t.name, isError: !!r.isError, untrustedOutput: text.slice(0, 5000) };
      }
    }
    throw new Error(`no connected MCP tool ${fnName}`);
  }
}

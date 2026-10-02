import type { AgentName, ToolResult } from "../../packages/domain";
import { serviceToken } from "./middleware";
import type { BiruniMcpServer, CallContext } from "./server";
import type { ToolName } from "./schemas";

/** An agent's handle on the MCP server, bound to its own identity and service token. */
export type AgentMcp = {
  agent: AgentName;
  call(tool: ToolName, args: Record<string, unknown>, opts?: { approval?: CallContext["approval"] }): Promise<ToolResult>;
};

export function mcpClientFor(server: BiruniMcpServer, agent: AgentName): AgentMcp {
  const token = serviceToken(agent);
  return { agent, call: (tool, args, opts) => server.call(tool, args, { agent, token, approval: opts?.approval }) };
}

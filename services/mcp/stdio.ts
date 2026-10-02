// Exposes the seven Biruni tools over the Model Context Protocol (stdio) for
// development and inspection (e.g. with an MCP inspector). Every call still
// runs the full Biruni pipeline. The caller identity is fixed by env:
//   BIRUNI_MCP_AGENT=recovery npm run mcp:stdio
// In the product, the MCP server stays behind the backend (spec §23).
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { AgentName } from "../../packages/domain";
import { config } from "../../packages/shared";
import { createBiruni } from "../runtime";
import { serviceToken } from "./middleware";
import { TOOL_NAMES, schemas } from "./schemas";
import { TOOLS } from "./tools";

const agent = (process.env.BIRUNI_MCP_AGENT ?? "recovery") as AgentName;
const b = createBiruni({ dbPath: config.dbPath });
const server = new McpServer({ name: "biruni", version: "0.1.0" });

for (const name of TOOL_NAMES) {
  const def = TOOLS[name];
  server.registerTool(
    name,
    { description: `[PROVISIONAL NAME] ${def.description} Rail: ${def.rail}.`, inputSchema: schemas[name] as any },
    async (args: unknown) => {
      const result = await b.mcp.call(name, args, { agent, token: serviceToken(agent) });
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }], isError: !result.success };
    },
  );
}

await server.connect(new StdioServerTransport());

import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mcpToolNames } from "../src/mcp/contracts.js";

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.resolve("node_modules", "tsx", "dist", "cli.mjs"), path.resolve("scripts", "arca-mcp.mts")],
  stderr: "pipe",
});
const client = new Client({ name: "arca-mcp-smoke", version: "1.0.0" });
try {
  await client.connect(transport);
  const tools = await client.listTools();
  const names = tools.tools.map((tool) => tool.name).sort();
  const expected = [...mcpToolNames].sort();
  if (JSON.stringify(names) !== JSON.stringify(expected)) throw new Error(`Herramientas MCP inesperadas: ${names.join(", ")}`);
  console.log(`MCP_TOOLS_OK=${names.length}`);
} finally {
  await client.close();
}

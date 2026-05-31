import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadEnv } from "@naruto5e/shared";
import { EngineClient } from "./client.js";
import { registerTools } from "./tools.js";

export { EngineClient } from "./client.js";
export { registerTools } from "./tools.js";

/**
 * Build the MCP server (tier 2) pointed at an engine REST base URL.
 * Stateless: holds only the engine URL.
 */
export function buildController(engineUrl: string): { server: McpServer; client: EngineClient } {
  const client = new EngineClient(engineUrl);
  const server = new McpServer({ name: "naruto5e-mcp-controller", version: "0.1.0" });
  registerTools(server, client);
  return { server, client };
}

async function main(): Promise<void> {
  loadEnv(); // populate process.env from repo-root .env (OpenAI key, models, engine URL)
  const engineUrl = process.env.NARUTO_ENGINE_URL ?? "http://localhost:8970";
  const { server } = buildController(engineUrl);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // eslint-disable-next-line no-console
  console.error(`naruto5e MCP controller -> engine ${engineUrl}`);
}

// Run as a stdio server only when invoked directly.
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("index.ts")) {
  main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error("mcp controller failed", err);
    process.exit(1);
  });
}

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildMcpServer } from "./server.ts";

const server = buildMcpServer();
const transport = new StdioServerTransport();
await server.connect(transport);
// Process stays alive until the parent agent closes stdin.

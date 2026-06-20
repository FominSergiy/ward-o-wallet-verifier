import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { type Category, CategorySchema } from "../agent/types.ts";
import { verifyAgent } from "../agent/verify.ts";
import { type VerdictCache } from "../agent/verdict_cache.ts";

interface VerifyWalletArgs {
  address: string;
  budgetCeiling?: number;
  categories?: Category[];
}

// Transport-agnostic factory. Both `stdio.ts` and `http.ts` mount the same
// tool surface against different transports.
export function buildMcpServer(verdictCache?: VerdictCache): McpServer {
  const server = new McpServer({
    name: "ward-o-wallet-verifier",
    version: "0.1.0",
  });

  server.registerTool(
    "verify_wallet",
    {
      title: "Verify wallet risk",
      description:
        "Run the full Ward-o wallet risk pipeline: discover x402 risk " +
        "services, pay for them, and synthesize a verdict " +
        "(safe_to_transact | do_not_transact | insufficient_data). " +
        "Costs ~$0.01-$0.05 USDC per call. Set budgetCeiling to cap spend.",
      inputSchema: {
        address: z
          .string()
          .regex(/^0x[0-9a-fA-F]{40}$/, "Must be a valid EVM address"),
        budgetCeiling: z.number().positive().optional(),
        categories: z.array(CategorySchema).optional(),
      },
    },
    async (
      { address, budgetCeiling, categories }: VerifyWalletArgs,
    ) => {
      const result = await verifyAgent(
        { address },
        { budgetCeiling, categories, verdictCache },
      );
      return {
        content: [
          { type: "text", text: JSON.stringify(result.verdict, null, 2) },
        ],
        structuredContent: result.verdict as unknown as Record<string, unknown>,
      };
    },
  );

  return server;
}

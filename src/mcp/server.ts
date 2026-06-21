import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { type Category, CategorySchema } from "../agent/types.ts";
import { verifyAgent, type VerifyAgentResult } from "../agent/verify.ts";
import { type VerdictCache } from "../agent/verdict_cache.ts";
import { type SanctionedDenylist } from "../agent/sanctioned_denylist.ts";

interface VerifyWalletArgs {
  address: string;
  budgetCeiling?: number;
  categories?: Category[];
  depth?: "fast" | "deep";
}

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

// Build the tool result. For a fast-tier "needs_deep_check" outcome we attach a
// deepCheckToken (the address) so the agent can opt into the paid deep verdict
// via the get_deep_verdict tool — the early-return / async shape.
export function formatResult(
  result: VerifyAgentResult,
): {
  content: { type: "text"; text: string }[];
  structuredContent: Record<string, unknown>;
} {
  const structured: Record<string, unknown> = {
    ...result.verdict,
    tier: result.tier,
    fastSignal: result.fastSignal,
    totalSpentUsdc: result.totalSpentUsdc,
  };
  if (result.fastSignal === "needs_deep_check") {
    structured.deepCheck = {
      available: true,
      deepCheckToken: result.verdict.address,
      hint: "No blocking signal found by the free fast tier. For a final " +
        "safe/unsafe verdict, call get_deep_verdict with this deepCheckToken " +
        "(or re-run verify_wallet with depth='deep'). The deep tier costs " +
        "~$0.01-$0.05 USDC.",
    };
  }
  return {
    content: [{ type: "text", text: JSON.stringify(structured, null, 2) }],
    structuredContent: structured,
  };
}

// Transport-agnostic factory. Both `stdio.ts` and `http.ts` mount the same
// tool surface against different transports.
export function buildMcpServer(
  verdictCache?: VerdictCache,
  denylist?: SanctionedDenylist,
): McpServer {
  const server = new McpServer({
    name: "ward-o-wallet-verifier",
    version: "0.1.0",
  });

  server.registerTool(
    "verify_wallet",
    {
      title: "Verify wallet risk",
      description:
        "Two-tier wallet risk check. depth='fast' (default) runs ONLY the free " +
        "sanctions gate (denylist + Chainalysis on-chain oracle) and returns in " +
        "<1s with ZERO spend — fastSignal is 'block' (sanctioned), 'proceed' " +
        "(cached-safe), or 'needs_deep_check'. depth='deep' runs the full paid " +
        "pipeline (x402 risk services + LLM synthesis, ~$0.01-$0.05 USDC) for a " +
        "final safe_to_transact | do_not_transact | insufficient_data verdict. " +
        "On a 'needs_deep_check' result a deepCheckToken is returned; pass it to " +
        "get_deep_verdict to run the paid check. Set budgetCeiling to cap spend.",
      inputSchema: {
        address: z
          .string()
          .regex(ADDRESS_RE, "Must be a valid EVM address"),
        depth: z.enum(["fast", "deep"]).optional(),
        budgetCeiling: z.number().positive().optional(),
        categories: z.array(CategorySchema).optional(),
      },
    },
    async (
      { address, budgetCeiling, categories, depth }: VerifyWalletArgs,
    ) => {
      const result = await verifyAgent(
        { address },
        {
          budgetCeiling,
          categories,
          depth: depth ?? "fast",
          verdictCache,
          denylist,
        },
      );
      return formatResult(result);
    },
  );

  server.registerTool(
    "get_deep_verdict",
    {
      title: "Run the paid deep wallet verdict",
      description:
        "Run the full paid Ward-o pipeline for an address (x402 risk services + " +
        "LLM synthesis, ~$0.01-$0.05 USDC) and return a final verdict. Pass the " +
        "deepCheckToken returned by verify_wallet (it is the wallet address). " +
        "Use this after a fast-tier 'needs_deep_check' result.",
      inputSchema: {
        deepCheckToken: z
          .string()
          .regex(
            ADDRESS_RE,
            "Must be a valid EVM address (the deepCheckToken)",
          ),
        budgetCeiling: z.number().positive().optional(),
        categories: z.array(CategorySchema).optional(),
      },
    },
    async (
      { deepCheckToken, budgetCeiling, categories }: {
        deepCheckToken: string;
        budgetCeiling?: number;
        categories?: Category[];
      },
    ) => {
      const result = await verifyAgent(
        { address: deepCheckToken },
        { budgetCeiling, categories, depth: "deep", verdictCache, denylist },
      );
      return formatResult(result);
    },
  );

  return server;
}

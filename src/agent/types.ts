import { z } from "zod";

export const ChainSchema = z.enum(["eth", "base", "polygon", "arbitrum", "optimism"]);
export type Chain = z.infer<typeof ChainSchema>;

export const VerifyRequestSchema = z.object({
  address: z.string().regex(/^0x[0-9a-fA-F]{40}$/, "Must be a valid EVM address"),
  chain: ChainSchema,
});
export type VerifyRequest = z.infer<typeof VerifyRequestSchema>;

export const CategorySchema = z.enum([
  "sanctions",
  "labels",
  "onchain_history",
  "web_sentiment",
  "ens",
  "contract_analysis",
]);
export type Category = z.infer<typeof CategorySchema>;

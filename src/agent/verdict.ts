import { z } from "zod";
import { CategorySchema, ChainSchema } from "./types.ts";

export const VerdictEnum = z.enum([
  "safe_to_transact",
  "do_not_transact",
  "insufficient_data",
]);
export type Verdict = z.infer<typeof VerdictEnum>;

export const ConfidenceEnum = z.enum(["low", "medium", "high"]);
export type Confidence = z.infer<typeof ConfidenceEnum>;

export const SeverityEnum = z.enum([
  "info",
  "low",
  "medium",
  "high",
  "critical",
]);
export type Severity = z.infer<typeof SeverityEnum>;

export const SignalFindingSchema = z.object({
  category: CategorySchema,
  severity: SeverityEnum,
  finding: z.string(), // short human-readable summary of what this signal contributed
});
export type SignalFinding = z.infer<typeof SignalFindingSchema>;

export const CoverageSchema = z.object({
  requested: z.array(CategorySchema),
  resolved: z.array(CategorySchema),
  unresolved: z.array(CategorySchema),
});
export type Coverage = z.infer<typeof CoverageSchema>;

export const WalletVerdictSchema = z.object({
  address: z.string(),
  chain: ChainSchema,
  safe: z.boolean(),
  verdict: VerdictEnum,
  confidence: ConfidenceEnum,
  headline: z.string(), // one-sentence verdict statement
  reasoning: z.string(), // multi-sentence weighted explanation
  findings: z.array(SignalFindingSchema),
  coverage: CoverageSchema,
  totalSpentUsdc: z.number(),
  generatedAt: z.string(),
}).describe("WalletVerdict");

export type WalletVerdict = z.infer<typeof WalletVerdictSchema>;

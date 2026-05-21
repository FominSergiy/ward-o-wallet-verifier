import { z } from "zod";
import { CategorySchema, type Category } from "../agent/types.ts";

export type WalletNetwork = "base" | "base-sepolia";

export const NETWORK_TO_CAIP2: Record<WalletNetwork, string> = {
  "base": "eip155:8453",
  "base-sepolia": "eip155:84532",
};

export function toCaip2(net: WalletNetwork): string {
  return NETWORK_TO_CAIP2[net];
}

export interface DiscoveryAccept {
  amount: string;
  asset: string;
  network: string;
  payTo: string;
  scheme: "exact" | "upto";
  maxTimeoutSeconds: number;
  extra?: { name?: string; version?: string };
}

export interface DiscoveryEntry {
  resource: string;
  description: string;
  accepts: DiscoveryAccept[];
  extensions?: {
    bazaar?: {
      info?: { method?: string; queryParams?: unknown; bodyType?: string };
      quality?: { l30DaysUniquePayers?: number };
    };
  };
}

export interface SearchParams {
  query: string;
  network: string;
  maxUsdPrice?: number;
  limit?: number;
}

export class DiscoveryFetchError extends Error {
  constructor(
    public readonly status: number,
    public readonly url: string,
    message: string,
  ) {
    super(message);
    this.name = "DiscoveryFetchError";
  }
}

export class WalletUnfundedError extends Error {
  constructor(
    public readonly baseAddress: string | null,
    public readonly baseSepoliaAddress: string | null,
  ) {
    super(
      `No USDC balance on either network. base=${baseAddress ?? "(unknown)"}, base-sepolia=${baseSepoliaAddress ?? "(unknown)"}. Top up either wallet with USDC before discovering services.`,
    );
    this.name = "WalletUnfundedError";
  }
}

export interface RankedService {
  category: Category;
  resource: string;
  description: string;
  priceUsdc: number;
  network: string;
  payTo: string;
  scheme: "exact" | "upto";
  qualityScore: number | null;
  rationale: string;
}

export const RankedSelectionSchema = z.object({
  selections: z.array(z.object({
    category: CategorySchema,
    resourceIndex: z.number().int().min(0),
    rationale: z.string(),
  })),
}).describe("RankedSelection");

export type RankedSelection = z.infer<typeof RankedSelectionSchema>;

export interface DiscoveryCandidatesByCategory {
  walletNetwork: WalletNetwork;
  candidates: Partial<Record<Category, DiscoveryEntry[]>>;
  errors: Partial<Record<Category, string>>;
}

export interface DiscoveryPlan {
  address: string;
  walletNetwork: WalletNetwork;
  services: RankedService[];
  totalEstimatedCostUsdc: number;
  unresolvedCategories: Category[];
  generatedAt: string;
}

import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { zValidator } from "hono/zod-validator";
import { z } from "zod";
import { CategorySchema, type Category } from "../agent/types.ts";
import { discover } from "../discovery/discover.ts";
import {
  DiscoveryFetchError,
  WalletUnfundedError,
} from "../discovery/types.ts";
import {
  type EventEmitter,
  now,
  type VerifyEvent,
} from "../agent/events.ts";

// Mirrors src/agent/verify.ts DEFAULT_CATEGORIES so the plan card is a
// faithful preview of an Execute run. "ens" doesn't have a paid Bazaar
// service today and discover.ts already filters it from unresolvedCategories;
// keeping it here lets buildDeterministicSources surface the free ENS
// resolver in the plan.
const DEFAULT_CATEGORIES: Category[] = [
  "sanctions",
  "labels",
  "onchain_history",
  "web_sentiment",
  "ens",
];

const PING_INTERVAL_MS = 15_000;

const discoverStreamBodySchema = z.object({
  address: z.string().regex(/^0x[0-9a-fA-F]{40}$/, "Must be a valid EVM address"),
  categories: z.array(CategorySchema).min(1).optional(),
});

export interface DiscoverStreamRouterOpts {
  /** Test seam for the underlying discover call. */
  discoverFn?: typeof discover;
}

export function createDiscoverStreamRouter(
  opts: DiscoverStreamRouterOpts = {},
): Hono {
  const router = new Hono();
  const discoverFn = opts.discoverFn ?? discover;

  router.post(
    "/",
    zValidator("json", discoverStreamBodySchema),
    (c) => {
      const { address, categories } = c.req.valid("json");
      const cats = categories ?? DEFAULT_CATEGORIES;

      return streamSSE(c, async (stream) => {
        const queue: VerifyEvent[] = [];
        const wake = { resolve: () => {} } as { resolve: () => void };
        let closed = false;
        let drainSignal: Promise<void> = new Promise((r) => {
          wake.resolve = r;
        });

        const emit: EventEmitter = (e) => {
          queue.push(e);
          const r = wake.resolve;
          drainSignal = new Promise((res) => {
            wake.resolve = res;
          });
          r();
        };

        const pinger = setInterval(() => {
          if (closed) return;
          stream.writeSSE({ event: "ping", data: "" }).catch(() => {});
        }, PING_INTERVAL_MS);

        const flush = async () => {
          while (queue.length > 0) {
            const e = queue.shift()!;
            await stream.writeSSE({
              event: e.type,
              data: JSON.stringify(e),
            });
          }
        };

        const runDiscover = async () => {
          try {
            const plan = await discoverFn(address, cats, { onEvent: emit });
            // The final frame: a `plan` event carrying the discover result.
            // discover.ts itself does not emit this — the caller does, same
            // pattern as verify.ts.
            emit({
              type: "plan",
              services: plan.services.map((s) => ({
                category: s.category,
                resource: s.resource,
                priceUsdc: s.priceUsdc,
                rationale: s.rationale,
              })),
              totalEstimatedCostUsdc: plan.totalEstimatedCostUsdc,
              walletNetwork: plan.walletNetwork,
              unresolvedCategories: plan.unresolvedCategories,
              deterministicSources: plan.deterministicSources,
              at: now(),
            });
          } catch (e) {
            if (e instanceof WalletUnfundedError) {
              emit({
                type: "error",
                code: "wallet_unfunded",
                status: 402,
                message: e.message,
                at: now(),
              });
              return;
            }
            if (e instanceof DiscoveryFetchError) {
              emit({
                type: "error",
                code: "discovery_upstream_failed",
                status: 502,
                message: e.message,
                at: now(),
              });
              return;
            }
            if (e instanceof Error && e.message.includes("AGNIC_API_KEY")) {
              emit({
                type: "error",
                code: "missing_config",
                status: 500,
                message: e.message,
                at: now(),
              });
              return;
            }
            emit({
              type: "error",
              code: "internal_error",
              status: 500,
              message: (e as Error).message ?? "unknown",
              at: now(),
            });
          }
        };

        const runPromise = runDiscover().finally(() => {
          closed = true;
          wake.resolve();
        });

        while (!closed || queue.length > 0) {
          await flush();
          if (closed && queue.length === 0) break;
          await drainSignal;
        }

        clearInterval(pinger);
        await runPromise;
      });
    },
  );

  return router;
}

/** Default export — uses the real discover. */
export const discoverStreamRouter = createDiscoverStreamRouter();

import { generateStructured, type GenerateStructuredOpts } from "../gateway.ts";
import { z } from "zod";

export interface LlmClient {
  /**
   * Produce structured output matching the given zod schema.
   *
   * Accepts either a model string (legacy 3-arg form) or an options object
   * with toolName/toolDescription/toolExample to give Anthropic models
   * stronger grounding and reduce envelope-wrapping bugs.
   */
  generateStructured<T>(
    schema: z.ZodType<T>,
    prompt: string,
    optsOrModel?: GenerateStructuredOpts | string,
  ): Promise<T>;
}

export const defaultLlm: LlmClient = {
  generateStructured: (schema, prompt, optsOrModel) =>
    generateStructured(schema, prompt, optsOrModel),
};

/** Mutable accumulator for total LLM spend across a pipeline run. */
export interface LlmCostSink {
  totalUsd: number;
}

/**
 * Wrap an LlmClient so every call's USD cost is accumulated into `sink`.
 * Injects an `onCost` hook into each call's opts (chaining any caller-supplied
 * one), so callers don't have to thread cost tracking through individual call
 * sites — wrap the client once and read `sink.totalUsd` at the end.
 */
export function withCostTracking(
  inner: LlmClient,
  sink: LlmCostSink,
): LlmClient {
  return {
    generateStructured(schema, prompt, optsOrModel) {
      const opts: GenerateStructuredOpts = typeof optsOrModel === "string"
        ? { model: optsOrModel }
        : { ...(optsOrModel ?? {}) };
      const prevOnCost = opts.onCost;
      opts.onCost = (usd) => {
        sink.totalUsd += usd;
        prevOnCost?.(usd);
      };
      return inner.generateStructured(schema, prompt, opts);
    },
  };
}

export function mockLlm(fixtures: Record<string, unknown>): LlmClient {
  return {
    generateStructured<T>(
      schema: z.ZodType<T>,
      _prompt: string,
      _optsOrModel?: GenerateStructuredOpts | string,
    ): Promise<T> {
      // zod v4 stores describe() on schema.description, not schema.def.description.
      const key = (schema as { description?: string }).description;
      const fixture = (key && key in fixtures)
        ? fixtures[key]
        : Object.values(fixtures)[0];
      if (fixture === undefined) {
        return Promise.reject(
          new Error(
            `mockLlm: no fixture for schema "${key ?? "(no description)"}"`,
          ),
        );
      }
      try {
        return Promise.resolve(schema.parse(fixture));
      } catch (e) {
        return Promise.reject(e);
      }
    },
  };
}

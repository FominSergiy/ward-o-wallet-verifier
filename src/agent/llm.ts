import { generateStructured } from "../gateway.ts";
import { z } from "zod";

export interface LlmClient {
  generateStructured<T>(
    schema: z.ZodType<T>,
    prompt: string,
    model?: string,
  ): Promise<T>;
}

export const defaultLlm: LlmClient = {
  generateStructured: (schema, prompt, model) =>
    generateStructured(schema, prompt, model),
};

export function mockLlm(fixtures: Record<string, unknown>): LlmClient {
  return {
    generateStructured<T>(
      schema: z.ZodType<T>,
      _prompt: string,
      _model?: string,
    ): Promise<T> {
      const key = (schema.def as { description?: string }).description;
      const fixture = (key && key in fixtures)
        ? fixtures[key]
        : Object.values(fixtures)[0];
      if (fixture === undefined) {
        return Promise.reject(
          new Error(`mockLlm: no fixture for schema "${key ?? "(no description)"}"`),
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

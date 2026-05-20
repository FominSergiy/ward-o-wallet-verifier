import { generateStructured } from "../gateway.ts";
import { z } from "zod";

export interface LlmClient {
  generateStructured<T>(schema: z.ZodType<T>, prompt: string): Promise<T>;
}
export const defaultLlm: LlmClient = { generateStructured }; // re-export from gateway.ts
export function mockLlm(fixtures: Record<string, unknown>): LlmClient {
  return {
    async generateStructured<T>(
      schema: z.ZodType<T>,
      _prompt: string,
    ): Promise<T> {
      const key = (schema.def as { description?: string }).description;
      const fixture = (key && key in fixtures)
        ? fixtures[key]
        : Object.values(fixtures)[0];
      if (fixture === undefined) {
        throw new Error(
          `mockLlm: no fixture for schema "${key ?? "(no description)"}"`,
        );
      }
      return await schema.parse(fixture);
    },
  };
}

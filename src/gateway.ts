import { z } from "zod";

// Agnic exposes an OpenAI-compatible chat completions API at /v1/chat/completions.
// We use tool-calling to enforce structured output: define a single function
// whose parameters mirror the caller's zod schema, force the model to call it,
// then parse and validate the returned arguments.

const AGNIC_CHAT_URL = "https://api.agnic.ai/v1/chat/completions";
const DEFAULT_MODEL = Deno.env.get("AI_MODEL") ?? "anthropic/claude-sonnet-4.6";

interface ChatCompletion {
  choices?: Array<{
    message?: {
      content?: string | null;
      tool_calls?: Array<{
        id: string;
        type: "function";
        function: { name: string; arguments: string };
      }>;
    };
    finish_reason?: string;
  }>;
  agnic?: { cost_usd?: string; latency_ms?: number };
  error?: { message?: string } | string;
}

export async function generateStructured<T>(
  schema: z.ZodType<T>,
  prompt: string,
  model = DEFAULT_MODEL,
  fetchFn: typeof globalThis.fetch = globalThis.fetch,
): Promise<T> {
  const apiKey = Deno.env.get("AGNIC_API_KEY");
  if (!apiKey) throw new Error("AGNIC_API_KEY not set");

  const jsonSchema = z.toJSONSchema(schema, { target: "draft-7" });

  const resp = await fetchFn(AGNIC_CHAT_URL, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: prompt }],
      tools: [{
        type: "function",
        function: {
          name: "respond",
          description: "Return the structured response.",
          parameters: jsonSchema,
        },
      }],
      tool_choice: { type: "function", function: { name: "respond" } },
    }),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`agnic gateway HTTP ${resp.status}: ${errText}`);
  }

  const data = await resp.json() as ChatCompletion;
  const toolCall = data.choices?.[0]?.message?.tool_calls?.[0];
  if (!toolCall) {
    const fallbackContent = data.choices?.[0]?.message?.content ?? "(empty)";
    throw new Error(
      `agnic gateway returned no tool call. Content: ${fallbackContent.slice(0, 200)}`,
    );
  }

  let parsedArgs: unknown;
  try {
    parsedArgs = JSON.parse(toolCall.function.arguments);
  } catch (e) {
    throw new Error(
      `agnic gateway tool arguments were not valid JSON: ${(e as Error).message}`,
    );
  }

  return schema.parse(parsedArgs);
}

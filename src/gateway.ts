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

  // Anthropic models occasionally wrap the structured response under one of
  // several envelope shapes leaked from how the tool schema is rendered. Seen:
  //   1. {"$PARAMETER_NAME": {...payload}}            (single key)
  //   2. {"response": {...payload}}                   (single key, different name)
  //   3. {"$PARAMETER_NAME": "WalletVerdict",
  //       "$PARAMETER_VALUE": {...payload}}           (two keys: name+value)
  // Try the raw parse; if it fails, look for an inner object that DOES validate.
  const isObj = (v: unknown): v is Record<string, unknown> =>
    !!v && typeof v === "object" && !Array.isArray(v);

  let firstAttempt = schema.safeParse(parsedArgs);
  if (!firstAttempt.success && isObj(parsedArgs)) {
    const keys = Object.keys(parsedArgs);
    const candidates: string[] = [];
    if (keys.length === 1) candidates.push(keys[0]);
    // Common explicit "value" keys when the model emits a {name, value} envelope.
    for (const k of ["$PARAMETER_VALUE", "value", "data", "result", "output", "payload"]) {
      if (k in parsedArgs && !candidates.includes(k)) candidates.push(k);
    }
    for (const k of candidates) {
      const inner = parsedArgs[k];
      if (!isObj(inner)) continue;
      const unwrapped = schema.safeParse(inner);
      if (unwrapped.success) {
        console.warn(
          `[gateway] unwrapped tool args from envelope key "${k}"`,
        );
        parsedArgs = inner;
        firstAttempt = unwrapped;
        break;
      }
    }
  }

  const result = firstAttempt;
  if (!result.success) {
    const rawSnippet = toolCall.function.arguments.slice(0, 400);
    throw new Error(
      `agnic gateway tool args failed schema validation. Raw args (first 400 chars): ${rawSnippet} — zod errors: ${JSON.stringify(result.error.issues.slice(0, 3))}`,
    );
  }
  return result.data;
}

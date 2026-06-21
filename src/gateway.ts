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

export interface GenerateStructuredOpts {
  model?: string;
  /**
   * Tool function name. A specific, verb-y name (e.g. "submit_wallet_verdict")
   * gives the model better grounding than the generic "respond" default and
   * has been shown to reduce envelope-wrapping bugs in Anthropic models.
   */
  toolName?: string;
  /**
   * Human-readable description of what the tool emits. Surfaced to the model
   * alongside the JSON schema. Defaults to a generic message.
   */
  toolDescription?: string;
  /**
   * Optional example of a valid response object. Serialized into the tool
   * description so the model sees a concrete schema-conformant payload. Use
   * placeholder values — Opus is more reliable when given an example.
   */
  toolExample?: unknown;
  fetchFn?: typeof globalThis.fetch;
  /**
   * Invoked with the LLM call's USD cost (parsed from the gateway's
   * `agnic.cost_usd` field) after a successful response. Lets callers
   * accumulate model spend for cost reporting. Cost-telemetry only — a
   * missing/malformed cost field is swallowed and the callback is skipped,
   * never throwing into the synthesis path.
   */
  onCost?: (usd: number) => void;
}

const NO_ENVELOPE_SYSTEM_MESSAGE =
  "You produce structured output by calling the provided function. " +
  "The function's `parameters` describe the FULL response shape — " +
  "your tool call arguments ARE the response object. " +
  "Do NOT wrap your answer under any envelope key like '$PARAMETER_NAME', " +
  "'$PARAMETER_VALUE', 'response', 'data', 'result', or 'output'. " +
  "The arguments object's top-level keys must match the parameter schema " +
  "directly.";

function buildToolDescription(
  base: string,
  example: unknown | undefined,
): string {
  if (example === undefined) return base;
  return `${base}\n\nExample of a valid response (placeholder values; substitute with your actual analysis):\n${
    JSON.stringify(example, null, 2)
  }`;
}

export async function generateStructured<T>(
  schema: z.ZodType<T>,
  prompt: string,
  optsOrModel?: GenerateStructuredOpts | string,
  legacyFetchFn?: typeof globalThis.fetch,
): Promise<T> {
  // Backwards-compatible signature: callers may pass either (schema, prompt, model, fetchFn)
  // or (schema, prompt, optsObject). Normalize.
  const opts: GenerateStructuredOpts = typeof optsOrModel === "string"
    ? { model: optsOrModel, fetchFn: legacyFetchFn }
    : optsOrModel ?? {};

  const apiKey = Deno.env.get("AGNIC_API_KEY");
  if (!apiKey) throw new Error("AGNIC_API_KEY not set");

  const model = opts.model ?? DEFAULT_MODEL;
  const toolName = opts.toolName ?? "respond";
  const baseDescription = opts.toolDescription ??
    "Return the structured response.";
  const toolDescription = buildToolDescription(
    baseDescription,
    opts.toolExample,
  );
  const fetchFn = opts.fetchFn ?? globalThis.fetch;

  const jsonSchema = z.toJSONSchema(schema, { target: "draft-7" });

  const resp = await fetchFn(AGNIC_CHAT_URL, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: NO_ENVELOPE_SYSTEM_MESSAGE },
        { role: "user", content: prompt },
      ],
      tools: [{
        type: "function",
        function: {
          name: toolName,
          description: toolDescription,
          parameters: jsonSchema,
        },
      }],
      tool_choice: { type: "function", function: { name: toolName } },
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
      `agnic gateway returned no tool call. Content: ${
        fallbackContent.slice(0, 200)
      }`,
    );
  }

  let parsedArgs: unknown;
  try {
    parsedArgs = JSON.parse(toolCall.function.arguments);
  } catch (e) {
    throw new Error(
      `agnic gateway tool arguments were not valid JSON: ${
        (e as Error).message
      }`,
    );
  }

  // Defensive unwrap (belt-and-suspenders to the system message above).
  // Anthropic models occasionally still wrap the structured response under
  // one of several envelope shapes:
  //   1. {"$PARAMETER_NAME": {...payload}}            (single key)
  //   2. {"response": {...payload}}                   (single key, named)
  //   3. {"$PARAMETER_NAME": "WalletVerdict",
  //       "$PARAMETER_VALUE": {...payload}}           (two keys)
  // Try the raw parse; if it fails, look for an inner object that DOES validate.
  const isObj = (v: unknown): v is Record<string, unknown> =>
    !!v && typeof v === "object" && !Array.isArray(v);

  let firstAttempt = schema.safeParse(parsedArgs);
  if (!firstAttempt.success && isObj(parsedArgs)) {
    const keys = Object.keys(parsedArgs);
    const candidates: string[] = [];
    if (keys.length === 1) candidates.push(keys[0]);
    for (
      const k of [
        "$PARAMETER_VALUE",
        "value",
        "data",
        "result",
        "output",
        "payload",
      ]
    ) {
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

  if (!firstAttempt.success) {
    const rawSnippet = toolCall.function.arguments.slice(0, 400);
    throw new Error(
      `agnic gateway tool args failed schema validation. Raw args (first 400 chars): ${rawSnippet} — zod errors: ${
        JSON.stringify(firstAttempt.error.issues.slice(0, 3))
      }`,
    );
  }
  // Surface the LLM call's USD cost for accumulation by the caller. Best-effort:
  // a missing or non-numeric `agnic.cost_usd` must never break synthesis.
  if (opts.onCost) {
    const cost = parseFloat(data.agnic?.cost_usd ?? "");
    if (Number.isFinite(cost)) opts.onCost(cost);
  }

  return firstAttempt.data;
}

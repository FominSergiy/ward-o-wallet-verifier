import { assertEquals, assertRejects } from "@std/assert";
import { z } from "zod";
import { generateStructured } from "./gateway.ts";

const TestSchema = z.object({
  safe: z.boolean(),
  verdict: z.string(),
}).describe("TestVerdict");

function mockAgnicFetch(args: {
  status?: number;
  toolName?: string;
  toolArgs: unknown;
  capturedBody?: { value?: Record<string, unknown> };
  // When provided, embed an `agnic.cost_usd` field on the response so onCost
  // tests can exercise cost extraction. A literal string (incl. malformed) is
  // sent verbatim to mirror the real gateway shape.
  agnicCostUsd?: string;
}): typeof globalThis.fetch {
  return (_url, init) => {
    if (args.capturedBody) {
      const bodyText = ((init as { body?: string } | undefined)?.body) ?? "";
      args.capturedBody.value = JSON.parse(bodyText) as Record<string, unknown>;
    }
    return Promise.resolve(
      new Response(
        JSON.stringify({
          choices: [{
            message: {
              tool_calls: [{
                id: "tc1",
                type: "function",
                function: {
                  name: args.toolName ?? "respond",
                  arguments: JSON.stringify(args.toolArgs),
                },
              }],
            },
          }],
          ...(args.agnicCostUsd !== undefined
            ? { agnic: { cost_usd: args.agnicCostUsd } }
            : {}),
        }),
        {
          status: args.status ?? 200,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );
  };
}

function setupKey() {
  Deno.env.set("AGNIC_API_KEY", "test-key");
}
function teardownKey() {
  Deno.env.delete("AGNIC_API_KEY");
}

// --- New strict-envelope options ----------------------------------------------

Deno.test("generateStructured forwards toolName and toolDescription to the agnic request", async () => {
  setupKey();
  const captured: { value?: Record<string, unknown> } = {};
  const fetchFn = mockAgnicFetch({
    toolName: "submit_test",
    toolArgs: { safe: true, verdict: "ok" },
    capturedBody: captured,
  });
  try {
    await generateStructured(TestSchema, "Test prompt", {
      toolName: "submit_test",
      toolDescription: "Submit the test verdict.",
      fetchFn,
    });
    const body = captured.value!;
    const tools = body.tools as Array<
      { function: { name: string; description: string } }
    >;
    assertEquals(tools[0].function.name, "submit_test");
    assertEquals(
      tools[0].function.description.startsWith("Submit the test verdict."),
      true,
    );
    const toolChoice = body.tool_choice as { function: { name: string } };
    assertEquals(toolChoice.function.name, "submit_test");
  } finally {
    teardownKey();
  }
});

Deno.test("generateStructured embeds toolExample in the tool description as JSON", async () => {
  setupKey();
  const captured: { value?: Record<string, unknown> } = {};
  const example = { safe: false, verdict: "do_not_transact" };
  const fetchFn = mockAgnicFetch({
    toolArgs: { safe: true, verdict: "ok" },
    capturedBody: captured,
  });
  try {
    await generateStructured(TestSchema, "Test", {
      toolDescription: "Base text.",
      toolExample: example,
      fetchFn,
    });
    const body = captured.value!;
    const tools = body.tools as Array<{ function: { description: string } }>;
    const desc = tools[0].function.description;
    assertEquals(desc.includes("Base text."), true);
    assertEquals(desc.includes("Example of a valid response"), true);
    assertEquals(desc.includes('"do_not_transact"'), true);
  } finally {
    teardownKey();
  }
});

Deno.test("generateStructured includes a no-envelope system message", async () => {
  setupKey();
  const captured: { value?: Record<string, unknown> } = {};
  const fetchFn = mockAgnicFetch({
    toolArgs: { safe: true, verdict: "ok" },
    capturedBody: captured,
  });
  try {
    await generateStructured(TestSchema, "Test", { fetchFn });
    const body = captured.value!;
    const messages = body.messages as Array<{ role: string; content: string }>;
    assertEquals(messages[0].role, "system");
    assertEquals(messages[0].content.includes("Do NOT wrap"), true);
    assertEquals(messages[0].content.includes("$PARAMETER_NAME"), true);
    assertEquals(messages[1].role, "user");
    assertEquals(messages[1].content, "Test");
  } finally {
    teardownKey();
  }
});

Deno.test("generateStructured accepts legacy 3-arg model string for backwards compat", async () => {
  setupKey();
  const captured: { value?: Record<string, unknown> } = {};
  const fetchFn = mockAgnicFetch({
    toolArgs: { safe: true, verdict: "ok" },
    capturedBody: captured,
  });
  try {
    await generateStructured(
      TestSchema,
      "Test",
      "anthropic/legacy-model",
      fetchFn,
    );
    const body = captured.value!;
    assertEquals(body.model, "anthropic/legacy-model");
  } finally {
    teardownKey();
  }
});

// --- Cost extraction (onCost) -------------------------------------------------

Deno.test("generateStructured calls onCost with the parsed agnic.cost_usd", async () => {
  setupKey();
  const fetchFn = mockAgnicFetch({
    toolArgs: { safe: true, verdict: "ok" },
    agnicCostUsd: "0.000123",
  });
  const costs: number[] = [];
  try {
    await generateStructured(TestSchema, "x", {
      fetchFn,
      onCost: (usd) => costs.push(usd),
    });
    assertEquals(costs, [0.000123]);
  } finally {
    teardownKey();
  }
});

Deno.test("generateStructured skips onCost when agnic.cost_usd is absent", async () => {
  setupKey();
  const fetchFn = mockAgnicFetch({ toolArgs: { safe: true, verdict: "ok" } });
  let called = false;
  try {
    await generateStructured(TestSchema, "x", {
      fetchFn,
      onCost: () => (called = true),
    });
    assertEquals(called, false);
  } finally {
    teardownKey();
  }
});

Deno.test("generateStructured does not throw or fire onCost on malformed cost_usd", async () => {
  setupKey();
  const fetchFn = mockAgnicFetch({
    toolArgs: { safe: true, verdict: "ok" },
    agnicCostUsd: "not-a-number",
  });
  let called = false;
  try {
    const out = await generateStructured(TestSchema, "x", {
      fetchFn,
      onCost: () => (called = true),
    });
    assertEquals(out.safe, true);
    assertEquals(called, false);
  } finally {
    teardownKey();
  }
});

// --- Defensive envelope unwrap -----------------------------------------------

Deno.test("generateStructured unwraps {$PARAMETER_NAME: {...payload}}", async () => {
  setupKey();
  const fetchFn = mockAgnicFetch({
    toolArgs: { $PARAMETER_NAME: { safe: true, verdict: "ok" } },
  });
  try {
    const out = await generateStructured(TestSchema, "x", { fetchFn });
    assertEquals(out.safe, true);
    assertEquals(out.verdict, "ok");
  } finally {
    teardownKey();
  }
});

Deno.test("generateStructured unwraps {response: {...payload}}", async () => {
  setupKey();
  const fetchFn = mockAgnicFetch({
    toolArgs: { response: { safe: false, verdict: "scam" } },
  });
  try {
    const out = await generateStructured(TestSchema, "x", { fetchFn });
    assertEquals(out.safe, false);
    assertEquals(out.verdict, "scam");
  } finally {
    teardownKey();
  }
});

Deno.test("generateStructured unwraps {$PARAMETER_NAME, $PARAMETER_VALUE} envelope", async () => {
  setupKey();
  const fetchFn = mockAgnicFetch({
    toolArgs: {
      $PARAMETER_NAME: "TestVerdict",
      $PARAMETER_VALUE: { safe: true, verdict: "ok" },
    },
  });
  try {
    const out = await generateStructured(TestSchema, "x", { fetchFn });
    assertEquals(out.safe, true);
    assertEquals(out.verdict, "ok");
  } finally {
    teardownKey();
  }
});

Deno.test("generateStructured unwraps under generic envelope keys (value, data, result, output, payload)", async () => {
  setupKey();
  const cases: Array<[string, unknown]> = [
    ["value", { safe: true, verdict: "v" }],
    ["data", { safe: true, verdict: "d" }],
    ["result", { safe: true, verdict: "r" }],
    ["output", { safe: true, verdict: "o" }],
    ["payload", { safe: true, verdict: "p" }],
  ];
  try {
    for (const [key, payload] of cases) {
      const fetchFn = mockAgnicFetch({ toolArgs: { [key]: payload } });
      const out = await generateStructured(TestSchema, "x", { fetchFn });
      assertEquals(out.safe, true);
    }
  } finally {
    teardownKey();
  }
});

Deno.test("generateStructured throws with raw args snippet when no envelope validates", async () => {
  setupKey();
  const fetchFn = mockAgnicFetch({
    toolArgs: { wrong: "shape", entirely: true },
  });
  try {
    await assertRejects(
      () => generateStructured(TestSchema, "x", { fetchFn }),
      Error,
      "tool args failed schema validation",
    );
  } finally {
    teardownKey();
  }
});

// --- Error paths ----------------------------------------------------------

Deno.test("generateStructured throws on missing AGNIC_API_KEY", async () => {
  Deno.env.delete("AGNIC_API_KEY");
  let called = false;
  const fetchFn: typeof globalThis.fetch = () => {
    called = true;
    return Promise.resolve(new Response("", { status: 200 }));
  };
  await assertRejects(
    () => generateStructured(TestSchema, "x", { fetchFn }),
    Error,
    "AGNIC_API_KEY not set",
  );
  assertEquals(called, false);
});

Deno.test("generateStructured throws on agnic gateway HTTP 500", async () => {
  setupKey();
  const fetchFn: typeof globalThis.fetch = () =>
    Promise.resolve(new Response("upstream broken", { status: 500 }));
  try {
    await assertRejects(
      () => generateStructured(TestSchema, "x", { fetchFn }),
      Error,
      "agnic gateway HTTP 500",
    );
  } finally {
    teardownKey();
  }
});

Deno.test("generateStructured throws when response has no tool_calls", async () => {
  setupKey();
  const fetchFn: typeof globalThis.fetch = () =>
    Promise.resolve(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: "I refuse to use the tool." } }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
  try {
    await assertRejects(
      () => generateStructured(TestSchema, "x", { fetchFn }),
      Error,
      "no tool call",
    );
  } finally {
    teardownKey();
  }
});

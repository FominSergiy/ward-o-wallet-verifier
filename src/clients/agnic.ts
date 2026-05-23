const BASE_URL = "https://api.agnic.ai";

export interface AgnicFetchResult<T = unknown> {
  data: T;
  paid: boolean;
  amountUsd: number;
  network: string | null;
  scheme: "exact" | "upto" | null;
}

export class AgnicFetchError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "AgnicFetchError";
  }
}

export async function agnicFetch<T = unknown>(
  targetUrl: string,
  opts: {
    method?: "GET" | "POST";
    body?: unknown;
    maxValueUsd?: number;
    headers?: Record<string, string>;
  } = {},
): Promise<AgnicFetchResult<T>> {
  const apiKey = Deno.env.get("AGNIC_API_KEY");
  if (!apiKey) throw new Error("AGNIC_API_KEY not set");

  const { method = "GET", body, maxValueUsd, headers: extraHeaders = {} } = opts;

  const params = new URLSearchParams({ url: targetUrl, method });
  if (maxValueUsd !== undefined) {
    params.set("maxValue", String(Math.ceil(maxValueUsd * 1_000_000)));
  }

  const fetchHeaders: Record<string, string> = {
    "X-Agnic-Token": apiKey,
    ...extraHeaders,
  };
  if (body !== undefined) {
    fetchHeaders["Content-Type"] = "application/json";
  }

  const resp = await fetch(`${BASE_URL}/api/x402/fetch?${params}`, {
    method: "POST",
    headers: fetchHeaders,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  const json = await resp.json();

  if (!resp.ok) {
    const rawCode = (json as { error?: string }).error ?? "unknown_error";
    // Upstream agnic emits codes in mixed forms ("Not found", "Payment exceeds
    // maximum allowed value"). Normalize to snake_case so health-store /
    // durable-block matching is reliable.
    const code = rawCode.toLowerCase().replace(/[\s-]+/g, "_");
    const description =
      (json as { error_description?: string }).error_description ?? resp.statusText;
    throw new AgnicFetchError(code, `agnicFetch [${rawCode}]: ${description}`);
  }

  const paid = resp.headers.get("X-Agnic-Paid") === "true";
  const amountStr = resp.headers.get("X-Agnic-Amount");
  const amountUsd = paid && amountStr ? parseFloat(amountStr) : 0;
  const rawNetwork = resp.headers.get("X-Agnic-Network");
  const rawScheme = resp.headers.get("X-Agnic-Scheme");

  return {
    data: json as T,
    paid,
    amountUsd,
    network: rawNetwork,
    scheme: rawScheme === "exact" || rawScheme === "upto" ? rawScheme : null,
  };
}

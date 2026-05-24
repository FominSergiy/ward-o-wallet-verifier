const BASE_URL = "https://api.agnic.ai";

// Per-call deadline for upstream x402 fetches. Picked from v8 run receipts:
// slowest legitimate response was 59 s (orbisapi labeler on a rich-history
// wallet); the only call that exceeded this was a broken /:endpoint variant
// that returned HTML after 104 s. 60 s clears the legit ceiling with 1 s of
// margin while killing the obvious bad actor. Callers can override per call
// via opts.timeoutMs if they need shorter or longer.
const DEFAULT_TIMEOUT_MS = 60_000;

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
    signal?: AbortSignal;
    timeoutMs?: number;
  } = {},
): Promise<AgnicFetchResult<T>> {
  const apiKey = Deno.env.get("AGNIC_API_KEY");
  if (!apiKey) throw new Error("AGNIC_API_KEY not set");

  const {
    method = "GET",
    body,
    maxValueUsd,
    headers: extraHeaders = {},
    signal: callerSignal,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = opts;

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

  // Combine the caller signal (if any) with our per-call deadline so whichever
  // fires first aborts the request. If only the timeout fires, we surface a
  // synthetic "timeout" error code so the health store + LLM-fallback paths
  // classify it consistently alongside other transport errors.
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = callerSignal
    ? AbortSignal.any([callerSignal, timeoutSignal])
    : timeoutSignal;

  let resp: Response;
  try {
    resp = await fetch(`${BASE_URL}/api/x402/fetch?${params}`, {
      method: "POST",
      headers: fetchHeaders,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal,
    });
  } catch (e) {
    // The caller's signal takes precedence — if it aborted first, propagate
    // the original AbortError unchanged so callers can distinguish their
    // own cancellation from our deadline.
    if (callerSignal?.aborted) throw e;
    if (timeoutSignal.aborted) {
      throw new AgnicFetchError(
        "timeout",
        `agnicFetch [timeout]: upstream did not respond within ${timeoutMs}ms`,
      );
    }
    throw e;
  }

  // Read body as text first, then JSON.parse — upstream can return HTML error
  // pages or empty bodies on certain failures. If we call resp.json() directly,
  // the throw is a SyntaxError that loses the HTTP status + body preview and
  // leaks past AgnicFetchError, leaving the health store without a useful
  // lastErrorCode. Surfacing a synthetic non_json_response code keeps the
  // observability story clean.
  const text = await resp.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    const preview = text.slice(0, 200).replace(/\s+/g, " ").trim();
    throw new AgnicFetchError(
      "non_json_response",
      `agnicFetch [non_json_response]: HTTP ${resp.status} ${resp.statusText} returned non-JSON body (${preview})`,
    );
  }

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

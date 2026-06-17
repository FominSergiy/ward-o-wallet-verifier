/**
 * Cassette-based fetch interceptor for deterministic offline test replay.
 *
 * Record mode wraps globalThis.fetch to capture every HTTP interaction.
 * Replay mode replaces globalThis.fetch with a FIFO lookup keyed on
 * METHOD:URL only (no body). This avoids all body-normalization problems
 * (dynamic timestamps, JSON-RPC ids, non-deterministic prompt content) — the
 * assumption is that call ORDER per URL is stable between recording and
 * replay, which holds for a deterministic pipeline like verifyAgent.
 *
 * Missing replay entries throw loudly so tests surface gaps rather than
 * making silent network calls.
 */

export interface CassetteResponse {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;
}

export interface CassetteEntry {
  key: string;
  request: {
    url: string;
    method: string;
    body: string | null;
  };
  response: CassetteResponse;
}

export interface Cassette {
  wallet: string;
  expectedVerdict: string;
  entries: CassetteEntry[];
}

function makeKey(url: string, method: string): string {
  return `${method.toUpperCase()}:${url}`;
}

function headersToRecord(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((v, k) => {
    out[k] = v;
  });
  return out;
}

const originalFetch = globalThis.fetch;

/**
 * Install the recording interceptor.
 *
 * Every real fetch is forwarded and the response captured. The caller
 * receives entries via the returned callback and is responsible for
 * persisting them. Returns a restore function to undo the patch.
 */
export function installRecordInterceptor(
  onEntry: (entry: CassetteEntry) => void,
): () => void {
  globalThis.fetch = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = typeof input === "string"
      ? input
      : input instanceof URL
      ? input.href
      : (input as Request).url;
    const method = init?.method ??
      (input instanceof Request ? input.method : "GET");
    const body = init?.body ?? (input instanceof Request ? null : null);

    const key = makeKey(url, method);
    const real = await originalFetch(input, init);

    // Clone to read body without consuming the original
    const clone = real.clone();
    const responseBody = await clone.text();

    const entry: CassetteEntry = {
      key,
      request: {
        url,
        method: method.toUpperCase(),
        body: typeof body === "string" ? body : null,
      },
      response: {
        status: real.status,
        statusText: real.statusText,
        headers: headersToRecord(real.headers),
        body: responseBody,
      },
    };
    onEntry(entry);

    // Return a fresh Response from the saved body so the caller reads it fine
    return new Response(responseBody, {
      status: real.status,
      statusText: real.statusText,
      headers: real.headers,
    });
  };

  return () => {
    globalThis.fetch = originalFetch;
  };
}

/**
 * Install replay interceptor backed by the provided entries.
 *
 * Entries are consumed FIFO per key (METHOD:URL). Repeated calls to the same
 * URL (e.g. two LLM chat-completions calls, multiple JSON-RPC calls to the
 * same RPC endpoint) are served in the order they were recorded. Throws if a
 * request has no matching cassette entry.
 */
export function installReplayInterceptor(entries: CassetteEntry[]): () => void {
  const queues = new Map<string, CassetteEntry[]>();
  for (const entry of entries) {
    const q = queues.get(entry.key);
    if (q) q.push(entry);
    else queues.set(entry.key, [entry]);
  }

  globalThis.fetch = (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = typeof input === "string"
      ? input
      : input instanceof URL
      ? input.href
      : (input as Request).url;
    const method = init?.method ??
      (input instanceof Request ? input.method : "GET");

    const key = makeKey(url, method);
    const queue = queues.get(key);
    const entry = queue?.shift();

    if (!entry) {
      const keys = [...queues.keys()].map((k) => `  ${k}`).join("\n");
      throw new Error(
        `[cassette] No replay entry for:\n  ${key}\n\nAvailable keys:\n${
          keys || "  (none)"
        }`,
      );
    }

    const { response: r } = entry;
    return Promise.resolve(
      new Response(r.body, {
        status: r.status,
        statusText: r.statusText,
        headers: r.headers,
      }),
    );
  };

  return () => {
    globalThis.fetch = originalFetch;
  };
}

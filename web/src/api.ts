import type { VerifyEvent } from "./types";

const BASE = import.meta.env.VITE_API_BASE_URL ?? "";

async function consumeSSE(
  path: string,
  body: Record<string, unknown>,
  onEvent: (e: VerifyEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
    },
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok || !res.body) {
    // Non-stream error (e.g. zValidator 400 before the stream opens). Surface
    // as a synthetic error event so the UI's log panel still renders something.
    const j = await res.json().catch(() => ({ message: `HTTP ${res.status}` }));
    onEvent({
      type: "error",
      code: typeof j.error === "string" ? j.error : "http_error",
      message: typeof j.message === "string" ? j.message : `HTTP ${res.status}`,
      status: res.status,
      at: new Date().toISOString(),
    });
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });

      let sepIdx: number;
      while ((sepIdx = buf.indexOf("\n\n")) !== -1) {
        const rawFrame = buf.slice(0, sepIdx);
        buf = buf.slice(sepIdx + 2);
        const frame = parseFrame(rawFrame);
        if (frame) onEvent(frame);
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function parseFrame(raw: string): VerifyEvent | null {
  let event = "";
  let data = "";
  for (const line of raw.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) data += line.slice(5).trimStart();
  }
  if (event === "ping") return null;
  if (!data) return null;
  try {
    return JSON.parse(data) as VerifyEvent;
  } catch {
    return null;
  }
}

export function streamDiscover(
  address: string,
  onEvent: (e: VerifyEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  return consumeSSE("/discover-stream", { address }, onEvent, signal);
}

export function streamVerify(
  address: string,
  onEvent: (e: VerifyEvent) => void,
  signal: AbortSignal,
  depth?: "fast" | "deep",
): Promise<void> {
  const body = depth ? { address, depth } : { address };
  return consumeSSE("/verify-agent-stream", body, onEvent, signal);
}

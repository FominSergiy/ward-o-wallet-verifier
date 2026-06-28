// Thin, dependency-free logger. Replaces the ad-hoc `console.*` calls that were
// scattered across the backend so every log line shares one format
// (`<iso-timestamp> <LEVEL> <message>`) and honours a single level filter.
//
// Set `LOG_LEVEL` to debug | info | warn | error (default: info). It is read
// once at module load. Call sites keep their own `[scope]` message prefixes.

export type LogLevel = "debug" | "info" | "warn" | "error";

const ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

function normalizeLevel(raw: string | undefined): LogLevel {
  const v = (raw ?? "info").toLowerCase();
  return v in ORDER ? v as LogLevel : "info";
}

const THRESHOLD = ORDER[normalizeLevel(Deno.env.get("LOG_LEVEL"))];

function emit(level: LogLevel, message: string, rest: unknown[]): void {
  if (ORDER[level] < THRESHOLD) return;
  const line = `${new Date().toISOString()} ${level.toUpperCase()} ${message}`;
  const sink = level === "error"
    ? console.error
    : level === "warn"
    ? console.warn
    : console.log;
  sink(line, ...rest);
}

export const log = {
  debug: (message: string, ...rest: unknown[]) => emit("debug", message, rest),
  info: (message: string, ...rest: unknown[]) => emit("info", message, rest),
  warn: (message: string, ...rest: unknown[]) => emit("warn", message, rest),
  error: (message: string, ...rest: unknown[]) => emit("error", message, rest),
};

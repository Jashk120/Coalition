import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Minimal structured logger for app route handlers.
 *
 * JSON lines to stdout — no dependencies, no secrets. Only public,
 * demo-safe fields belong here (counts, addresses, decisions, durations);
 * never tokens, keys, OTPs, or session material.
 *
 * Every line is also appended to a debug file so failures survive beyond
 * the terminal scrollback: `process.env["DEBUG_LOG_FILE"]` when set,
 * otherwise `logs/debug.log` under the app working directory. File writes
 * are best-effort and never throw — a full disk must not break a request.
 * Server-only: route handlers run on Node, never the Edge runtime.
 */
export type LogLevel = "debug" | "info" | "warn" | "error";

export type LogFields = {
  readonly [key: string]: string | number | boolean | null | undefined;
};

function debugFilePath(): string {
  const configured = process.env["DEBUG_LOG_FILE"];
  if (configured !== undefined && configured !== "") return configured;
  return "logs/debug.log";
}

function appendToDebugFile(line: string): void {
  try {
    const file = debugFilePath();
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, `${line}\n`, { encoding: "utf8" });
  } catch {
    // Best-effort only: logging must never crash the handler.
  }
}

function write(level: LogLevel, event: string, fields?: LogFields): void {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    event,
    ...fields,
  });
  if (level === "warn" || level === "error") {
    process.stderr.write(`${line}\n`);
  } else {
    process.stdout.write(`${line}\n`);
  }
  appendToDebugFile(line);
}

/** Emit one JSON log line for a route-handler moment. */
export function log(level: LogLevel, event: string, fields?: LogFields): void {
  write(level, event, fields);
}

/**
 * Time an async step and log its completion at info (or warn when slow).
 * Returns the step result so call sites stay a one-line wrap.
 */
export async function logTimed<T>(
  event: string,
  fields: LogFields,
  step: () => Promise<T>,
  slowMs = 10_000,
): Promise<T> {
  const start = Date.now();
  const result = await step();
  const durationMs = Date.now() - start;
  write(durationMs >= slowMs ? "warn" : "info", event, {
    ...fields,
    durationMs,
  });
  return result;
}

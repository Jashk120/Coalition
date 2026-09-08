/**
 * Minimal structured logger for app route handlers.
 *
 * JSON lines to stdout — no dependencies, no secrets. Only public,
 * demo-safe fields belong here (counts, addresses, decisions, durations);
 * never tokens, keys, OTPs, or session material.
 */
export type LogLevel = "debug" | "info" | "warn" | "error";

export type LogFields = {
  readonly [key: string]: string | number | boolean | null | undefined;
};

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

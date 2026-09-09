import { NextResponse } from "next/server";
import { log } from "@/lib/logger";
import { orchestratorBaseUrl } from "@/lib/pool-state";

export const dynamic = "force-dynamic";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * GET /api/usage — public orchestrator usage relay (GET /usage).
 * No APP_KEY is attached: usage is public demo data. The browser polls
 * this route every 10s, so the upstream fetch stays no-store.
 */
export async function GET(): Promise<Response> {
  try {
    const response = await fetch(`${orchestratorBaseUrl()}/usage`, {
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      log("warn", "usage.bad_upstream", {
        route: "GET /api/usage",
        status: response.status,
      });
      return NextResponse.json(
        { ok: false, error: `usage endpoint returned ${String(response.status)}` },
        { status: 502 },
      );
    }
    const body: unknown = await response.json();
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      log("warn", "usage.bad_shape", { route: "GET /api/usage" });
      return NextResponse.json(
        { ok: false, error: "usage endpoint returned an unexpected shape" },
        { status: 502 },
      );
    }
    return NextResponse.json({ ok: true, ...(body as Record<string, unknown>) });
  } catch (error) {
    log("warn", "usage.unavailable", {
      route: "GET /api/usage",
      error: errorMessage(error),
    });
    return NextResponse.json(
      { ok: false, error: `usage unavailable: ${errorMessage(error)}` },
      { status: 502 },
    );
  }
}

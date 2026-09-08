import { NextResponse } from "next/server";
import { fetchQuote } from "@jx-nexus/coalition";
import { log } from "@/lib/logger";
import { orchestratorBaseUrl } from "@/lib/pool-state";

export const dynamic = "force-dynamic";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function withBigints(value: unknown): string {
  return JSON.stringify(value, (_key, nested: unknown) =>
    typeof nested === "bigint" ? nested.toString() : nested,
  );
}

/**
 * GET /api/quote?seller=0x… — resale quote proxy for the usage panel.
 * Uses the SDK's `fetchQuote` (GET /quote?seller=) so parsing stays in one
 * place; bigints cross to the UI as decimal strings.
 */
export async function GET(request: Request): Promise<Response> {
  const seller = new URL(request.url).searchParams.get("seller");
  if (seller === null || seller === "") {
    log("warn", "quote.bad_request", { route: "GET /api/quote" });
    return NextResponse.json({ ok: false, error: "missing ?seller=0x…" }, { status: 400 });
  }
  try {
    const quote = await fetchQuote({ baseUrl: orchestratorBaseUrl(), seller });
    return new Response(withBigints({ ok: true, quote }), {
      headers: { "content-type": "application/json" },
    });
  } catch (error) {
    log("warn", "quote.unavailable", {
      route: "GET /api/quote",
      seller,
      error: errorMessage(error),
    });
    return NextResponse.json(
      { ok: false, error: `quote unavailable: ${errorMessage(error)}` },
      { status: 502 },
    );
  }
}

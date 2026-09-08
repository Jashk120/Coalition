import { NextResponse } from "next/server";
import { orchestratorBaseUrl } from "@/lib/pool-state";

export const dynamic = "force-dynamic";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * GET /api/terms — terms.json proxy for the usage/budget panel.
 * The orchestrator builds the document live from its config; the app only
 * relays it so the UI quotes the same terms the chain's resourceURI points to.
 */
export async function GET(): Promise<Response> {
  try {
    const response = await fetch(`${orchestratorBaseUrl()}/terms.json`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      return NextResponse.json(
        { ok: false, error: `terms endpoint returned ${String(response.status)}` },
        { status: 502 },
      );
    }
    const body: unknown = await response.json();
    return NextResponse.json({ ok: true, terms: body });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: `terms unavailable: ${errorMessage(error)}` },
      { status: 502 },
    );
  }
}

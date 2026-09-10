import { NextResponse } from "next/server";
import { fetchQuote } from "@jx-nexus/coalition";
import { SEED_META } from "@/lib/constants";
import { log } from "@/lib/logger";
import { orchestratorBaseUrl } from "@/lib/pool-state";

export const dynamic = "force-dynamic";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * GET /api/resale/market — per-agent spare readout for the resale market
 * section. Read-only fan-out over the SDK's fetchQuote (GET /quote?seller=):
 * {wallet, availableMB, availableCU, ratePerMBAtomic, ratePerCUAtomic} per
 * seed agent; sellers with no allocation surface as empty with the reason
 * instead of failing the whole market. No auth, no writes.
 */
export async function GET(): Promise<NextResponse> {
  const baseUrl = orchestratorBaseUrl();
  const entries = await Promise.all(
    SEED_META.map(async (seed) => {
      const wallet = seed.wallet;
      try {
        const quote = await fetchQuote({ baseUrl, seller: wallet });
        return {
          wallet,
          availableMB: quote.availableMB.toString(),
          availableCU: quote.availableCU.toString(),
          ratePerMBAtomic: quote.ratePerMBAtomic.toString(),
          ratePerCUAtomic: quote.ratePerCUAtomic.toString(),
        };
      } catch (error) {
        const message = errorMessage(error);
        log("info", "resale.market.empty", {
          route: "GET /api/resale/market",
          seller: wallet,
          error: message,
        });
        return {
          wallet,
          availableMB: "0",
          availableCU: "0",
          ratePerMBAtomic: "0",
          ratePerCUAtomic: "0",
          empty: true as const,
          reason:
            "seller holds no orchestrator allocation yet — resale quota appears after settle → allocate",
        };
      }
    }),
  );
  return NextResponse.json({ ok: true, market: entries });
}

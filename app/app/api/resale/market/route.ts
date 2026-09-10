import { NextResponse } from "next/server";
import { fetchQuote } from "@jx-nexus/coalition";
import { log } from "@/lib/logger";
import { orchestratorBaseUrl } from "@/lib/pool-state";

export const dynamic = "force-dynamic";

const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * GET /api/resale/market — per-agent spare readout for the resale market
 * section. Enumerates ACTUAL allocations from orchestrator GET /usage:
 * quota lives on Circle funder addresses, not seed display wallets, so
 * listing seeds would show an all-empty market. Each allocated wallet is
 * then priced via the SDK's fetchQuote (GET /quote?seller=):
 * {wallet, availableMB, availableCU, ratePerMBAtomic, ratePerCUAtomic}.
 * Sellers whose quote fails surface as empty with the reason instead of
 * failing the whole market. No auth, no writes.
 */
export async function GET(): Promise<NextResponse> {
  const baseUrl = orchestratorBaseUrl();
  let wallets: string[];
  try {
    const upstream = await fetch(`${baseUrl}/usage`, {
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
    if (!upstream.ok) {
      throw new Error(`usage endpoint returned ${String(upstream.status)}`);
    }
    const body: unknown = await upstream.json();
    if (!isRecord(body) || !Array.isArray(body["agents"])) {
      throw new Error("usage endpoint returned an unexpected shape");
    }
    wallets = [];
    for (const agent of body["agents"] as readonly unknown[]) {
      if (
        isRecord(agent) &&
        typeof agent["wallet"] === "string" &&
        ADDRESS_PATTERN.test(agent["wallet"] as string)
      ) {
        wallets.push(agent["wallet"] as string);
      }
    }
  } catch (error) {
    log("warn", "resale.market.no_usage", {
      route: "GET /api/resale/market",
      error: errorMessage(error),
    });
    return NextResponse.json(
      { ok: false, error: `market unavailable: ${errorMessage(error)}` },
      { status: 502 },
    );
  }
  const entries = await Promise.all(
    wallets.map(async (wallet) => {
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
          reason: `quote unavailable: ${message}`,
        };
      }
    }),
  );
  return NextResponse.json({ ok: true, market: entries });
}

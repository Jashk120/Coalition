import { NextResponse } from "next/server";

import { OUTSIDE_BUYER, SEED_META } from "@/lib/constants";
import {
  createCircleClient,
  getWalletAddress,
  readCircleEnv,
} from "@/lib/circle-fund";
import { log } from "@/lib/logger";

export const dynamic = "force-dynamic";

export type WalletName = {
  readonly address: string;
  readonly ensName: string;
};

export type WalletsResponse =
  | { readonly ok: true; readonly names: readonly WalletName[] }
  | { readonly ok: false; readonly error: string };

/** Short-lived cache: funder addresses change only when wallets rotate. */
const CACHE_TTL_MS = 60_000;
let cache: { readonly at: number; readonly names: readonly WalletName[] } | null =
  null;

/**
 * GET /api/agents/wallets — address → ENS name map for every agent actor
 * the dashboard can display. Static display wallets (SEED_META +
 * OUTSIDE_BUYER) plus the per-index Circle funder addresses
 * (CIRCLE_WALLET_IDS[i] → SEED_META[i].ensName): allocations, quotes, and
 * usage key on funder addresses, so the server resolution is what makes
 * those rows show ENS names. Addresses + names only — never secrets.
 */
export async function GET(): Promise<NextResponse<WalletsResponse>> {
  if (cache !== null && Date.now() - cache.at < CACHE_TTL_MS) {
    return NextResponse.json({ ok: true, names: cache.names });
  }
  const byLower = new Map<string, WalletName>();
  const add = (address: string, ensName: string): void => {
    const key = address.toLowerCase();
    if (!byLower.has(key)) byLower.set(key, { address, ensName });
  };
  for (const seed of SEED_META) add(seed.wallet, seed.ensName);
  add(OUTSIDE_BUYER.wallet, OUTSIDE_BUYER.ensName);
  try {
    const env = readCircleEnv();
    if (env.ok) {
      const client = createCircleClient(env.apiKey, env.entitySecret);
      const resolved = await Promise.all(
        env.walletIds.map((walletId) => getWalletAddress(client, walletId)),
      );
      resolved.forEach((address, index) => {
        const seed = SEED_META[index];
        if (address !== null && seed !== undefined) {
          add(address, seed.ensName);
        }
      });
    }
  } catch (error) {
    log("warn", "wallets.unavailable", {
      route: "GET /api/agents/wallets",
      error: error instanceof Error ? error.message : String(error),
    });
  }
  const names = [...byLower.values()];
  cache = { at: Date.now(), names };
  log("info", "wallets.read", {
    route: "GET /api/agents/wallets",
    names: names.length,
  });
  return NextResponse.json({ ok: true, names });
}

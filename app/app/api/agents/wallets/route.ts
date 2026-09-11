import { NextResponse } from "next/server";

import { OUTSIDE_BUYER, SEED_META } from "@/lib/constants";

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
 * GET /api/agents/wallets — address → ENS name map for the agent actors the
 * dashboard displays. Static agent Circle funder wallets (SEED_META) plus the
 * held-out resale buyer. Addresses + names only — never secrets.
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
  const names = [...byLower.values()];
  cache = { at: Date.now(), names };
  return NextResponse.json({ ok: true, names });
}

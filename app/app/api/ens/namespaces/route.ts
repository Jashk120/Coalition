import { NextResponse } from "next/server";
import type { Address } from "viem";
import {
  DEMO_PARENT_NAME,
  DEMO_SEED_AGENTS,
  findAgentsByOwner,
  resolveArcWallet,
  resolveEnsResolver,
} from "@jx-nexus/coalition";
import { arcPublicClient, sepoliaPublicClient } from "@/lib/chain";
import { IDENTITY_REGISTRY_FROM_BLOCK } from "@/lib/constants";
import { log } from "@/lib/logger";
import type { NamespaceView, NamespacesResponse } from "@/lib/types";

export const dynamic = "force-dynamic";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${String(ms)}ms`));
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

/**
 * GET /api/ens/namespaces — live agents-as-namespaces view.
 * Per seed, in seed order: fresh resolver lookup (never cached),
 * Arc wallet via the Universal Resolver, then ERC-8004 agent ids owned
 * by that wallet. Each seed resolves independently — one missing record
 * yields an explicit null/empty entry, never a fallback wallet and never
 * an exception for the whole response.
 */
export async function GET(): Promise<NextResponse<NamespacesResponse>> {
  const sepoliaClient = sepoliaPublicClient();
  const arcClient = arcPublicClient();
  const namespaces: NamespaceView[] = [];
  for (const seed of DEMO_SEED_AGENTS) {
    let resolver: Address | null = null;
    let resolverNote: string | undefined;
    try {
      resolver = await withTimeout(
        resolveEnsResolver({ publicClient: sepoliaClient, name: seed.ensName }),
        20_000,
        `resolveEnsResolver(${seed.ensName})`,
      );
    } catch (error) {
      resolverNote = errorMessage(error).split("\n")[0] ?? "resolver lookup failed";
    }
    let arcWallet: Address | null = null;
    let walletNote: string | undefined;
    try {
      arcWallet = await withTimeout(
        resolveArcWallet({ publicClient: sepoliaClient, name: seed.ensName }),
        20_000,
        `resolveArcWallet(${seed.ensName})`,
      );
      if (arcWallet === null) {
        walletNote = `no Arc record for "${seed.ensName}"`;
      }
    } catch (error) {
      walletNote = errorMessage(error).split("\n")[0] ?? "wallet lookup failed";
    }
    let agentIds: readonly string[] = [];
    let idsNote: string | undefined;
    if (arcWallet !== null) {
      try {
        const ids = await withTimeout(
          findAgentsByOwner({
            publicClient: arcClient,
            owner: arcWallet,
            fromBlock: IDENTITY_REGISTRY_FROM_BLOCK,
          }),
          30_000,
          `findAgentsByOwner(${arcWallet})`,
        );
        agentIds = ids.map((id) => id.toString());
        if (agentIds.length === 0) {
          idsNote = `wallet ${arcWallet} owns no ERC-8004 agents`;
        }
      } catch (error) {
        idsNote = errorMessage(error).split("\n")[0] ?? "agent-id lookup failed";
      }
    }
    const notes = [resolverNote, walletNote, idsNote].filter(
      (note): note is string => note !== undefined,
    );
    namespaces.push({
      seedId: seed.id,
      name: seed.ensName,
      resolver,
      arcWallet,
      agentIds,
      ...(notes.length === 0 ? {} : { note: notes.join("; ") }),
    });
  }
  log("info", "ens.namespaces.read", {
    route: "GET /api/ens/namespaces",
    seeds: namespaces.length,
    withResolver: namespaces.filter((n) => n.resolver !== null).length,
    withWallet: namespaces.filter((n) => n.arcWallet !== null).length,
  });
  return NextResponse.json({
    ok: true,
    ensParent: DEMO_PARENT_NAME,
    namespaces,
  });
}

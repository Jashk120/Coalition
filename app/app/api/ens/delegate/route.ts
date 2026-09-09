import { NextResponse } from "next/server";
import {
  ARC_COIN_TYPE,
  authorizeAgentRecord,
  setArcAddressRecord,
} from "@jx-nexus/coalition";
import {
  createWalletClient,
  getAddress,
  http,
  isAddress,
  isHex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { log } from "@/lib/logger";
import type { EnsDelegateResponse } from "@/lib/types";

export const dynamic = "force-dynamic";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Server-only Sepolia signer env — never NEXT_PUBLIC_, never in the browser.
 * The owner (name admin) grants/revokes; the agent writes its own record.
 */
function readSignerEnv(): { ok: true; ownerKey: `0x${string}`; agentKey: `0x${string}` } | { ok: false; error: string } {
  const ownerKey = process.env["ENS_OWNER_PRIVATE_KEY"] ?? "";
  const agentKey = process.env["ENS_AGENT_PRIVATE_KEY"] ?? "";
  if (!/^0x[0-9a-fA-F]{64}$/.test(ownerKey) || !isHex(ownerKey)) {
    return {
      ok: false,
      error:
        "Missing ENS_OWNER_PRIVATE_KEY. Set it to the 0x-prefixed Sepolia " +
        "private key of the name admin (server-only, never NEXT_PUBLIC_).",
    };
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(agentKey) || !isHex(agentKey)) {
    return {
      ok: false,
      error:
        "Missing ENS_AGENT_PRIVATE_KEY. Set it to the 0x-prefixed Sepolia " +
        "private key of the agent wallet (server-only, never NEXT_PUBLIC_).",
    };
  }
  return { ok: true, ownerKey, agentKey };
}

function parseCoinType(value: unknown): number | null {
  if (value === undefined) return ARC_COIN_TYPE;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) return null;
  return value;
}

/**
 * POST /api/ens/delegate — judges-visible Enhanced Access Control flow on
 * Sepolia ENSv2 (Permissioned Resolver):
 *
 *   grant (owner: authorizeAddrRoles allowed:true)
 *     -> write (agent: setArcAddressRecord for its OWN name+coinType)
 *     -> revoke (owner: authorizeAddrRoles allowed:false)
 *     -> fail (agent: second setArcAddressRecord reverts; error is the proof)
 *
 * Least-privilege note: EAC `authorizeAddrRoles(dnsName, coinType, wallet,
 * allowed)` scopes the grant to exactly one dnsName + one coinType, so the
 * agent wallet can write only its own Arc record — never a sibling subname
 * and never another coin type. The resolver is always passed explicitly
 * (EAC grants are per-resolver); nothing here is cached or looked up.
 *
 * Body: { name, agentWallet, resolver, coinType? }.
 * Returns the tx hash of each step plus the captured revert error.
 * All signing is server-side; private keys never reach the browser.
 */
export async function POST(req: Request): Promise<NextResponse<EnsDelegateResponse>> {
  let body: unknown;
  try {
    body = (await req.json()) as unknown;
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON body." }, { status: 400 });
  }
  const params =
    typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};

  const name = params["name"];
  const agentWalletRaw = params["agentWallet"];
  const resolverRaw = params["resolver"];
  if (typeof name !== "string" || name.trim() === "") {
    return NextResponse.json(
      { ok: false, error: 'Invalid params: "name" must be a non-empty ENS name.' },
      { status: 400 },
    );
  }
  if (typeof agentWalletRaw !== "string" || !isAddress(agentWalletRaw)) {
    return NextResponse.json(
      { ok: false, error: 'Invalid params: "agentWallet" must be a 0x address.' },
      { status: 400 },
    );
  }
  if (typeof resolverRaw !== "string" || !isAddress(resolverRaw)) {
    return NextResponse.json(
      { ok: false, error: 'Invalid params: "resolver" must be a 0x address (EAC grants are per-resolver).' },
      { status: 400 },
    );
  }
  const coinType = parseCoinType(params["coinType"]);
  if (coinType === null) {
    return NextResponse.json(
      { ok: false, error: 'Invalid params: "coinType" must be a non-negative integer.' },
      { status: 400 },
    );
  }
  const agentWallet = getAddress(agentWalletRaw);
  const resolver = getAddress(resolverRaw);

  const keys = readSignerEnv();
  if (!keys.ok) {
    return NextResponse.json({ ok: false, error: keys.error }, { status: 503 });
  }

  const sepoliaRpc = process.env["SEPOLIA_RPC_URL"] ?? "";
  const transport = sepoliaRpc === "" ? http() : http(sepoliaRpc);
  const ownerAccount = privateKeyToAccount(keys.ownerKey);
  const agentAccount = privateKeyToAccount(keys.agentKey);
  if (ownerAccount.address.toLowerCase() === agentWallet.toLowerCase()) {
    return NextResponse.json(
      { ok: false, error: "Invalid params: agentWallet must differ from the owner signer (least privilege is per-agent)." },
      { status: 400 },
    );
  }
  if (agentAccount.address.toLowerCase() !== agentWallet.toLowerCase()) {
    return NextResponse.json(
      {
        ok: false,
        error:
          "ENS_AGENT_PRIVATE_KEY does not match agentWallet: the write must be " +
          "signed by the grantee itself, otherwise the demo proves nothing.",
      },
      { status: 400 },
    );
  }
  const ownerClient = createWalletClient({ account: ownerAccount, chain: sepolia, transport });
  const agentClient = createWalletClient({ account: agentAccount, chain: sepolia, transport });

  log("info", "ens.delegate.start", {
    route: "POST /api/ens/delegate",
    name,
    agentWallet,
    resolver,
    coinType,
  });

  try {
    // 1. Grant: owner authorizes the agent wallet for this name+coinType only.
    const granted = await authorizeAgentRecord({
      walletClient: ownerClient,
      account: ownerAccount,
      name,
      resolver,
      agentWallet,
      allowed: true,
      coinType,
    });

    // 2. Write as the agent: its own Arc record (arcWallet === agentWallet).
    const written = await setArcAddressRecord({
      walletClient: agentClient,
      account: agentAccount,
      name,
      arcWallet: agentWallet,
      resolver,
      coinType,
    });

    // 3. Revoke: owner removes the grant.
    const revoked = await authorizeAgentRecord({
      walletClient: ownerClient,
      account: ownerAccount,
      name,
      resolver,
      agentWallet,
      allowed: false,
      coinType,
    });

    // 4. Fail: the same agent write must now revert; the error is the proof
    // that the earlier write succeeded through EAC, not through open access.
    let revokedWriteError: string | null = null;
    try {
      await setArcAddressRecord({
        walletClient: agentClient,
        account: agentAccount,
        name,
        arcWallet: agentWallet,
        resolver,
        coinType,
      });
    } catch (error) {
      revokedWriteError = errorMessage(error);
    }
    if (revokedWriteError === null) {
      log("warn", "ens.delegate.no_revert", {
        route: "POST /api/ens/delegate",
        name,
        grantTxHash: granted.hash,
        writeTxHash: written.hash,
        revokeTxHash: revoked.hash,
      });
      return NextResponse.json(
        {
          ok: false,
          error:
            "Post-revoke write unexpectedly succeeded " +
            `(grant ${granted.hash}, write ${written.hash}, revoke ${revoked.hash}): ` +
            "EAC did not enforce the revoke — verify the resolver supports authorizeAddrRoles.",
        },
        { status: 500 },
      );
    }

    log("info", "ens.delegate.complete", {
      route: "POST /api/ens/delegate",
      name,
      grantTxHash: granted.hash,
      writeTxHash: written.hash,
      revokeTxHash: revoked.hash,
    });
    return NextResponse.json({
      ok: true,
      name,
      agentWallet,
      resolver,
      coinType,
      grantTxHash: granted.hash,
      writeTxHash: written.hash,
      revokeTxHash: revoked.hash,
      revokedWriteError,
    });
  } catch (error) {
    return NextResponse.json({ ok: false, error: errorMessage(error) }, { status: 500 });
  }
}

import { NextResponse } from "next/server";
import {
  DEFAULT_PARENT_NAME,
  registerAndVerifySubname,
} from "@jx-nexus/coalition";
import { createWalletClient, http, isAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import type { Address } from "viem";
import { sepoliaPublicClient } from "@/lib/chain";
import { log } from "@/lib/logger";

export const dynamic = "force-dynamic";

export type RegisterVerifyResponse =
  | {
      readonly ok: true;
      readonly name: string;
      readonly registerTx: string;
      readonly arcWallet: string;
      readonly resolver: string;
    }
  | { readonly ok: false; readonly error: string };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseAddress(value: unknown): Address | null {
  return typeof value === "string" && isAddress(value) ? value : null;
}

function parseBigint(value: unknown): bigint | null {
  if (typeof value === "string" && value.trim() !== "") {
    try {
      return BigInt(value.trim());
    } catch {
      return null;
    }
  }
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
    return BigInt(value);
  }
  return null;
}

/**
 * POST /api/ens/register-verify — live ENSv2 subname registration +
 * wildcard verification on Sepolia.
 *
 * Registers `label.parentName` (default `agentpool.eth`) via the SDK's
 * `registerSubname`, waits for inclusion, then wildcard-resolves it through
 * the Universal Resolver (`resolveArcWallet`). This path is STRICT: a
 * missing Arc record after registration is an error — there is no
 * fallback wallet, so success proves ENS is loadbearing.
 *
 * Body (JSON): `{ label, owner, registry, resolver, registrar,
 *   roleBitmap?, expiry?, parentName?, coinType?, universalResolver? }`.
 * Addresses are overridable per call; the signer comes from the server-only
 * `SEPOLIA_PRIVATE_KEY` env (never a checked-in literal).
 */
export async function POST(
  request: Request,
): Promise<NextResponse<RegisterVerifyResponse>> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { ok: false, error: "invalid JSON body" },
      { status: 400 },
    );
  }
  if (typeof body !== "object" || body === null) {
    return NextResponse.json(
      { ok: false, error: "body must be a JSON object" },
      { status: 400 },
    );
  }
  const fields: Record<string, unknown> = body as Record<string, unknown>;

  const label = fields["label"];
  if (typeof label !== "string" || label === "" || label.includes(".")) {
    return NextResponse.json(
      { ok: false, error: 'label must be a non-empty single label (no dots)' },
      { status: 400 },
    );
  }

  const owner = parseAddress(fields["owner"]);
  const registry = parseAddress(fields["registry"]);
  const resolverAddress = parseAddress(fields["resolver"]);
  const registrar = parseAddress(fields["registrar"]);
  if (owner === null || registry === null || resolverAddress === null || registrar === null) {
    return NextResponse.json(
      {
        ok: false,
        error: "owner, registry, resolver, and registrar must be valid addresses",
      },
      { status: 400 },
    );
  }

  const roleBitmap =
    fields["roleBitmap"] === undefined ? 0n : parseBigint(fields["roleBitmap"]);
  const expiry =
    fields["expiry"] === undefined
      ? BigInt(Math.floor(Date.now() / 1000) + 365 * 24 * 60 * 60)
      : parseBigint(fields["expiry"]);
  if (roleBitmap === null || expiry === null) {
    return NextResponse.json(
      { ok: false, error: "roleBitmap and expiry must be bigint-parsable" },
      { status: 400 },
    );
  }

  const parentName =
    fields["parentName"] === undefined
      ? DEFAULT_PARENT_NAME
      : typeof fields["parentName"] === "string" && fields["parentName"] !== ""
        ? fields["parentName"]
        : null;
  if (parentName === null) {
    return NextResponse.json(
      { ok: false, error: "parentName must be a non-empty string" },
      { status: 400 },
    );
  }

  const coinType =
    fields["coinType"] === undefined
      ? undefined
      : typeof fields["coinType"] === "number" &&
          Number.isInteger(fields["coinType"]) &&
          fields["coinType"] >= 0
        ? fields["coinType"]
        : null;
  if (coinType === null) {
    return NextResponse.json(
      { ok: false, error: "coinType must be a non-negative integer" },
      { status: 400 },
    );
  }

  const universalResolver =
    fields["universalResolver"] === undefined
      ? undefined
      : parseAddress(fields["universalResolver"]);
  if (universalResolver === null) {
    return NextResponse.json(
      { ok: false, error: "universalResolver must be a valid address" },
      { status: 400 },
    );
  }

  const privateKey = process.env["SEPOLIA_PRIVATE_KEY"];
  if (privateKey === undefined || !/^0x[0-9a-fA-F]{64}$/.test(privateKey)) {
    return NextResponse.json(
      { ok: false, error: "SEPOLIA_PRIVATE_KEY is not configured" },
      { status: 503 },
    );
  }

  const started = Date.now();
  log("info", "ens.register-verify.start", {
    route: "POST /api/ens/register-verify",
    label,
    parentName,
  });

  try {
    const account = privateKeyToAccount(privateKey as `0x${string}`);
    const sepoliaRpc = process.env["SEPOLIA_RPC_URL"];
    const walletClient = createWalletClient({
      account,
      chain: sepolia,
      transport:
        sepoliaRpc === undefined || sepoliaRpc === ""
          ? http()
          : http(sepoliaRpc),
    });

    const result = await registerAndVerifySubname({
      walletClient,
      account,
      sepoliaClient: sepoliaPublicClient(),
      registrar,
      label,
      parentName,
      owner,
      registry,
      resolver: resolverAddress,
      roleBitmap,
      expiry,
      ...(coinType === undefined ? {} : { coinType }),
      ...(universalResolver === undefined ? {} : { universalResolver }),
    });

    log("info", "ens.register-verify.complete", {
      route: "POST /api/ens/register-verify",
      name: result.name,
      registerTx: result.registerTx,
      durationMs: Date.now() - started,
    });

    return NextResponse.json({
      ok: true,
      name: result.name,
      registerTx: result.registerTx,
      arcWallet: result.arcWallet,
      resolver: result.resolver,
    });
  } catch (error) {
    log("info", "ens.register-verify.failed", {
      route: "POST /api/ens/register-verify",
      label,
      error: errorMessage(error),
    });
    const response: RegisterVerifyResponse = {
      ok: false,
      error: errorMessage(error),
    };
    return NextResponse.json(response, { status: 500 });
  }
}

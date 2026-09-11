import { AppKit, type SendParams } from "@circle-fin/app-kit";
import { createCircleWalletsAdapter } from "@circle-fin/adapter-circle-wallets";
import type { TreasurySendStep } from "./types";

/**
 * Server-only App Kit treasury rail. App Kit moves tokens (send/bridge/swap/
 * unified balance); it cannot call arbitrary contracts, so this funds Arc
 * wallets while the existing DCW approve + `pool.commit` flow stays unchanged.
 * Chain names use App Kit's spelling (`Arc_Testnet`), not the DCW `ARC-TESTNET`.
 */
const ARC_CHAIN = "Arc_Testnet" as const;

export const TREASURY_SETUP_HINT =
  "Create a Circle developer-controlled Arc Testnet wallet for the treasury, " +
  "fund it with testnet USDC at https://faucet.circle.com, then set " +
  "CIRCLE_TREASURY_WALLET_ID (defaults to CIRCLE_PROVIDER_WALLET_ID when unset).";

export type TreasuryEnv =
  | {
      readonly ok: true;
      readonly apiKey: string;
      readonly entitySecret: string;
      readonly treasuryWalletId: string;
    }
  | { readonly ok: false; readonly error: string };

export function readTreasuryEnv(): TreasuryEnv {
  const missing: string[] = [];
  const apiKey = process.env["CIRCLE_API_KEY"] ?? "";
  if (apiKey === "") missing.push("CIRCLE_API_KEY");
  const entitySecret = process.env["CIRCLE_ENTITY_SECRET"] ?? "";
  if (entitySecret === "") missing.push("CIRCLE_ENTITY_SECRET");
  const treasuryWalletId =
    process.env["CIRCLE_TREASURY_WALLET_ID"] ??
    process.env["CIRCLE_PROVIDER_WALLET_ID"] ??
    "";
  if (treasuryWalletId === "") {
    missing.push("CIRCLE_TREASURY_WALLET_ID (or CIRCLE_PROVIDER_WALLET_ID)");
  }
  if (missing.length > 0) {
    return {
      ok: false,
      error: `Missing ${missing.join(", ")}. ${TREASURY_SETUP_HINT}`,
    };
  }
  return { ok: true, apiKey, entitySecret, treasuryWalletId };
}

/** Per-recipient funding amount when the request omits one (decimal USDC). */
export function defaultFundUsdc(): string {
  const raw = process.env["CIRCLE_TREASURY_FUND_USDC"];
  return raw !== undefined && raw.trim() !== "" ? raw.trim() : "2.50";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Send `amountUsdc` USDC on Arc Testnet from the treasury DCW to `to` via
 * App Kit. Hard errors (auth/validation) resolve as an error step so a fan-out
 * over recipients keeps going instead of aborting on the first failure.
 */
export async function sendUsdcFromTreasury(args: {
  readonly apiKey: string;
  readonly entitySecret: string;
  readonly fromAddress: string;
  readonly to: string;
  readonly amountUsdc: string;
}): Promise<TreasurySendStep> {
  try {
    const kit = new AppKit();
    const adapter = createCircleWalletsAdapter({
      apiKey: args.apiKey,
      entitySecret: args.entitySecret,
    });
    const params: SendParams = {
      from: { adapter, chain: ARC_CHAIN, address: args.fromAddress },
      to: args.to,
      amount: args.amountUsdc,
      token: "USDC",
    };
    const step = await kit.send(params);
    return {
      to: args.to,
      amountUsdc: args.amountUsdc,
      state: step.state,
      txHash: step.txHash ?? null,
      explorerUrl: step.explorerUrl ?? null,
      ...(step.state === "success" || step.errorMessage === undefined
        ? {}
        : { error: step.errorMessage }),
    };
  } catch (error) {
    return {
      to: args.to,
      amountUsdc: args.amountUsdc,
      state: "error",
      txHash: null,
      explorerUrl: null,
      error: errorMessage(error),
    };
  }
}

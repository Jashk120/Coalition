import { encodeFunctionData, erc20Abi, type Address, type Hex } from "viem";
import { OUTSIDE_BUYER, RESALE_USDC_ADDRESS } from "./constants";

export const MULTICALL3_ADDRESS =
  "0xcA11bde05977b3631167028862bE2a173976CA11" as Address;

export type FillPlanOutput = {
  readonly account: string;
  readonly amountAtomic: string;
};

export type FillPlanResponse = {
  readonly outputs: readonly FillPlanOutput[];
  readonly totalAtomic: string;
  readonly nonce: string;
  readonly roundId: string;
  readonly headroomMB: number;
  readonly headroomCUMicro: number;
};

export type FillPlanWant = {
  readonly mem: number;
  readonly cuMicro: number;
};

const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
const UINT_PATTERN = /^\d+$/;
const NONCE_PATTERN = /^[0-9a-fA-F]{64}$/;

/** Exact "$d.ffffff" price for 6-decimal atomic USDC; round-trips parsePrice. */
export function atomicToUsdcPrice(atomic: string | bigint): string {
  const value = typeof atomic === "bigint" ? atomic : BigInt(atomic);
  const whole = value / 1000000n;
  const frac = (value % 1000000n)
    .toString()
    .padStart(6, "0")
    .replace(/0+$/, "");
  return frac === "" ? `$${whole.toString()}` : `$${whole.toString()}.${frac}`;
}

export type BuyerEnv =
  | {
      readonly ok: true;
      readonly apiKey: string;
      readonly entitySecret: string;
      readonly buyerWalletId: string;
      readonly buyerAddress: Address;
    }
  | { readonly ok: false; readonly error: string };

/**
 * Server-only buyer creds. Reuses CIRCLE_API_KEY/SECRET plus the held-out
 * CIRCLE_BUYER_WALLET_ID — never CIRCLE_WALLET_IDS (funding loop) and no
 * new env var, no local key.
 */
export function readBuyerEnv(): BuyerEnv {
  const missing: string[] = [];
  const apiKey = process.env["CIRCLE_API_KEY"] ?? "";
  if (apiKey === "") missing.push("CIRCLE_API_KEY");
  const entitySecret = process.env["CIRCLE_ENTITY_SECRET"] ?? "";
  if (entitySecret === "") missing.push("CIRCLE_ENTITY_SECRET");
  const buyerWalletId = process.env["CIRCLE_BUYER_WALLET_ID"] ?? "";
  if (buyerWalletId === "") missing.push("CIRCLE_BUYER_WALLET_ID");
  if (missing.length > 0) {
    return {
      ok: false,
      error:
        `Missing ${missing.join(", ")}. Create the agent-5 buyer wallet with ` +
        `app/create-buyer-wallet.mjs, fund it at https://faucet.circle.com, ` +
        `then set CIRCLE_BUYER_WALLET_ID (kept out of CIRCLE_WALLET_IDS).`,
    };
  }
  return {
    ok: true,
    apiKey,
    entitySecret,
    buyerWalletId,
    buyerAddress: OUTSIDE_BUYER.wallet as Address,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Strict fill-plan validation for the atomic settlement shape. */
export function parseFillPlan(value: unknown): FillPlanResponse {
  if (!isRecord(value)) throw new Error("plan is not an object");
  const rawOutputs = value["outputs"];
  const totalAtomic = value["totalAtomic"];
  const nonce = value["nonce"];
  const roundId = value["roundId"];
  const headroomMB = value["headroomMB"];
  const headroomCUMicro = value["headroomCUMicro"];
  if (!Array.isArray(rawOutputs) || rawOutputs.length === 0) {
    throw new Error("plan needs non-empty outputs[]");
  }
  if (typeof totalAtomic !== "string" || !UINT_PATTERN.test(totalAtomic)) {
    throw new Error("plan totalAtomic malformed");
  }
  if (typeof nonce !== "string" || !NONCE_PATTERN.test(nonce)) {
    throw new Error("plan nonce malformed");
  }
  if (typeof roundId !== "string" || roundId.trim() === "") {
    throw new Error("plan roundId malformed");
  }
  if (
    typeof headroomMB !== "number" ||
    !Number.isInteger(headroomMB) ||
    headroomMB < 0
  ) {
    throw new Error("plan headroomMB malformed");
  }
  if (
    typeof headroomCUMicro !== "number" ||
    !Number.isInteger(headroomCUMicro) ||
    headroomCUMicro < 0
  ) {
    throw new Error("plan headroomCUMicro malformed");
  }
  const outputs: FillPlanOutput[] = rawOutputs.map((entry) => {
    if (!isRecord(entry)) throw new Error("plan output is not an object");
    const account = entry["account"];
    const amountAtomic = entry["amountAtomic"];
    if (typeof account !== "string" || !ADDRESS_PATTERN.test(account)) {
      throw new Error("plan output account malformed");
    }
    if (
      typeof amountAtomic !== "string" ||
      !UINT_PATTERN.test(amountAtomic) ||
      BigInt(amountAtomic) <= 0n
    ) {
      throw new Error("plan output amountAtomic malformed");
    }
    return { account, amountAtomic };
  });
  for (let i = 1; i < outputs.length; i++) {
    const prev = outputs[i - 1]?.account ?? "";
    const current = outputs[i]?.account ?? "";
    if (prev >= current) throw new Error("plan outputs must be wallet-asc unique");
  }
  let sum = 0n;
  for (const output of outputs) sum += BigInt(output.amountAtomic);
  if (sum !== BigInt(totalAtomic)) {
    throw new Error("plan outputs sum does not equal totalAtomic");
  }
  return { outputs, totalAtomic, nonce, roundId, headroomMB, headroomCUMicro };
}

/** Mint dimensions the plan route echoes into the plan for the buy route. */
export function parsePlanWant(value: unknown): FillPlanWant {
  if (!isRecord(value)) throw new Error("plan carries no want {mem, cuMicro}");
  const mem = value["mem"];
  const cuMicro = value["cuMicro"];
  if (typeof mem !== "number" || !Number.isInteger(mem) || mem < 0) {
    throw new Error("plan want mem malformed");
  }
  if (
    typeof cuMicro !== "number" ||
    !Number.isInteger(cuMicro) ||
    cuMicro < 0
  ) {
    throw new Error("plan want cuMicro malformed");
  }
  if (mem === 0 && cuMicro === 0) throw new Error("plan want is empty");
  return { mem, cuMicro };
}

/**
 * One USDC transferFrom(buyer -> agent) calldata per fill-plan output, kept
 * in the wallet-asc order the plan was issued in.
 */
export function buildSettlementCalls(args: {
  readonly buyer: Address;
  readonly outputs: readonly FillPlanOutput[];
}): readonly (readonly [target: Address, callData: Hex])[] {
  return args.outputs.map(
    (output) =>
      [
        RESALE_USDC_ADDRESS as Address,
        encodeFunctionData({
          abi: erc20Abi,
          functionName: "transferFrom",
          args: [args.buyer, output.account as Address, BigInt(output.amountAtomic)],
        }),
      ] as const,
  );
}

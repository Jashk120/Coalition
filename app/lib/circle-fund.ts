import { randomUUID } from "node:crypto";
import {
  initiateDeveloperControlledWalletsClient,
  type CircleDeveloperControlledWalletsClient,
} from "@circle-fin/developer-controlled-wallets";

/**
 * Headless on-chain funding via Circle Developer-Controlled Wallets.
 *
 * Server-only helpers for `POST /api/agents/fund`: env parsing, client
 * construction, and a single contract-execution round trip (submit +
 * poll to a terminal state). Wallets are always driven sequentially by
 * the route — nothing here fans out in parallel.
 */

/** USDC token contract on Arc testnet (approve target). */
export const USDC_ADDRESS = "0x3600000000000000000000000000000000000000";

/** One-line setup hint returned alongside missing-env errors. */
export const CIRCLE_SETUP_HINT =
  "Set CIRCLE_API_KEY, CIRCLE_ENTITY_SECRET, CIRCLE_WALLET_IDS: " +
  "create an API key at console.circle.com/api-keys, register the entity " +
  "secret once, create ARC-TESTNET wallets, fund via https://faucet.circle.com.";

export type CircleClient = CircleDeveloperControlledWalletsClient;

export type CircleEnv =
  | {
      readonly ok: true;
      readonly apiKey: string;
      readonly entitySecret: string;
      readonly walletIds: readonly string[];
    }
  | { readonly ok: false; readonly error: string };

/**
 * Read server-only Circle env. Missing/empty vars yield a 503-style
 * error naming each missing var plus the setup hint — never throw.
 */
export function readCircleEnv(): CircleEnv {
  const missing: string[] = [];
  const apiKey = process.env["CIRCLE_API_KEY"] ?? "";
  if (apiKey === "") missing.push("CIRCLE_API_KEY");
  const entitySecret = process.env["CIRCLE_ENTITY_SECRET"] ?? "";
  if (entitySecret === "") missing.push("CIRCLE_ENTITY_SECRET");
  const rawWalletIds = process.env["CIRCLE_WALLET_IDS"] ?? "";
  const walletIds = rawWalletIds
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
  if (walletIds.length === 0) missing.push("CIRCLE_WALLET_IDS");
  if (missing.length > 0) {
    return {
      ok: false,
      error: `Missing ${missing.join(", ")}. ${CIRCLE_SETUP_HINT}`,
    };
  }
  return { ok: true, apiKey, entitySecret, walletIds };
}

/** Build a Circle client from validated server-only credentials. */
export function createCircleClient(
  apiKey: string,
  entitySecret: string,
): CircleClient {
  return initiateDeveloperControlledWalletsClient({ apiKey, entitySecret });
}

/**
 * Resolve a Circle wallet id to its on-chain address. Null when the
 * lookup fails — callers treat null as unknown and fund as before,
 * never as a zero address.
 */
export async function getWalletAddress(
  client: CircleClient,
  walletId: string,
): Promise<string | null> {
  try {
    const fetched = await client.getWallet({ id: walletId });
    const address = fetched.data?.wallet?.address;
    return address === undefined || address === "" ? null : address;
  } catch {
    return null;
  }
}

export type ContractExecutionResult =
  | { readonly ok: true; readonly txHash: string }
  | { readonly ok: false; readonly error: string };

/** States Circle reports for a transaction that reached the chain. */
const SUCCESS_STATES: readonly string[] = ["CONFIRMED", "COMPLETE"];

/** Terminal states where the chain will never confirm the transaction. */
const FAILURE_STATES: readonly string[] = [
  "FAILED",
  "DENIED",
  "CANCELLED",
  "STUCK",
];

const POLL_INTERVAL_MS = 1_000;
const POLL_JITTER_MS = 250;
const POLL_TIMEOUT_MS = 120_000;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Submit one contract execution and poll `getTransaction` to a terminal
 * state. Resolves funded only on CONFIRMED/COMPLETE with a tx hash;
 * FAILED/DENIED/CANCELLED/STUCK, a missing hash, or the ~120s timeout
 * resolve as a failed step so the caller can continue to the next wallet.
 * All ABI parameters must be decimal strings — never numbers or bigint.
 */
export async function executeContractAndWait(
  client: CircleClient,
  args: {
    readonly walletId: string;
    readonly contractAddress: string;
    readonly abiFunctionSignature: string;
    readonly abiParameters: readonly string[];
  },
): Promise<ContractExecutionResult> {
  let transactionId: string;
  try {
    const created = await client.createContractExecutionTransaction({
      walletId: args.walletId,
      contractAddress: args.contractAddress,
      abiFunctionSignature: args.abiFunctionSignature,
      abiParameters: [...args.abiParameters],
      fee: { type: "level", config: { feeLevel: "MEDIUM" } },
      idempotencyKey: randomUUID(),
    });
    const id = created.data?.id;
    if (id === undefined || id === "") {
      return {
        ok: false,
        error: "Circle contract execution returned no transaction id",
      };
    }
    transactionId = id;
  } catch (error) {
    return {
      ok: false,
      error: `Circle contract execution failed: ${errorMessage(error)}`,
    };
  }

  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let lastState = "UNKNOWN";
  while (Date.now() < deadline) {
    try {
      const fetched = await client.getTransaction({ id: transactionId });
      const transaction = fetched.data?.transaction;
      const state = transaction?.state ?? "UNKNOWN";
      lastState = state;
      if (SUCCESS_STATES.includes(state)) {
        const txHash = transaction?.txHash;
        if (txHash === undefined || txHash === "") {
          return {
            ok: false,
            error: `Circle transaction ${transactionId} reached ${state} without a tx hash`,
          };
        }
        return { ok: true, txHash };
      }
      if (FAILURE_STATES.includes(state)) {
        return {
          ok: false,
          error: `Circle transaction ${transactionId} ended in state ${state}`,
        };
      }
    } catch (error) {
      lastState = `poll error: ${errorMessage(error)}`;
    }
    await sleep(POLL_INTERVAL_MS + Math.floor(Math.random() * (POLL_JITTER_MS + 1)));
  }
  return {
    ok: false,
    error: `Circle transaction ${transactionId} timed out after 120s (last state: ${lastState})`,
  };
}

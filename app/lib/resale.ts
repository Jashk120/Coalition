import type { Address, Hex } from "viem";
import { toAccount } from "viem/accounts";
import { createEIP1193Provider } from "@circle-fin/developer-controlled-wallets/evm";
import { x402Client, x402HTTPClient } from "@x402/core/client";
import type { PaymentRequired } from "@x402/core/types";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import {
  CompositeEvmScheme,
  registerBatchScheme,
} from "@circle-fin/x402-batching/client";
import { OUTSIDE_BUYER, RESALE_GATEWAY_WALLET, RESALE_USDC_ADDRESS } from "./constants";
import { createCircleClient, executeContractAndWait } from "./circle-fund";

/**
 * Resale shared shapes + buyer signer. Server-only: touches Circle creds.
 *
 * Byte-for-byte contract with the orchestrator (see
 * orchestrator/internal/api/x402.go handleFillPlan + transfer.go
 * handleTransferMulti): fill-plan request {wallet, cu, mem} and response
 * {sellers:[{wallet,mb,cuMicro,amountAtomic}], totalAtomic}; transfer-quota
 * legs [{seller,mb,cu}] with payments [{seller,amountAtomic,settlementId}].
 */

export type FillPlanRequest = {
  readonly wallet: string;
  readonly cu: number;
  readonly mem: number;
};

export type FillPlanLeg = {
  readonly wallet: string;
  readonly mb: number;
  readonly cuMicro: number;
  readonly amountAtomic: string;
};

export type FillPlanResponse = {
  readonly sellers: readonly FillPlanLeg[];
  readonly totalAtomic: string;
};

export type TransferQuotaLeg = {
  readonly seller: string;
  readonly mb: number;
  readonly cu: number;
};

export type TransferQuotaPayment = {
  readonly seller: string;
  readonly amountAtomic: string;
  readonly settlementId: string;
};

const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
const UINT_PATTERN = /^\d+$/;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

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
        `deposit Gateway balance (see app/fund-buyer-gateway.mjs), then set ` +
        `CIRCLE_BUYER_WALLET_ID (kept out of CIRCLE_WALLET_IDS).`,
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

const EIP712_DOMAIN_FIELDS = [
  { name: "name", type: "string" },
  { name: "version", type: "string" },
  { name: "chainId", type: "uint256" },
  { name: "verifyingContract", type: "address" },
] as const;

function jsonSafe(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
        key,
        jsonSafe(entry),
      ]),
    );
  }
  return value;
}

/**
 * Buyer signer on the proven path: a viem custom Account whose signTypedData
 * delegates to the Circle dev-controlled EIP-1193 provider
 * (eth_signTypedData_v4 against the buyer wallet — a live spike already
 * returned a 132-char ECDSA sig from this wallet, EOA-type so no SCA
 * lazy-deploy issue). In-memory signing over HTTPS only; no local EOA key,
 * no filesystem state (Vercel-safe). Message/messageNonce senders are
 * unsupported on purpose and throw — only typed-data auth is ever called.
 */
export function createBuyerAccount(args: {
  readonly apiKey: string;
  readonly entitySecret: string;
  readonly buyerAddress: Address;
}) {
  const { apiKey, entitySecret, buyerAddress } = args;
  return toAccount({
    address: buyerAddress,
    signMessage: async (): Promise<Hex> => {
      throw new Error("buyer account signs EIP-712 typed data only");
    },
    signTransaction: async (): Promise<Hex> => {
      throw new Error("buyer account signs EIP-712 typed data only");
    },
    signTypedData: async (parameters): Promise<Hex> => {
      const domain = parameters.domain;
      if (domain === undefined) throw new Error("typed data missing domain");
      const domainRecord = domain as unknown as Record<string, unknown>;
      const chainId = domainRecord["chainId"];
      if (typeof chainId !== "number")
        throw new Error("typed data domain missing numeric chainId");
      const rawTypes = parameters.types as unknown as Record<string, unknown>;
      // Circle's typed-data validator rejects domain fields undeclared in
      // types ("extra data provided in the message (0 < 4)" when the scheme
      // omits EIP712Domain): backfill the standard entry only when the
      // scheme did not supply its own and the domain is exactly the Gateway
      // shape, otherwise pass through untouched. Verified live against the
      // sign endpoint. The only other transform is bigint-safe jsonSafe.
      const types =
        "EIP712Domain" in rawTypes ||
        !(
          Object.keys(domainRecord).length === 4 &&
          "name" in domainRecord &&
          "version" in domainRecord &&
          "chainId" in domainRecord &&
          "verifyingContract" in domainRecord
        )
          ? jsonSafe(rawTypes)
          : {
              EIP712Domain: EIP712_DOMAIN_FIELDS,
              ...(jsonSafe(rawTypes) as Record<string, unknown>),
            };
      const typedDataJson = JSON.stringify({
        types,
        primaryType: parameters.primaryType,
        domain: jsonSafe(domainRecord),
        message: jsonSafe(parameters.message as unknown),
      });
      const provider = createEIP1193Provider({
        apiKey,
        entitySecret,
        chain: 5042002,
      });
      const signature = await provider.request({
        method: "eth_signTypedData_v4",
        params: [buyerAddress, typedDataJson],
      });
      if (typeof signature !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(signature)) {
        throw new Error("buyer typed-data signature has an unexpected shape");
      }
      return signature as Hex;
    },
  });
}

export type BuyerPayClient = {
  readonly client: x402Client;
  readonly httpClient: x402HTTPClient;
};

export type BuyerAccount = ReturnType<typeof createBuyerAccount>;

/**
 * Buyer x402 client: BatchEvmScheme for Gateway legs with ExactEvmScheme
 * fallback via CompositeEvmScheme (registerBatchScheme handles the
 * same-scheme dispatch). Default $1 spend cap is disabled: plan legs are
 * computed by our own orchestrator relay and routinely exceed $1.
 */
export function createBuyerPayClient(account: BuyerAccount): BuyerPayClient {
  const client = new x402Client();
  client.setSpendControls(false);
  registerBatchScheme(client, {
    signer: account,
    fallbackScheme: new ExactEvmScheme(account),
  });
  return { client, httpClient: new x402HTTPClient(client) };
}

export function isCompositeScheme(scheme: unknown): scheme is CompositeEvmScheme {
  return scheme instanceof CompositeEvmScheme;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parsePaymentRequiredDoc(value: unknown): PaymentRequired {
  if (!isRecord(value)) throw new Error("402 body is not a payment doc");
  const version = value["x402Version"];
  const accepts = value["accepts"];
  if (typeof version !== "number" || !Array.isArray(accepts)) {
    throw new Error("402 payment doc has no x402Version/accepts");
  }
  for (const entry of accepts) {
    if (
      !isRecord(entry) ||
      typeof entry["network"] !== "string" ||
      typeof entry["amount"] !== "string" ||
      typeof entry["payTo"] !== "string"
    ) {
      throw new Error("402 accepts entry is malformed");
    }
  }
  return value as unknown as PaymentRequired;
}

function headerOf(headers: Headers, name: string): string | null {
  const direct = headers.get(name);
  if (direct !== null) return direct;
  return headers.get(name.toLowerCase());
}

/**
 * Pay one quota leg against our own 402 route (mirrors GatewayClient.pay
 * internals: initial POST → 402 PAYMENT-REQUIRED header → sign → retry with
 * payment-signature). GatewayClient itself needs a raw private key, which
 * must never exist here — hence BatchEvmScheme over the Circle-backed
 * account plus manual fetch. Returns the leg cost with its settlement proof.
 */
export async function payQuotaLeg(args: {
  readonly quotaUrl: string;
  readonly seller: string;
  readonly mb: number;
  readonly cu: number;
  readonly httpClient: x402HTTPClient;
  readonly preferredNetwork: string;
}): Promise<{ readonly amountAtomic: string; readonly settlementId: string }> {
  const body = JSON.stringify({
    seller: args.seller,
    mb: args.mb,
    cu: args.cu,
  });
  const first = await fetch(args.quotaUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
    cache: "no-store",
    signal: AbortSignal.timeout(60_000),
  });
  if (first.status !== 402) {
    throw new Error(`quota leg expected 402, got ${String(first.status)}`);
  }
  const requiredRaw = headerOf(first.headers, "payment-required");
  if (requiredRaw === null || requiredRaw === "") {
    throw new Error("402 response carries no payment-required header");
  }
  let required: PaymentRequired;
  try {
    required = parsePaymentRequiredDoc(
      JSON.parse(Buffer.from(requiredRaw, "base64").toString("utf-8")) as unknown,
    );
  } catch (error) {
    throw new Error(`cannot decode 402 payment doc: ${errorMessage(error)}`);
  }
  const accepts = (required.accepts ?? []) as readonly {
    readonly network: string;
    readonly amount: string;
  }[];
  const selected =
    accepts.find((entry) => entry.network === args.preferredNetwork) ??
    accepts[0];
  if (selected === undefined) throw new Error("402 doc lists no payment option");
  const narrowed: PaymentRequired = {
    ...(required as unknown as Record<string, unknown>),
    accepts: [selected],
  } as unknown as PaymentRequired;
  const payload = await args.httpClient.createPaymentPayload(narrowed);
  const paymentHeaders = args.httpClient.encodePaymentSignatureHeader(payload);
  const paid = await fetch(args.quotaUrl, {
    method: "POST",
    headers: { "content-type": "application/json", ...paymentHeaders },
    body,
    cache: "no-store",
    signal: AbortSignal.timeout(120_000),
  });
  const settleRaw = headerOf(paid.headers, "payment-response");
  let headerTransaction: string | null = null;
  if (settleRaw !== null && settleRaw !== "") {
    try {
      const decoded = JSON.parse(
        Buffer.from(settleRaw, "base64").toString("utf-8"),
      ) as unknown;
      if (
        isRecord(decoded) &&
        typeof decoded["transaction"] === "string" &&
        decoded["transaction"] !== ""
      ) {
        headerTransaction = decoded["transaction"];
      }
    } catch {
      headerTransaction = null;
    }
  }
  if (!paid.ok) {
    const text = await paid.text().catch(() => "");
    throw new Error(
      `quota leg payment failed with ${String(paid.status)}${text === "" ? "" : `: ${text.slice(0, 200)}`}`,
    );
  }
  const paidBody = (await paid.json().catch(() => null)) as unknown;
  // Settlement extraction, first wins: (1) route JSON {settlementId} built
  // from req.payment.transaction (the Gateway settle transaction the
  // middleware attaches after inline verify+settle); (2) the PAYMENT-RESPONSE
  // header's transaction field carrying the same value.
  const bodySettlement =
    isRecord(paidBody) && typeof paidBody["settlementId"] === "string"
      ? paidBody["settlementId"]
      : null;
  const settlementId = bodySettlement ?? headerTransaction;
  if (settlementId === null || settlementId === "") {
    throw new Error("paid quota leg returned no settlement id");
  }
  const amountAtomic =
    isRecord(paidBody) && typeof paidBody["amountAtomic"] === "string"
      ? paidBody["amountAtomic"]
      : selected.amount;
  if (!UINT_PATTERN.test(amountAtomic)) {
    throw new Error("paid quota leg returned a malformed amount");
  }
  return { amountAtomic, settlementId };
}

/** Strict fill-plan validation: rejects anything the orchestrator would. */
export function parseFillPlan(value: unknown): FillPlanResponse {
  if (!isRecord(value)) throw new Error("plan is not an object");
  const sellers = value["sellers"];
  const totalAtomic = value["totalAtomic"];
  if (!Array.isArray(sellers) || typeof totalAtomic !== "string") {
    throw new Error("plan needs sellers[] + totalAtomic");
  }
  const legs: FillPlanLeg[] = sellers.map((entry) => {
    if (!isRecord(entry)) throw new Error("plan leg is not an object");
    const wallet = entry["wallet"];
    const mb = entry["mb"];
    const cuMicro = entry["cuMicro"];
    const amountAtomic = entry["amountAtomic"];
    if (
      typeof wallet !== "string" ||
      !ADDRESS_PATTERN.test(wallet) ||
      typeof mb !== "number" ||
      !Number.isInteger(mb) ||
      typeof cuMicro !== "number" ||
      !Number.isInteger(cuMicro) ||
      typeof amountAtomic !== "string" ||
      !UINT_PATTERN.test(amountAtomic)
    ) {
      throw new Error("plan leg is malformed");
    }
    return { wallet, mb, cuMicro, amountAtomic };
  });
  if (!UINT_PATTERN.test(totalAtomic) || legs.length === 0) {
    throw new Error("plan totalAtomic malformed or no legs");
  }
  return { sellers: legs, totalAtomic };
}

/** cuMicro integers back to CU floats for the transfer-quota legs wire shape. */
export function legToTransferLeg(leg: FillPlanLeg): TransferQuotaLeg {
  return { seller: leg.wallet, mb: leg.mb, cu: leg.cuMicro / 1e6 };
}

/**
 * Parse the CIRCLE_BUYER_AUTOFUND_MAX cap (decimal USDC, max 6dp, e.g.
 * "10.00") into atomic units. Absent/empty/invalid/zero yields null =
 * feature OFF, so the buy flow fails exactly as it does today. Server-only.
 */
export function parseAutofundCapAtomic(raw: string | undefined): bigint | null {
  if (raw === undefined || raw.trim() === "") return null;
  const trimmed = raw.trim();
  if (!/^\d+(\.\d{1,6})?$/.test(trimmed)) return null;
  const dot = trimmed.indexOf(".");
  const intPart = dot === -1 ? trimmed : trimmed.slice(0, dot);
  const fracPart = dot === -1 ? "" : trimmed.slice(dot + 1);
  const digits = `${intPart}${fracPart.padEnd(6, "0")}`.replace(/^0+(?=\d)/, "");
  const value = digits === "" ? 0n : BigInt(digits);
  return value <= 0n ? null : value;
}

export type TopUpGatewayResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: string };

/**
 * Server-only one-shot Gateway top-up: wallet → own-Gateway only, never a
 * third party. Replicates app/fund-buyer-gateway.mjs (USDC approve then
 * GatewayWallet.deposit via Circle contract execution, polled to a terminal
 * state by executeContractAndWait) with NO local key and no secret logging.
 * amountAtomic is a positive 6-decimal atomic USDC string.
 */
export async function topUpGateway(args: {
  readonly apiKey: string;
  readonly entitySecret: string;
  readonly buyerWalletId: string;
  readonly amountAtomic: string;
}): Promise<TopUpGatewayResult> {
  if (!UINT_PATTERN.test(args.amountAtomic) || BigInt(args.amountAtomic) <= 0n) {
    return { ok: false, error: "top-up amount must be a positive atomic string" };
  }
  const client = createCircleClient(args.apiKey, args.entitySecret);
  const approve = await executeContractAndWait(client, {
    walletId: args.buyerWalletId,
    contractAddress: RESALE_USDC_ADDRESS,
    abiFunctionSignature: "approve(address,uint256)",
    abiParameters: [RESALE_GATEWAY_WALLET, args.amountAtomic],
  });
  if (!approve.ok) return { ok: false, error: approve.error };
  const deposit = await executeContractAndWait(client, {
    walletId: args.buyerWalletId,
    contractAddress: RESALE_GATEWAY_WALLET,
    abiFunctionSignature: "deposit(address,uint256)",
    abiParameters: [RESALE_USDC_ADDRESS, args.amountAtomic],
  });
  if (!deposit.ok) return { ok: false, error: deposit.error };
  return { ok: true };
}

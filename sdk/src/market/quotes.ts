import type { Address } from "viem";

import { MarketError } from "./types.js";
import type { ComputeQuote } from "./types.js";

export type ComputeRequest = {
  readonly mb: bigint;
  readonly cu: bigint;
};

/** Exact atomic cost of a request at the quote's rates. Pure bigint math. */
export function quoteCost(quote: ComputeQuote, request: ComputeRequest): bigint {
  return (
    quote.ratePerMBAtomic * request.mb + quote.ratePerCUAtomic * request.cu
  );
}

export type FetchQuoteParams = {
  readonly baseUrl: string;
  readonly seller: string;
  readonly timeoutMs?: number;
};

const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
const UINT_PATTERN = /^\d+$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseAddress(value: unknown, field: string): Address {
  if (typeof value !== "string" || !ADDRESS_PATTERN.test(value)) {
    throw new MarketError(`quote field "${field}" is not an address`);
  }
  return value as Address;
}

function parseUint(value: unknown, field: string): bigint {
  if (typeof value !== "string" || !UINT_PATTERN.test(value)) {
    throw new MarketError(`quote field "${field}" is not a uint string`);
  }
  return BigInt(value);
}

/**
 * Fetch a seller's quote from the orchestrator and narrow it to ComputeQuote.
 * Malformed payloads throw MarketError — never a half-parsed quote.
 */
export async function fetchQuote(params: FetchQuoteParams): Promise<ComputeQuote> {
  if (!ADDRESS_PATTERN.test(params.seller)) {
    throw new MarketError(`seller "${params.seller}" is not an address`);
  }
  let response: Response;
  try {
    response = await fetch(
      `${params.baseUrl}/quote?seller=${params.seller}`,
      { signal: AbortSignal.timeout(params.timeoutMs ?? 10_000) },
    );
  } catch (error) {
    throw new MarketError(`quote request to ${params.baseUrl} failed`, {
      cause: error,
    });
  }
  if (!response.ok) {
    throw new MarketError(`quote endpoint returned ${response.status}`);
  }
  const unknownBody: unknown = await response.json();
  if (!isRecord(unknownBody)) {
    throw new MarketError("quote payload is not an object");
  }
  const termsURI = unknownBody["termsURI"];
  if (termsURI !== undefined && typeof termsURI !== "string") {
    throw new MarketError('quote field "termsURI" is not a string');
  }
  return {
    seller: parseAddress(unknownBody["seller"], "seller"),
    payTo: parseAddress(unknownBody["payTo"], "payTo"),
    ratePerMBAtomic: parseUint(unknownBody["ratePerMBAtomic"], "ratePerMBAtomic"),
    ratePerCUAtomic: parseUint(unknownBody["ratePerCUAtomic"], "ratePerCUAtomic"),
    availableMB: parseUint(unknownBody["availableMB"], "availableMB"),
    availableCU: parseUint(unknownBody["availableCU"], "availableCU"),
    ...(termsURI === undefined ? {} : { termsURI }),
  };
}

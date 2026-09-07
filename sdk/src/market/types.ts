import type { Address } from "viem";

/**
 * A surplus agent's resale offer. All money is bigint atomic units; amounts
 * cross the wire as decimal strings (JSON cannot carry bigint).
 */
export type ComputeQuote = {
  readonly seller: Address;
  /** Where the buyer pays — the surplus agent's wallet, never a platform. */
  readonly payTo: Address;
  readonly ratePerMBAtomic: bigint;
  readonly ratePerCUAtomic: bigint;
  readonly availableMB: bigint;
  readonly availableCU: bigint;
  readonly termsURI?: string;
};

/** Thrown when a quote cannot be fetched or parsed. */
export class MarketError extends Error {
  readonly name = "MarketError";
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
  }
}

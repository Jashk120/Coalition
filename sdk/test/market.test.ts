import { afterEach, describe, expect, it, vi } from "vitest";

import {
  MarketError,
  fetchQuote,
  quoteCost,
} from "../src/market/index.js";
import type { ComputeQuote } from "../src/market/index.js";

const QUOTE: ComputeQuote = {
  seller: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
  payTo: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
  ratePerMBAtomic: 4_000n,
  ratePerCUAtomic: 1_000_000n,
  availableMB: 900n,
  availableCU: 1n,
};

function wireQuote(overrides: Record<string, unknown> = {}) {
  return {
    seller: QUOTE.seller,
    payTo: QUOTE.payTo,
    ratePerMBAtomic: QUOTE.ratePerMBAtomic.toString(),
    ratePerCUAtomic: QUOTE.ratePerCUAtomic.toString(),
    availableMB: QUOTE.availableMB.toString(),
    availableCU: QUOTE.availableCU.toString(),
    ...overrides,
  };
}

function stubFetch(body: unknown, status = 200) {
  return vi.fn(async () => new Response(JSON.stringify(body), { status }));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("quoteCost", () => {
  it("multiplies rates and sums both resources", () => {
    // Given: 4000 atomic/MB and 1M atomic/CU
    // When: requesting 500 MB + 1 CU
    // Then: exact bigint cost, no floats
    expect(quoteCost(QUOTE, { mb: 500n, cu: 1n })).toBe(3_000_000n);
  });

  it("costs zero for an empty request", () => {
    // Given: any quote
    // When: requesting nothing
    // Then: zero
    expect(quoteCost(QUOTE, { mb: 0n, cu: 0n })).toBe(0n);
  });
});

describe("fetchQuote", () => {
  it("parses decimal strings into bigint fields", async () => {
    // Given: a quote endpoint serving string-encoded atomics
    vi.stubGlobal("fetch", stubFetch(wireQuote()));

    // When: fetching the seller's quote
    const quote = await fetchQuote({
      baseUrl: "https://orchestrator.local",
      seller: QUOTE.seller,
    });

    // Then: the quote round-trips exactly
    expect(quote).toEqual(QUOTE);
  });

  it("rejects malformed payloads without partial results", async () => {
    // Given: a payload missing the rate field
    const { ratePerMBAtomic: _dropped, ...partial } = wireQuote();
    void _dropped;
    vi.stubGlobal("fetch", stubFetch(partial));

    // When/Then: typed error, never a half-parsed quote
    await expect(
      fetchQuote({ baseUrl: "https://orchestrator.local", seller: QUOTE.seller }),
    ).rejects.toThrow(MarketError);
  });

  it("rejects non-address sellers before any request", async () => {
    // Given: a fetch counter
    const fetch = stubFetch(wireQuote());
    vi.stubGlobal("fetch", fetch);

    // When/Then: local validation fires, zero requests sent
    await expect(
      fetchQuote({ baseUrl: "https://orchestrator.local", seller: "agent-b" }),
    ).rejects.toThrow(MarketError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("wraps HTTP failures as typed errors", async () => {
    // Given: a 500ing endpoint
    vi.stubGlobal("fetch", stubFetch({ error: "boom" }, 500));

    // When/Then: status surfaces as MarketError
    await expect(
      fetchQuote({ baseUrl: "https://orchestrator.local", seller: QUOTE.seller }),
    ).rejects.toThrow(MarketError);
  });
});

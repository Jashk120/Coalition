import { describe, expect, it } from "vitest";

import {
  ARC_EXPLORER,
  ARC_FAUCET,
  ARC_TESTNET,
  ARC_TESTNET_ID,
  ARC_TESTNET_RPC_HTTP,
  ARC_TESTNET_RPC_WS,
  InvalidUsdcAmountError,
  USDC_ERC20_DECIMALS,
  USDC_NATIVE_DECIMALS,
  fromAtomicUsdc,
  toAtomicUsdc,
} from "../src/chains/index.js";

describe("Arc testnet constants", () => {
  it("exposes chain id 5042002", () => {
    // Given: the Arc facts in the implementation plan
    // When: reading the chain constants
    // Then: the id matches Arc testnet
    expect(ARC_TESTNET_ID).toBe(5042002);
    expect(ARC_TESTNET.id).toBe(5042002);
  });

  it("exposes non-empty RPC, explorer, and faucet endpoints", () => {
    // Given: a consumer wiring a viem client
    // When: reading the endpoint constants
    // Then: every endpoint is a non-empty string
    expect(ARC_TESTNET_RPC_HTTP.length).toBeGreaterThan(0);
    expect(ARC_TESTNET_RPC_WS.length).toBeGreaterThan(0);
    expect(ARC_EXPLORER.length).toBeGreaterThan(0);
    expect(ARC_FAUCET.length).toBeGreaterThan(0);
  });

  it("prices gas in 18-decimal native USDC", () => {
    // Given: Arc uses USDC as native gas with 18 decimals
    // When: reading the chain definition
    // Then: the native currency is 18-decimal USDC
    expect(USDC_NATIVE_DECIMALS).toBe(18);
    expect(USDC_ERC20_DECIMALS).toBe(6);
    expect(ARC_TESTNET.nativeCurrency.decimals).toBe(18);
    expect(ARC_TESTNET.nativeCurrency.symbol).toBe("USDC");
  });
});

describe("toAtomicUsdc", () => {
  it("converts a display string to ERC-20 atomic units by default", () => {
    // Given: "1.5" USDC in the 6-decimal ERC-20 view
    // When: converting with default decimals
    // Then: the atomic value is exact
    expect(toAtomicUsdc("1.5")).toBe(1_500_000n);
  });

  it("converts to native atomic units when asked", () => {
    // Given: "1" USDC in the 18-decimal native view
    // When: converting with 18 decimals
    // Then: the atomic value is 10^18
    expect(toAtomicUsdc("1", 18)).toBe(1_000_000_000_000_000_000n);
  });

  it("rejects precision beyond the decimal count", () => {
    // Given: 7 fractional digits against 6-decimal USDC
    // When: converting
    // Then: a typed error is thrown, not a silent truncation
    expect(() => toAtomicUsdc("0.0000001", 6)).toThrow(InvalidUsdcAmountError);
  });

  it("rejects malformed input", () => {
    // Given: non-numeric, empty, and negative display strings
    // When: converting each
    // Then: every one throws the typed error
    for (const bad of ["abc", "", "-", "-1.5", "1.2.3"]) {
      expect(() => toAtomicUsdc(bad)).toThrow(InvalidUsdcAmountError);
    }
  });
});

describe("fromAtomicUsdc", () => {
  it("round-trips through the ERC-20 view", () => {
    // Given: an atomic value produced by toAtomicUsdc
    // When: converting back to display
    // Then: the original display string is recovered
    expect(fromAtomicUsdc(toAtomicUsdc("1.5"))).toBe("1.5");
    expect(fromAtomicUsdc(toAtomicUsdc("0.000001"))).toBe("0.000001");
  });

  it("renders whole units without a fraction", () => {
    // Given: an exact whole-unit atomic value
    // When: converting to display
    // Then: no trailing decimal point appears
    expect(fromAtomicUsdc(2_000_000n)).toBe("2");
    expect(fromAtomicUsdc(0n)).toBe("0");
  });
});

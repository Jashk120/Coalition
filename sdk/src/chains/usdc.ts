/**
 * Dual USDC decimals on Arc: the native balance (gas) is 18 decimals while
 * the ERC-20 interface reports the same balance with 6. All on-chain amounts
 * are `bigint` atomic units — never `number` — and display values are always
 * decimal strings, so the 10^12 gap can never hide in float math.
 */

/** Decimals of the native (gas) USDC view. */
export const USDC_NATIVE_DECIMALS = 18 as const;

/** Decimals of the ERC-20 USDC view. */
export const USDC_ERC20_DECIMALS = 6 as const;

/** The only decimal views USDC has on Arc. */
export type UsdcDecimals =
  | typeof USDC_NATIVE_DECIMALS
  | typeof USDC_ERC20_DECIMALS;

/** Thrown when a display string cannot be represented in the given decimals. */
export class InvalidUsdcAmountError extends Error {
  readonly name = "InvalidUsdcAmountError";
  constructor(
    readonly display: string,
    readonly decimals: UsdcDecimals,
  ) {
    super(`invalid USDC amount "${display}" for ${decimals} decimals`);
  }
}

const DISPLAY_PATTERN = /^\d+(\.\d+)?$/;

/**
 * Parse a decimal display string (e.g. `"1.5"`) into atomic units.
 *
 * Defaults to the 6-decimal ERC-20 view, which is what contracts consume.
 * Throws {@link InvalidUsdcAmountError} on malformed input or precision
 * beyond `decimals` — never silently truncates.
 */
export function toAtomicUsdc(
  display: string,
  decimals: UsdcDecimals = USDC_ERC20_DECIMALS,
): bigint {
  if (!DISPLAY_PATTERN.test(display)) {
    throw new InvalidUsdcAmountError(display, decimals);
  }
  const dot = display.indexOf(".");
  const integer = dot === -1 ? display : display.slice(0, dot);
  const fraction = dot === -1 ? "" : display.slice(dot + 1);
  if (fraction.length > decimals) {
    throw new InvalidUsdcAmountError(display, decimals);
  }
  return BigInt(integer + fraction.padEnd(decimals, "0"));
}

/**
 * Render atomic units back to a display string (no float math).
 *
 * Whole units render without a fraction (`"2"`, not `"2.0"`).
 * Throws {@link InvalidUsdcAmountError} on negative input.
 */
export function fromAtomicUsdc(
  atomic: bigint,
  decimals: UsdcDecimals = USDC_ERC20_DECIMALS,
): string {
  if (atomic < 0n) {
    throw new InvalidUsdcAmountError(atomic.toString(), decimals);
  }
  const base = 10n ** BigInt(decimals);
  const integer = atomic / base;
  const fraction = (atomic % base).toString().padStart(decimals, "0");
  const trimmed = fraction.replace(/0+$/, "");
  return trimmed === "" ? integer.toString() : `${integer}.${trimmed}`;
}

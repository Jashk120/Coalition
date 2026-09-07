/** The SDK package version. */
export const VERSION = "0.1.0";

/**
 * Returns a friendly identifier for SDK consumers.
 *
 * This small entry point gives the package a stable, typed public API while
 * the rest of the SDK is developed.
 */
export function coalitionSdk(): string {
  return `@jx-nexus/coalition/${VERSION}`;
}

export * from "./chains/index.js";
export * from "./identity/index.js";
export * from "./pool/index.js";
export * from "./reputation/index.js";

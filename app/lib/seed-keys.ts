import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { Account, Address, WalletClient } from "viem";
import { ARC_TESTNET, ARC_TESTNET_RPC_HTTP } from "@jx-nexus/coalition";
import { SEED_META } from "./constants";

/**
 * Server-only self-custody agent signers. Private keys live in a local JSON
 * file (default `~/.coalition/seed-keys.json`, override with `SEED_KEYS_FILE`)
 * — never in the repo and never in NEXT_PUBLIC_ env.
 */

export type SeedSigner = {
  readonly index: number;
  readonly id: string;
  readonly ensName: string;
  readonly address: Address;
  readonly account: Account;
  readonly walletClient: WalletClient;
};

export type SeedSignersResult =
  | { readonly ok: true; readonly signers: readonly SeedSigner[] }
  | { readonly ok: false; readonly error: string };

const PRIVATE_KEY_PATTERN = /^0x[0-9a-fA-F]{64}$/;

export function seedKeysFilePath(): string {
  const override = process.env["SEED_KEYS_FILE"];
  return override !== undefined && override !== ""
    ? override
    : join(homedir(), ".coalition", "seed-keys.json");
}

/**
 * Read and validate the four agent signers. Fails closed on a missing file,
 * a malformed key, or a key that does not derive to the seed wallet the ENS
 * record points at — a mismatched key must never fund.
 */
export function readSeedSigners(): SeedSignersResult {
  const path = seedKeysFilePath();
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return {
      ok: false,
      error:
        `Self-custody seed keys not found at ${path}. Set SEED_KEYS_FILE or ` +
        `write the file (see ~/.coalition/seed-keys.json).`,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: `Seed keys file is not valid JSON: ${path}` };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { ok: false, error: `Seed keys file must be a JSON object: ${path}` };
  }
  const record = parsed as Record<string, unknown>;
  const rpcUrl = process.env["ARC_RPC_URL"] ?? ARC_TESTNET_RPC_HTTP;
  const signers: SeedSigner[] = [];
  for (const [index, seed] of SEED_META.entries()) {
    const label = `agent${index + 1}`;
    const entry = record[label];
    if (typeof entry !== "object" || entry === null) {
      return { ok: false, error: `Seed keys file is missing "${label}": ${path}` };
    }
    const privateKey = (entry as Record<string, unknown>)["privateKey"];
    if (typeof privateKey !== "string" || !PRIVATE_KEY_PATTERN.test(privateKey)) {
      return {
        ok: false,
        error: `"${label}".privateKey must be 0x + 64 hex in ${path}`,
      };
    }
    const account = privateKeyToAccount(privateKey as `0x${string}`);
    if (account.address.toLowerCase() !== seed.wallet.toLowerCase()) {
      return {
        ok: false,
        error:
          `"${label}" key derives ${account.address}, expected ${seed.wallet}; ` +
          `re-point ENS or fix the key before funding.`,
      };
    }
    signers.push({
      index,
      id: seed.id,
      ensName: seed.ensName,
      address: account.address,
      account,
      walletClient: createWalletClient({
        account,
        chain: ARC_TESTNET,
        transport: http(rpcUrl),
      }),
    });
  }
  return { ok: true, signers };
}

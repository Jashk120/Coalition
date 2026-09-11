#!/usr/bin/env node
// Re-point `agentN.agentpool.eth` Arc records (coinType 2152525650) so each
// name resolves to the wallet that actually funds the pool. ENS is mandatory
// in the app (funder must equal the ENS wallet), so run this once after
// rotating Circle funders.
//
// Usage:
//   node scripts/repoint-ens.mjs                          # targets from CIRCLE_WALLET_IDS
//   node scripts/repoint-ens.mjs --to 0x..,0x..,0x..,0x..  # explicit, agent1..4 order
//   node scripts/repoint-ens.mjs --map agent1=0x..,agent3=0x..
//   node scripts/repoint-ens.mjs --dry-run
//
// Env (process.env or app/.env):
//   SEPOLIA_PRIVATE_KEY  owner/resolver-admin key that may write the records
//   SEPOLIA_RPC_URL      optional; defaults to the public Sepolia RPC
//   CIRCLE_API_KEY / CIRCLE_ENTITY_SECRET / CIRCLE_WALLET_IDS  for auto mode

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ENV_PATH = resolve(HERE, "../.env");
if (existsSync(ENV_PATH)) {
  for (const line of readFileSync(ENV_PATH, "utf8").split("\n")) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (match === null || process.env[match[1]] !== undefined) continue;
    let value = match[2];
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[match[1]] = value;
  }
}

const args = process.argv.slice(2);
function argValue(flag) {
  const at = args.indexOf(flag);
  return at === -1 ? undefined : args[at + 1];
}
const dryRun = args.includes("--dry-run");
const toArg = argValue("--to");
const mapArg = argValue("--map");

const { createPublicClient, createWalletClient, http, isAddress } = await import("viem");
const { privateKeyToAccount } = await import("viem/accounts");
const { sepolia } = await import("viem/chains");
const {
  DEMO_SEED_AGENTS,
  resolveArcWallet,
  resolveEnsResolver,
  setArcAddressRecord,
} = await import("@jx-nexus/coalition");

const rpc = process.env.SEPOLIA_RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com";
const publicClient = createPublicClient({ chain: sepolia, transport: http(rpc) });

function requireAddress(value, label) {
  if (typeof value !== "string" || !isAddress(value)) {
    throw new Error(`${label} is not a valid address: ${String(value)}`);
  }
  return value;
}

function labelsFromMap(map) {
  const out = [];
  for (const pair of map.split(",")) {
    const [label, address] = pair.split("=");
    if (!label || !address) throw new Error(`bad --map entry: ${pair}`);
    out.push({
      name: `${label.replace(/\.agentpool\.eth$/, "")}.agentpool.eth`,
      wallet: requireAddress(address, label),
    });
  }
  return out;
}

async function targetsFromCircle() {
  const apiKey = process.env.CIRCLE_API_KEY;
  const entitySecret = process.env.CIRCLE_ENTITY_SECRET;
  const walletIds = (process.env.CIRCLE_WALLET_IDS ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (!apiKey || !entitySecret || walletIds.length === 0) {
    throw new Error(
      "No --to/--map and CIRCLE_API_KEY/CIRCLE_ENTITY_SECRET/CIRCLE_WALLET_IDS is incomplete",
    );
  }
  const { initiateDeveloperControlledWalletsClient } = await import(
    "@circle-fin/developer-controlled-wallets"
  );
  const client = initiateDeveloperControlledWalletsClient({ apiKey, entitySecret });
  const targets = [];
  for (const [index, seed] of DEMO_SEED_AGENTS.entries()) {
    const walletId = walletIds[index];
    if (walletId === undefined) {
      throw new Error(`CIRCLE_WALLET_IDS has no wallet for ${seed.ensName}`);
    }
    const fetched = await client.getWallet({ id: walletId });
    const address = fetched.data?.wallet?.address;
    if (address === undefined || address === "") {
      throw new Error(`Circle wallet ${walletId} (${seed.ensName}) has no address`);
    }
    targets.push({ name: seed.ensName, wallet: requireAddress(address, seed.ensName) });
  }
  return targets;
}

let targets;
if (mapArg !== undefined) {
  targets = labelsFromMap(mapArg);
} else if (toArg !== undefined) {
  const addresses = toArg.split(",").map((entry) => entry.trim());
  targets = DEMO_SEED_AGENTS.map((seed, index) => ({
    name: seed.ensName,
    wallet: requireAddress(addresses[index], `${seed.ensName}`),
  }));
} else {
  targets = await targetsFromCircle();
}

async function promptHidden(prompt) {
  process.stdout.write(prompt);
  const stdin = process.stdin;
  const wasRaw = stdin.isRaw;
  if (stdin.isTTY) stdin.setRawMode(true);
  stdin.resume();
  return await new Promise((resolve) => {
    let value = "";
    const onData = (buf) => {
      for (const ch of buf.toString("utf8")) {
        if (ch === "\r" || ch === "\n") {
          stdin.removeListener("data", onData);
          if (stdin.isTTY) stdin.setRawMode(wasRaw ?? false);
          stdin.pause();
          process.stdout.write("\n");
          resolve(value);
          return;
        }
        if (ch === "\u0003") process.exit(130);
        if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
        else value += ch;
      }
    };
    stdin.on("data", onData);
  });
}

function normalizeKey(value) {
  const trimmed = (value ?? "").trim();
  return /^[0-9a-fA-F]{64}$/.test(trimmed) ? `0x${trimmed}` : trimmed;
}

function resolvePrivateKey() {
  let key = normalizeKey(process.env.SEPOLIA_PRIVATE_KEY);
  if (key === "") key = undefined;
  const fileOrKey = (process.env.SEPOLIA_PRIVATE_KEY_FILE ?? "").trim();
  if (key === undefined && fileOrKey !== "") {
    if (/^(0x)?[0-9a-fA-F]{64}$/.test(fileOrKey)) {
      key = normalizeKey(fileOrKey);
      console.warn(
        "warning: SEPOLIA_PRIVATE_KEY_FILE looks like a private key, not a path; " +
          "using it as the key. Rename it to SEPOLIA_PRIVATE_KEY.",
      );
    } else {
      try {
        key = normalizeKey(readFileSync(fileOrKey, "utf8"));
      } catch {
        throw new Error(`SEPOLIA_PRIVATE_KEY_FILE is not a readable file: ${fileOrKey}`);
      }
    }
  }
  return key;
}

const VALID_KEY = /^0x[0-9a-fA-F]{64}$/;

let privateKey;
if (!dryRun) {
  privateKey = resolvePrivateKey();
  if (!VALID_KEY.test(privateKey ?? "") && process.stdin.isTTY) {
    privateKey = normalizeKey(
      await promptHidden("Sepolia owner private key (hidden): "),
    );
  }
  if (!VALID_KEY.test(privateKey ?? "")) {
    throw new Error(
      "SEPOLIA_PRIVATE_KEY is required (owner/resolver-admin key). Set it in the " +
        "environment, in app/.env, or via SEPOLIA_PRIVATE_KEY_FILE, or run on a TTY " +
        "to be prompted.",
    );
  }
}

const account = dryRun
  ? undefined
  : privateKeyToAccount(privateKey);
const walletClient =
  account === undefined
    ? undefined
    : createWalletClient({ account, chain: sepolia, transport: http(rpc) });

console.log(
  `${dryRun ? "DRY RUN — " : ""}re-pointing ${targets.length} subname(s) on Sepolia via ${rpc}`,
);
if (account !== undefined) console.log(`signer: ${account.address}`);

const results = [];
for (const target of targets) {
  const resolver = await resolveEnsResolver({ publicClient, name: target.name });
  const before = await resolveArcWallet({ publicClient, name: target.name });
  if (dryRun) {
    console.log(`${target.name}: ${before} -> ${target.wallet} (resolver ${resolver})`);
    results.push({ target, before, after: target.wallet, ok: true, hash: null });
    continue;
  }
  const { hash } = await setArcAddressRecord({
    walletClient,
    publicClient,
    account,
    name: target.name,
    arcWallet: target.wallet,
    resolver,
  });
  await publicClient.waitForTransactionReceipt({ hash });
  const after = await resolveArcWallet({ publicClient, name: target.name });
  const ok = after !== null && after.toLowerCase() === target.wallet.toLowerCase();
  console.log(
    `${target.name}: ${before} -> ${after} tx ${hash} ${ok ? "OK" : "MISMATCH"}`,
  );
  results.push({ target, before, after, ok, hash });
}

const failed = results.filter((entry) => !entry.ok);
if (failed.length > 0) {
  console.error(`\n${failed.length} record(s) did not verify — check EAC grants/resolver.`);
  process.exit(1);
}
console.log("\nAll records verified against the target funder wallets.");

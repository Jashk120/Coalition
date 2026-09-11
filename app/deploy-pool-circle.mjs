// Deploy ResourcePool to Arc Testnet via Circle Contracts (Smart Contract
// Platform) instead of `forge script`. Foundry stays the compiler; build the
// artifact with the Paris EVM target first (contracts/foundry.toml sets it).
//
// Run from app/:
//   set -a; source .env; set +a
//   node deploy-pool-circle.mjs
//
// Requires: CIRCLE_API_KEY, CIRCLE_ENTITY_SECRET, CIRCLE_DEPLOYER_WALLET_ID,
//   USDC, PROVIDER, TARGET, DEADLINE, REPUTATION_REGISTRY
// Optional: RESOURCE_URI (default ""), MAX_PARTICIPANTS (default 200),
//   MAX_PARTICIPANTS_CAP (default MAX_PARTICIPANTS)
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { initiateSmartContractPlatformClient } from "@circle-fin/smart-contract-platform";

const here = dirname(fileURLToPath(import.meta.url));
const env = process.env;

const required = {
  CIRCLE_API_KEY: env.CIRCLE_API_KEY,
  CIRCLE_ENTITY_SECRET: env.CIRCLE_ENTITY_SECRET,
  CIRCLE_DEPLOYER_WALLET_ID: env.CIRCLE_DEPLOYER_WALLET_ID,
  USDC: env.USDC,
  PROVIDER: env.PROVIDER,
  TARGET: env.TARGET,
  DEADLINE: env.DEADLINE,
  REPUTATION_REGISTRY: env.REPUTATION_REGISTRY,
};
const missing = Object.entries(required)
  .filter(([, value]) => value === undefined || value === "")
  .map(([name]) => name);
if (missing.length > 0) {
  throw new Error(`missing env: ${missing.join(", ")}`);
}

const maxParticipants = env.MAX_PARTICIPANTS ?? "200";
const maxParticipantsCap = env.MAX_PARTICIPANTS_CAP ?? maxParticipants;

const artifactPath = join(here, "..", "contracts", "out", "ResourcePool.sol", "ResourcePool.json");
const artifact = JSON.parse(readFileSync(artifactPath, "utf8"));
const bytecodeRaw = artifact.bytecode?.object;
if (typeof bytecodeRaw !== "string" || bytecodeRaw === "") {
  throw new Error(
    `no bytecode in ${artifactPath}; run: (cd contracts && forge build --evm-version paris)`,
  );
}
const bytecode = bytecodeRaw.startsWith("0x") ? bytecodeRaw : `0x${bytecodeRaw}`;

// Order must match ResourcePool.sol:
// (usdc, provider, target, deadline, reputationRegistry, resourceURI,
//  maxParticipants, maxParticipantsCap).
const constructorParameters = [
  required.USDC,
  required.PROVIDER,
  Number(required.TARGET),
  Number(required.DEADLINE),
  required.REPUTATION_REGISTRY,
  env.RESOURCE_URI ?? "",
  Number(maxParticipants),
  Number(maxParticipantsCap),
];

const client = initiateSmartContractPlatformClient({
  apiKey: required.CIRCLE_API_KEY,
  entitySecret: required.CIRCLE_ENTITY_SECRET,
});

console.log(
  `deploying ResourcePool on ARC-TESTNET from wallet ${required.CIRCLE_DEPLOYER_WALLET_ID}`,
);
const deploy = await client.deployContract({
  name: "ResourcePool",
  description: "Coalition ResourcePool (Circle Contracts)",
  blockchain: "ARC-TESTNET",
  walletId: required.CIRCLE_DEPLOYER_WALLET_ID,
  abiJson: JSON.stringify(artifact.abi),
  bytecode,
  constructorParameters,
  fee: { type: "level", config: { feeLevel: "MEDIUM" } },
});

const contractId = deploy.data?.contractId;
if (typeof contractId !== "string" || contractId === "") {
  throw new Error(`deploy returned no contractId: ${JSON.stringify(deploy.data)}`);
}
console.log(`contractId: ${contractId} transactionId: ${deploy.data?.transactionId}`);

const deadline = Date.now() + 300_000;
for (;;) {
  const fetched = await client.getContract({ id: contractId });
  const contract = fetched.data?.contract;
  const status = contract?.status ?? "UNKNOWN";
  if (status === "COMPLETE") {
    console.log(`\nResourcePool deployed: ${contract?.contractAddress}`);
    console.log(`txHash: ${contract?.txHash ?? ""}`);
    console.log("\nPoint the stack at it:");
    console.log(`  NEXT_PUBLIC_POOL_ADDRESS=${contract?.contractAddress}`);
    console.log(`  POOL_V2_ADDRESS=${contract?.contractAddress}`);
    break;
  }
  if (status === "FAILED") {
    throw new Error(
      `deploy failed: ${contract?.deploymentErrorReason ?? ""} ${contract?.deploymentErrorDetails ?? ""}`,
    );
  }
  if (Date.now() > deadline) {
    throw new Error(`deploy ${contractId} timed out (last status ${status})`);
  }
  await new Promise((resolve) => setTimeout(resolve, 5000));
}

// Syncs sdk/src/pool/abi.ts from the Foundry build artifact.
// Run from the repo root after any ResourcePool.sol change:
//   (cd contracts && forge build) && node sdk/scripts/sync-pool-abi.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const artifactPath = join(root, "contracts/out/ResourcePool.sol/ResourcePool.json");
const outPath = join(root, "sdk/src/pool/abi.ts");

const artifact = JSON.parse(readFileSync(artifactPath, "utf8"));

const header = `/**
 * GENERATED — do not hand-edit. Source: contracts/out/ResourcePool.sol/ResourcePool.json
 *
 * Regenerate after any ResourcePool.sol change:
 *   (cd contracts && forge build) && node sdk/scripts/sync-pool-abi.mjs
 *
 * The nine functions + four events the SDK calls (commit, dropOut,
 * finalizeExpired, settle, target, totalCommitted, settled, expired,
 * participantCount, Committed, Settled, Refunded, DroppedOut) keep the exact
 * shapes the placeholder had; the rest (bindAgentId, views, CompletionRecorded,
 * custom errors) is additive and invisible to existing callers.
 */
export const resourcePoolAbi = `;

writeFileSync(outPath, header + JSON.stringify(artifact.abi, null, 2) + " as const;\n");
console.log(`wrote ${outPath}, ${artifact.abi.length} entries`);

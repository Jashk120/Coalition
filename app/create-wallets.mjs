// Create the funder wallet set + 4 ARC-TESTNET wallets, print CIRCLE_WALLET_IDS.
// Run from app/: CIRCLE_API_KEY="TEST_API_KEY:..." CIRCLE_ENTITY_SECRET="<hex>" node create-wallets.mjs
// Then fund each printed address at https://faucet.circle.com and paste the
// CIRCLE_WALLET_IDS= line into .env
import { randomUUID } from "node:crypto";
import { initiateDeveloperControlledWalletsClient } from "@circle-fin/developer-controlled-wallets";

const apiKey = process.env.CIRCLE_API_KEY;
const entitySecret = process.env.CIRCLE_ENTITY_SECRET;
if (!apiKey) throw new Error("CIRCLE_API_KEY is required.");
if (!entitySecret) throw new Error("CIRCLE_ENTITY_SECRET is required (run node register-entity-secret.ts first).");

const client = initiateDeveloperControlledWalletsClient({ apiKey, entitySecret });

const set = await client.createWalletSet({
  idempotencyKey: randomUUID(),
  name: "coalition-funders",
});
const walletSetId = set.data?.walletSet?.id;
if (!walletSetId) throw new Error(`wallet set creation failed: ${JSON.stringify(set.data)}`);
console.log(`walletSet: ${walletSetId}`);

const created = await client.createWallets({
  idempotencyKey: randomUUID(),
  walletSetId,
  blockchains: ["ARC-TESTNET"],
  count: 4,
  accountType: "EOA",
});
const wallets = created.data?.wallets ?? [];
if (wallets.length !== 4) throw new Error(`expected 4 wallets: ${JSON.stringify(created.data)}`);
for (const [i, w] of wallets.entries()) {
  console.log(`funder-${i + 1}: id=${w.id} address=${w.address}`);
}
console.log(`\nCIRCLE_WALLET_IDS=${wallets.map((w) => w.id).join(",")}`);

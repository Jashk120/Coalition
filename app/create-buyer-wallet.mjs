// Create the agent-5 buyer wallet: own set + 1 ARC-TESTNET wallet.
// Run from app/: node create-buyer-wallet.mjs (reads CIRCLE_API_KEY and
// CIRCLE_ENTITY_SECRET from the environment, e.g. via `set -a; source .env`).
// Fund the printed address at https://faucet.circle.com, then record the
// CIRCLE_BUYER_WALLET_ID= line in .env. NEVER append it to
// CIRCLE_WALLET_IDS — that list is the 4-agent funding loop.
import { randomUUID } from "node:crypto";
import { initiateDeveloperControlledWalletsClient } from "@circle-fin/developer-controlled-wallets";

const apiKey = process.env.CIRCLE_API_KEY;
const entitySecret = process.env.CIRCLE_ENTITY_SECRET;
if (!apiKey) throw new Error("CIRCLE_API_KEY is required.");
if (!entitySecret) throw new Error("CIRCLE_ENTITY_SECRET is required.");

const client = initiateDeveloperControlledWalletsClient({ apiKey, entitySecret });

const set = await client.createWalletSet({
  idempotencyKey: randomUUID(),
  name: "coalition-buyer",
});
const walletSetId = set.data?.walletSet?.id;
if (!walletSetId) throw new Error(`wallet set creation failed: ${JSON.stringify(set.data)}`);
console.log(`walletSet: ${walletSetId}`);

const created = await client.createWallets({
  idempotencyKey: randomUUID(),
  walletSetId,
  blockchains: ["ARC-TESTNET"],
  count: 1,
  accountType: "EOA",
});
const wallets = created.data?.wallets ?? [];
if (wallets.length !== 1) throw new Error(`expected 1 wallet: ${JSON.stringify(created.data)}`);
const [buyer] = wallets;
console.log(`buyer: id=${buyer.id} address=${buyer.address}`);
console.log(`\nCIRCLE_BUYER_WALLET_ID=${buyer.id}`);

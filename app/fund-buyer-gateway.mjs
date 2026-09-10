// One-off Gateway deposit for the agent-5 buyer wallet.
// Run from app/: node fund-buyer-gateway.mjs 5.00
//
// Bootstrap (one time, in order):
//   1. node create-buyer-wallet.mjs ......... mint the EOA buyer wallet,
//      record CIRCLE_BUYER_WALLET_ID in .env (kept OUT of CIRCLE_WALLET_IDS).
//   2. https://faucet.circle.com ............ fund the printed buyer address
//      with ARC-TESTNET USDC (per-wallet faucet; the buyer wallet needs its
//      own drip — the 4-agent funding wallets cannot pay for it).
//   3. node fund-buyer-gateway.mjs <usdc> ... approve + deposit below: moves
//      <usdc> into the Circle GatewayWallet so the buyer can pay x402 legs
//      gaslessly. Deposit extra headroom — each fill-plan leg settles from
//      this balance and a shortfall fails the whole buy.
//
// No local key: both legs go through Developer-Controlled Wallets contract
// execution on CIRCLE_BUYER_WALLET_ID, same server-only env pattern as
// lib/circle-fund.ts (CIRCLE_API_KEY + CIRCLE_ENTITY_SECRET).
import { randomUUID } from "node:crypto";
import { initiateDeveloperControlledWalletsClient } from "@circle-fin/developer-controlled-wallets";

const USDC_ADDRESS = "0x3600000000000000000000000000000000000000";
const GATEWAY_WALLET = "0x0077777d7EBA4688BDeF3E311b846F25870A19B9";

const apiKey = process.env.CIRCLE_API_KEY;
const entitySecret = process.env.CIRCLE_ENTITY_SECRET;
const buyerWalletId = process.env.CIRCLE_BUYER_WALLET_ID;
if (!apiKey) throw new Error("CIRCLE_API_KEY is required.");
if (!entitySecret) throw new Error("CIRCLE_ENTITY_SECRET is required.");
if (!buyerWalletId) throw new Error("CIRCLE_BUYER_WALLET_ID is required.");

const rawAmount = process.argv[2];
if (!rawAmount || !/^\d+(\.\d{1,6})?$/.test(rawAmount)) {
  throw new Error("usage: node fund-buyer-gateway.mjs <usdc-decimal, max 6dp>");
}
const [intPart, fracPart = ""] = rawAmount.split(".");
const atomic = (intPart + fracPart.padEnd(6, "0")).replace(/^0+(?=\d)/, "");

const client = initiateDeveloperControlledWalletsClient({ apiKey, entitySecret });

async function executeAndWait(args) {
  const created = await client.createContractExecutionTransaction({
    walletId: buyerWalletId,
    contractAddress: args.contractAddress,
    abiFunctionSignature: args.abiFunctionSignature,
    abiParameters: args.abiParameters,
    fee: { type: "level", config: { feeLevel: "MEDIUM" } },
    idempotencyKey: randomUUID(),
  });
  const id = created.data?.id;
  if (!id) throw new Error(`no transaction id: ${JSON.stringify(created.data)}`);
  const deadline = Date.now() + 120_000;
  for (;;) {
    const fetched = await client.getTransaction({ id });
    const tx = fetched.data?.transaction;
    const state = tx?.state ?? "UNKNOWN";
    if (state === "CONFIRMED" || state === "COMPLETE") {
      if (!tx?.txHash) throw new Error(`reached ${state} without a tx hash`);
      return tx.txHash;
    }
    if (["FAILED", "DENIED", "CANCELLED", "STUCK"].includes(state)) {
      throw new Error(`transaction ${id} ended in state ${state}`);
    }
    if (Date.now() > deadline) throw new Error(`transaction ${id} timed out`);
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

const approveHash = await executeAndWait({
  contractAddress: USDC_ADDRESS,
  abiFunctionSignature: "approve(address,uint256)",
  abiParameters: [GATEWAY_WALLET, atomic],
});
console.log(`approve: ${approveHash}`);

const depositHash = await executeAndWait({
  contractAddress: GATEWAY_WALLET,
  abiFunctionSignature: "deposit(address,uint256)",
  abiParameters: [USDC_ADDRESS, atomic],
});
console.log(`deposit: ${depositHash}`);
console.log(`Gateway balance +${rawAmount} USDC for buyer wallet ${buyerWalletId}`);

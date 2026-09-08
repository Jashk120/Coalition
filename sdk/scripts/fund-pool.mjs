// Real-write funding loop: 4 seeds x 2.50 USDC -> 10.00 USDC target.
// Run: SEED_PRIVATE_KEYS="0xaaa,0xbbb,0xccc,0xddd" node sdk/scripts/fund-pool.mjs
//   (order = agent-1..4, mirrors demo/agents.seeds.json — never reorder)
// Alt: FUNDING_PRIVATE_KEY_1..FUNDING_PRIVATE_KEY_4 individually.
// Env: ARC_RPC_URL (default https://rpc.testnet.arc.io), POOL_ADDRESS (default below).
// Each agent: getPoolState -> wouldExceedTarget gate -> approve USDC -> commit -> receipt.
import { createPublicClient, createWalletClient, erc20Abi, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  ARC_TESTNET,
  ARC_TESTNET_RPC_HTTP,
  commitToPool,
  fromAtomicUsdc,
  getPoolState,
  toAtomicUsdc,
  wouldExceedTarget,
} from "../dist/index.js";

const POOL_DEFAULT = "0xC6f9A1559f9a02755aC7Ba4865C558B0ed46B4fd";
const USDC = "0x3600000000000000000000000000000000000000";
const SHARE = toAtomicUsdc("2.50"); // 2500000n

const pool = (process.env["POOL_ADDRESS"] ?? POOL_DEFAULT).toLowerCase();
const rpcUrl = process.env["ARC_RPC_URL"] ?? ARC_TESTNET_RPC_HTTP;

function loadKeys() {
  const list = process.env["SEED_PRIVATE_KEYS"];
  if (list !== undefined && list.trim() !== "") {
    const keys = list.split(",").map((k) => k.trim()).filter(Boolean);
    if (keys.length !== 4) throw new Error(`SEED_PRIVATE_KEYS must hold 4 keys, got ${keys.length}`);
    return keys;
  }
  const keys = [1, 2, 3, 4].map((i) => process.env[`FUNDING_PRIVATE_KEY_${i}`]);
  if (keys.some((k) => k === undefined || k === "")) {
    throw new Error("missing keys: set SEED_PRIVATE_KEYS (4 comma-separated) or FUNDING_PRIVATE_KEY_1..4");
  }
  return keys;
}

const publicClient = createPublicClient({ chain: ARC_TESTNET, transport: http(rpcUrl) });
const keys = loadKeys();
console.log(`pool ${pool} rpc ${rpcUrl}`);

for (let i = 0; i < keys.length; i++) {
  const account = privateKeyToAccount(keys[i]);
  const walletClient = createWalletClient({ account, chain: ARC_TESTNET, transport: http(rpcUrl) });
  const label = `agent-${i + 1} ${account.address}`;
  const state = await getPoolState({ publicClient, pool });
  console.log(`[${label}] fill ${fromAtomicUsdc(state.totalCommitted)}/${fromAtomicUsdc(state.target)} settled=${state.settled} expired=${state.expired} count=${state.participantCount}`);
  if (state.settled || state.expired) {
    console.log(`[${label}] skip: pool settled/expired`);
    continue;
  }
  if (wouldExceedTarget(state, SHARE)) {
    console.log(`[${label}] skip: would exceed ${fromAtomicUsdc(state.target)} target`);
    continue;
  }
  const bal = await publicClient.readContract({ address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [account.address] });
  if (bal < SHARE) throw new Error(`[${label}] USDC balance ${fromAtomicUsdc(bal)} < 2.50, faucet: https://faucet.circle.com`);
  const allowance = await publicClient.readContract({ address: USDC, abi: erc20Abi, functionName: "allowance", args: [account.address, pool] });
  if (allowance < SHARE) {
    const approveHash = await walletClient.writeContract({ address: USDC, abi: erc20Abi, functionName: "approve", args: [pool, SHARE], account, chain: walletClient.chain });
    console.log(`[${label}] approve ${approveHash}`);
    await publicClient.waitForTransactionReceipt({ hash: approveHash });
  } else {
    console.log(`[${label}] allowance ok (${fromAtomicUsdc(allowance)})`);
  }
  const { hash } = await commitToPool({ walletClient, account, pool, amount: SHARE });
  console.log(`[${label}] commit ${hash}`);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  console.log(`[${label}] mined block=${receipt.blockNumber} status=${receipt.status}`);
}

const final = await getPoolState({ publicClient, pool });
console.log(`done: ${fromAtomicUsdc(final.totalCommitted)}/${fromAtomicUsdc(final.target)} USDC count=${final.participantCount} settled=${final.settled}`);

// Coalition ResourcePool mappings — AssemblyScript, The Graph event pattern.
//
// Event shapes mirror contracts/src/ResourcePool.sol via sdk/src/pool/abi.ts:
//   Committed(address indexed agent, uint256 amount)
//   Settled(uint256 total)
//   DroppedOut(address indexed agent, uint256 forfeited)
//   ExpiredFinalized(uint256 balance, uint256 claimants)
//   Refunded(address indexed agent, uint256 amount)
//   CompletionRecorded(uint256 indexed agentId, int128 value)
//
// Amounts stay BigInt end-to-end (6-decimal atomic USDC); no float math.
// Pool target is 10 USDC = 10000000 atomic; the live target is seeded once
// in getOrCreatePool and never overwritten by handlers.

import { BigInt } from "@graphprotocol/graph-ts";
import {
  Committed,
  CompletionRecorded,
  DroppedOut,
  ExpiredFinalized,
  Refunded,
  Settled,
} from "../generated/ResourcePool/ResourcePool";
import {
  Commitment,
  Completion,
  Dropout,
  Expiry,
  Pool,
  Refund,
  Settlement,
} from "../generated/schema";

// Pool target: 10 USDC in 6-decimal atomic units.
const POOL_TARGET = "10000000";

function eventId(txHash: string, logIndex: BigInt): string {
  return txHash.concat("-").concat(logIndex.toString());
}

function getOrCreatePool(poolAddress: string): Pool {
  let pool = Pool.load(poolAddress);
  if (pool == null) {
    pool = new Pool(poolAddress);
    pool.target = BigInt.fromString(POOL_TARGET);
    pool.totalCommitted = BigInt.zero();
    pool.forfeitedTotal = BigInt.zero();
    pool.settled = false;
    pool.expiredFinalized = false;
    pool.participantCount = BigInt.zero();
  }
  return pool;
}

export function handleCommitted(event: Committed): void {
  const poolAddress = event.address.toHexString();
  const pool = getOrCreatePool(poolAddress);
  pool.totalCommitted = pool.totalCommitted.plus(event.params.amount);
  pool.participantCount = pool.participantCount.plus(BigInt.fromI32(1));
  pool.save();

  const commitment = new Commitment(
    eventId(event.transaction.hash.toHexString(), event.logIndex),
  );
  commitment.pool = poolAddress;
  commitment.wallet = event.params.agent;
  commitment.amount = event.params.amount;
  commitment.block = event.block.number;
  commitment.timestamp = event.block.timestamp;
  commitment.txHash = event.transaction.hash;
  commitment.save();
}

export function handleDroppedOut(event: DroppedOut): void {
  const poolAddress = event.address.toHexString();
  const pool = getOrCreatePool(poolAddress);
  pool.forfeitedTotal = pool.forfeitedTotal.plus(event.params.forfeited);
  pool.participantCount = pool.participantCount.minus(BigInt.fromI32(1));
  pool.save();

  const dropout = new Dropout(
    eventId(event.transaction.hash.toHexString(), event.logIndex),
  );
  dropout.pool = poolAddress;
  dropout.wallet = event.params.agent;
  dropout.forfeited = event.params.forfeited;
  dropout.block = event.block.number;
  dropout.timestamp = event.block.timestamp;
  dropout.txHash = event.transaction.hash;
  dropout.save();
}

export function handleSettled(event: Settled): void {
  const poolAddress = event.address.toHexString();
  const pool = getOrCreatePool(poolAddress);
  // Settled fires on settle() AND on the finalizeExpired all-dropped sweep,
  // so this marks "funds left", not "threshold met". The kind heuristic:
  // total >= target means the settle path; otherwise the expiry sweep.
  pool.settled = true;
  pool.save();

  const kind = event.params.total.ge(pool.target) ? "settle" : "expiry-sweep";
  const settlement = new Settlement(
    eventId(event.transaction.hash.toHexString(), event.logIndex),
  );
  settlement.pool = poolAddress;
  settlement.total = event.params.total;
  settlement.kind = kind;
  settlement.block = event.block.number;
  settlement.timestamp = event.block.timestamp;
  settlement.txHash = event.transaction.hash;
  settlement.save();
}

export function handleExpiredFinalized(event: ExpiredFinalized): void {
  const poolAddress = event.address.toHexString();
  const pool = getOrCreatePool(poolAddress);
  // Expiry marker only — payouts follow as Refunded events per claimant.
  pool.expiredFinalized = true;
  pool.save();

  const expiry = new Expiry(
    eventId(event.transaction.hash.toHexString(), event.logIndex),
  );
  expiry.pool = poolAddress;
  expiry.balance = event.params.balance;
  expiry.claimants = event.params.claimants;
  expiry.block = event.block.number;
  expiry.timestamp = event.block.timestamp;
  expiry.txHash = event.transaction.hash;
  expiry.save();
}

export function handleRefunded(event: Refunded): void {
  const poolAddress = event.address.toHexString();
  getOrCreatePool(poolAddress).save();

  const refund = new Refund(
    eventId(event.transaction.hash.toHexString(), event.logIndex),
  );
  refund.pool = poolAddress;
  refund.wallet = event.params.agent;
  refund.amount = event.params.amount;
  refund.block = event.block.number;
  refund.timestamp = event.block.timestamp;
  refund.txHash = event.transaction.hash;
  refund.save();
}

export function handleCompletionRecorded(event: CompletionRecorded): void {
  const poolAddress = event.address.toHexString();
  getOrCreatePool(poolAddress).save();

  const completion = new Completion(
    eventId(event.transaction.hash.toHexString(), event.logIndex),
  );
  completion.pool = poolAddress;
  completion.agentId = event.params.agentId;
  completion.value = BigInt.fromString(event.params.value.toString());
  completion.block = event.block.number;
  completion.timestamp = event.block.timestamp;
  completion.txHash = event.transaction.hash;
  completion.save();
}

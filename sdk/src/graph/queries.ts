import type { Address } from "viem";

import type { GraphClient } from "./client.js";
import { GraphError } from "./types.js";
import type { Commitment, Dropout, PoolFill } from "./types.js";

const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
const UINT_PATTERN = /^\d+$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseAddress(value: unknown, field: string): Address {
  if (typeof value !== "string" || !ADDRESS_PATTERN.test(value)) {
    throw new GraphError(`graph field "${field}" is not an address`);
  }
  return value as Address;
}

function parseUint(value: unknown, field: string): bigint {
  if (typeof value !== "string" || !UINT_PATTERN.test(value)) {
    throw new GraphError(`graph field "${field}" is not a uint string`);
  }
  return BigInt(value);
}

function parseBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") {
    throw new GraphError(`graph field "${field}" is not a boolean`);
  }
  return value;
}

const POOL_FILL_QUERY = `query GetPoolFill($id: ID!) {
  pool(id: $id) {
    id
    target
    totalCommitted
    settled
    participantCount
  }
}`;

// Unset nullable $wallet coerces to null and filters wallet=null, so
// all-wallets and one-wallet reads cannot share one document.
const COMMITMENTS_QUERY = `query GetCommitments($pool: String!) {
  commitments(where: { pool: $pool }) {
    wallet
    amount
    blockNumber: block
  }
}`;

const COMMITMENTS_BY_WALLET_QUERY = `query GetCommitmentsByWallet($pool: String!, $wallet: String!) {
  commitments(where: { pool: $pool, wallet: $wallet }) {
    wallet
    amount
    blockNumber: block
  }
}`;

const DROPOUTS_QUERY = `query GetDropouts($pool: String!) {
  dropouts(where: { pool: $pool }) {
    wallet
    forfeited
  }
}`;

/**
 * POST a GraphQL operation and narrow the `data` field to a record.
 * GraphQL `errors` and malformed payloads throw GraphError — never partial data.
 */
async function postQuery(
  client: GraphClient,
  query: string,
  variables: Record<string, string>,
): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetch(client.endpoint, {
      method: "POST",
      headers: { ...client.headers },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(client.timeoutMs ?? 10_000),
    });
  } catch (error) {
    throw new GraphError(`graph request to ${client.endpoint} failed`, {
      cause: error,
    });
  }
  if (!response.ok) {
    throw new GraphError(`graph endpoint returned ${response.status}`);
  }
  const unknownBody: unknown = await response.json();
  if (!isRecord(unknownBody)) {
    throw new GraphError("graph payload is not an object");
  }
  if (unknownBody["errors"] !== undefined) {
    throw new GraphError("graph query returned errors");
  }
  const data = unknownBody["data"];
  if (!isRecord(data)) {
    throw new GraphError("graph payload data is not an object");
  }
  return data;
}

function parseCommitment(value: unknown): Commitment {
  if (!isRecord(value)) {
    throw new GraphError("graph commitment is not an object");
  }
  return {
    wallet: parseAddress(value["wallet"], "wallet"),
    amount: parseUint(value["amount"], "amount"),
    blockNumber: parseUint(value["blockNumber"], "blockNumber"),
  };
}

function parseDropout(value: unknown): Dropout {
  if (!isRecord(value)) {
    throw new GraphError("graph dropout is not an object");
  }
  return {
    wallet: parseAddress(value["wallet"], "wallet"),
    forfeited: parseUint(value["forfeited"], "forfeited"),
  };
}

/** Fetch one pool's fill snapshot from the subgraph's Pool entity. */
export async function getPoolFill(
  client: GraphClient,
  pool: string,
): Promise<PoolFill> {
  if (!ADDRESS_PATTERN.test(pool)) {
    throw new GraphError(`pool "${pool}" is not an address`);
  }
  const data = await postQuery(client, POOL_FILL_QUERY, {
    id: pool.toLowerCase(),
  });
  const raw = data["pool"];
  if (!isRecord(raw)) {
    throw new GraphError("graph pool is not an object");
  }
  return {
    pool: parseAddress(raw["id"], "id"),
    target: parseUint(raw["target"], "target"),
    totalCommitted: parseUint(raw["totalCommitted"], "totalCommitted"),
    settled: parseBoolean(raw["settled"], "settled"),
    participantCount: parseUint(raw["participantCount"], "participantCount"),
  };
}

/**
 * Fetch commitments for a pool from the subgraph's Commitment entity.
 * When `wallet` is given, only that wallet's commitments are returned.
 */
export async function getCommitments(
  client: GraphClient,
  pool: string,
  wallet?: string,
): Promise<readonly Commitment[]> {
  if (!ADDRESS_PATTERN.test(pool)) {
    throw new GraphError(`pool "${pool}" is not an address`);
  }
  if (wallet !== undefined && !ADDRESS_PATTERN.test(wallet)) {
    throw new GraphError(`wallet "${wallet}" is not an address`);
  }
  const data =
    wallet === undefined
      ? await postQuery(client, COMMITMENTS_QUERY, { pool: pool.toLowerCase() })
      : await postQuery(client, COMMITMENTS_BY_WALLET_QUERY, {
          pool: pool.toLowerCase(),
          wallet: wallet.toLowerCase(),
        });
  const raw = data["commitments"];
  if (!Array.isArray(raw)) {
    throw new GraphError('graph field "commitments" is not an array');
  }
  return raw.map(parseCommitment);
}

/** Fetch dropouts for a pool from the subgraph's Dropout entity. */
export async function getDropouts(
  client: GraphClient,
  pool: string,
): Promise<readonly Dropout[]> {
  if (!ADDRESS_PATTERN.test(pool)) {
    throw new GraphError(`pool "${pool}" is not an address`);
  }
  const data = await postQuery(client, DROPOUTS_QUERY, {
    pool: pool.toLowerCase(),
  });
  const raw = data["dropouts"];
  if (!Array.isArray(raw)) {
    throw new GraphError('graph field "dropouts" is not an array');
  }
  return raw.map(parseDropout);
}

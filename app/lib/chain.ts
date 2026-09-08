import { createPublicClient, http } from "viem";
import { sepolia } from "viem/chains";
import { ARC_TESTNET, ARC_TESTNET_RPC_HTTP } from "@jx-nexus/coalition";

/**
 * Server-only viem clients. RPC URLs and keys live in server env —
 * never NEXT_PUBLIC_ — so this module is imported by route handlers only.
 */

export function arcPublicClient() {
  const rpcUrl = process.env["ARC_RPC_URL"] ?? ARC_TESTNET_RPC_HTTP;
  return createPublicClient({ chain: ARC_TESTNET, transport: http(rpcUrl) });
}

export function sepoliaPublicClient() {
  const rpcUrl = process.env["SEPOLIA_RPC_URL"];
  return createPublicClient({
    chain: sepolia,
    transport: rpcUrl === undefined || rpcUrl === "" ? http() : http(rpcUrl),
  });
}

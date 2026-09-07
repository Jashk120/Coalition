/**
 * Minimal ENSv2 ABIs — only what `coalition-sdk` calls.
 *
 * Reads go through viem's Universal Resolver (`getEnsAddress` /
 * `getEnsResolver`) and need no ABI here. Writes are beta: verify every
 * entry below against `ensdomains/contracts-v2` HEAD before the Day-8 demo —
 * selectors may have changed since `plans/ensv2.md` was verified.
 */

/**
 * Multicoin address write (ENSIP-9/11, unchanged by v2).
 * `setAddr(bytes32 node, uint256 coinType, bytes a)`.
 */
export const ensAddrAbi = [
  {
    type: "function",
    name: "setAddr",
    inputs: [
      { name: "node", type: "bytes32" },
      { name: "coinType", type: "uint256" },
      { name: "a", type: "bytes" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
] as const;

/**
 * Enhanced Access Control for address records (beta — verify selector).
 * `authorizeAddrRoles(bytes dnsName, uint256 coinType, address wallet, bool allowed)`.
 * `dnsName` is the DNS-encoded name (`packetToBytes` from `viem/ens`).
 */
export const ensAccessControlAbi = [
  {
    type: "function",
    name: "authorizeAddrRoles",
    inputs: [
      { name: "dnsName", type: "bytes" },
      { name: "coinType", type: "uint256" },
      { name: "wallet", type: "address" },
      { name: "allowed", type: "bool" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "authorizeTextRoles",
    inputs: [
      { name: "dnsName", type: "bytes" },
      { name: "key", type: "string" },
      { name: "wallet", type: "address" },
      { name: "allowed", type: "bool" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
] as const;

/**
 * Subname registration on the parent's registrar (beta — verify selector).
 * `register(string label, address owner, address registry, address resolver,
 * uint256 roleBitmap, uint64 expiry)`.
 */
export const ensSubnameRegistrarAbi = [
  {
    type: "function",
    name: "register",
    inputs: [
      { name: "label", type: "string" },
      { name: "owner", type: "address" },
      { name: "registry", type: "address" },
      { name: "resolver", type: "address" },
      { name: "roleBitmap", type: "uint256" },
      { name: "expiry", type: "uint64" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
] as const;

# DEBUG-1 --- ENSv2 Agent Namespace Resolution on Sepolia

> **Historical record:** this is a detailed ENSv2 bring-up log, not the
> current judge entry point. Read [JUDGES.md](JUDGES.md) for the project
> overview and [ENS.md](ENS.md) for current wallet mappings, evidence, and
> limitations.

> Project: AgentPool / ENSv2 agent identity namespace\
> Network: Ethereum Sepolia\
> Purpose: Preserve the complete debugging trail showing how the agent
> namespace became functional on ENSv2 rather than relying on hard-coded
> application values.

> **Status.** This is the bring-up record for the ENSv2 namespace. The four
> `agentN.agentpool.eth` records were later re-pointed from the interim
> self-custody wallets shown below to the Circle Developer-Controlled Wallets
> used for funding. The current as-built addresses, state, and re-point
> transactions are in [`ENS.md`](ENS.md) §3; the wallets in this file are the
> historical bring-up values, kept for provenance.

## 1. Executive Summary

This debugging session established a working ENSv2 hierarchy:

``` text
agentpool.eth
├── agent1.agentpool.eth
├── agent2.agentpool.eth
├── agent3.agentpool.eth
└── agent4.agentpool.eth
```

Shared resolver:

``` text
0x2f60a75E4Dcd037110a8feaAB4b15f57B2BB9973
```

Final verified mappings:

  ----------------------------------------------------------------------------------
  ENSv2 name                          Wallet
  ----------------------------------- ----------------------------------------------
  `agent1.agentpool.eth`              `0x0427194a9c99599a8bbbcc292b1523be91e4101d`

  `agent2.agentpool.eth`              `0xd1a3c06eb92dfd48fa1bf10ba2071da25e39cd47`

  `agent3.agentpool.eth`              `0x072825b4ba2c8019ccceba10e59b29a40980be94`

  `agent4.agentpool.eth`              `0x67bc424b83be66f7f5c4fc2324d4154744f1b310`
  ----------------------------------------------------------------------------------

The final application-level test independently resolved all four ENS
names to the expected wallets. All four resolver/address transactions
checked during final verification returned `status=success`.

The important result is that the application resolves an agent's
identity from ENSv2 on-chain state rather than using a hard-coded wallet
mapping.

## 2. Why This Debug Session Matters

The namespace itself carries the agent identity:

``` text
agent1.agentpool.eth
        ↓
ENSv2 resolver
        ↓
addr record
        ↓
0x0427194a9c99599a8bbbcc292b1523be91e4101d
```

The same mechanism is used for all four agents.

This makes the ENS namespace an actual part of the application's
identity layer.

## 3. Parent Registry

Parent name:

``` text
agentpool.eth
```

Parent registry used for the subname operations:

``` text
0x365d676b7B95cf9c9E76531C8ab5bCEaD0e1dc34
```

The local ENSv2 registry ABI included:

``` ts
export const v2RegistryAbi = parseAbi([
  'function getState(uint256 anyId) external view returns ((uint8 status, uint64 expiry, address latestOwner, uint256 tokenId, uint256 resource))',
  'function getSubregistry(string label) external view returns (address)',
  'function register(string label, address owner, address registry, address resolver, uint256 roleBitmap, uint64 expires) external returns (uint256 tokenId)',
  'function ownerOf(uint256 tokenId) external view returns (address)',
  'function setResolver(uint256 anyId, address resolver) external',
  'function setSubregistry(uint256 tokenId, address registry) external',
])
```

Relevant Sepolia ENSv2 deployment configuration in the local CLI:

``` ts
v2: {
  registry: '0xBDC85dD5b15D7ecb354cd7cb6f2c50b4f2c4F0E2',
  registrar: '0xa88553F454b77203B0D036A05c894d555EAAa2Cc',
  paymentToken: '0x768F42455A2D082E23ceeF7d51e5787C82d67a39',
  resolverFactory: '0x10dC6333CDFe1FCEf624c6e0a8221b91804Cd7ef',
  resolverImplementation: '0x9EAe5C2730a7dD16BDD1DeE6421a1B91e3B0365e',
  resolverProxyLogic: '0xA136BeE4E37B44586242e516a39893EfD54315e9',
  subregistryImplementation: '0x624a25d67B59D587752EbEc8DdeD8827dAe52050',
  lockedMigrationController: '0x5c39E36a69A9897F08954c71aCB1F36E0Bd4f409',
  unlockedMigrationController: '0x2FCf83232b93bD29C59dB18AaA1D4b62e9f9FC73',
}
```

## 4. Attempt 1 --- Creating a Subname

Command:

``` bash
bun src/index.ts subname create agent1.agentpool.eth   --owner 0x0427194a9c99599a8bbbcc292b1523be91e4101d   --resolver 0x2f60a75E4Dcd037110a8feaAB4b15f57B2BB9973   --chain sepolia   --rpc https://ethereum-sepolia-rpc.publicnode.com
```

The CLI generated:

``` text
to: 0x365d676b7B95cf9c9E76531C8ab5bCEaD0e1dc34
name: agent1.agentpool.eth
parent: agentpool.eth
label: agent1
parentRegistry: 0x365d676b7B95cf9c9E76531C8ab5bCEaD0e1dc34
owner: 0x0427194a9c99599a8bbbcc292B1523BE91e4101D
resolver: 0x2f60a75E4Dcd037110a8feaAB4b15f57B2BB9973
resolverSource: option
subregistry: 0x0000000000000000000000000000000000000000
roleBitmap: "6089497235773768281585597070825043213744672768"
expiry: "1820412960"
version: v2
note: Transaction must be sent by an account with the registrar role on the parent subregistry.
```

This established an important operational requirement: creating the
subname requires the appropriate registrar role on the parent
subregistry.

## 5. CLI Investigation

The resolver command advertised:

``` text
ens resolver set — Generate calldata to change the resolver of an existing ENS name.
```

But running it against the nested name:

``` bash
bun src/index.ts resolver set agent1.agentpool.eth   --resolver 0x2f60a75E4Dcd037110a8feaAB4b15f57B2BB9973   --chain sepolia   --rpc https://ethereum-sepolia-rpc.publicnode.com
```

failed with:

``` text
Error: ENSv2 resolver set currently only supports 2LD .eth names
```

The same limitation appeared for `agent2.agentpool.eth`,
`agent3.agentpool.eth`, and `agent4.agentpool.eth`.

This was a CLI limitation, not evidence that the underlying ENSv2
registry could not manage the nested names.

## 6. Inspecting the Local ENSv2 Implementation

The local contract ABI exposed:

``` solidity
function setResolver(uint256 anyId, address resolver) external
```

The local helper code also explicitly handled nested subnames:

``` ts
export function splitSubname(name: string): { label: string; parent: string } {
  const dot = name.indexOf('.')
  if (dot <= 0 || dot === name.length - 1) {
    throw new Error(
      `"${name}" is not a subname. Expected at least one label under a parent (e.g. sub.parent.eth).`,
    )
  }
  return { label: name.slice(0, dot), parent: name.slice(dot + 1) }
}
```

and:

``` ts
export async function getV2ParentRegistryForName(opts: {
  client: PublicClient
  rootRegistry: `0x${string}`
  name: string
}) {
  const { label, parent } = splitSubname(opts.name)
  // ...
}
```

This helped isolate the problem to the command path rather than the
registry model.

## 7. Verifying Registry State

An initial lookup used the full ENS namehash:

``` bash
cast call   0x365d676b7B95cf9c9E76531C8ab5bCEaD0e1dc34   "getState(uint256)(uint8,uint64,address,uint256,uint256)"   $(cast namehash agent1.agentpool.eth)   --rpc-url https://ethereum-sepolia-rpc.publicnode.com
```

It returned:

``` text
0
0
0x0000000000000000000000000000000000000000
80329471711952133942704602501893073064149909447088622109145660568485771608064
80329471711952133942704602501893073064149909447088622109145660568485771608065
```

The successful lookup used the label identifier:

``` bash
cast keccak "agent1"
```

and:

``` bash
cast call   0x365d676b7B95cf9c9E76531C8ab5bCEaD0e1dc34   "getState(uint256)(uint8,uint64,address,uint256,uint256)"   $(cast keccak "agent1")   --rpc-url https://ethereum-sepolia-rpc.publicnode.com
```

Result:

``` text
2
1820412108
0x0427194a9c99599a8bbbcc292B1523BE91e4101D
12574331500417930745150951692014312166842720674563136141102103973686872637440
12574331500417930745150951692014312166842720674563136141102103973686872637440
```

The returned status was:

``` text
2 = REGISTERED
```

and the owner matched the intended agent wallet.

## 8. Direct ENSv2 Resolver Update

Because the CLI resolver command did not support nested names, the
registry ABI was used directly:

``` solidity
setResolver(uint256 anyId, address resolver)
```

For agent1:

``` bash
cast send   0x365d676b7B95cf9c9E76531C8ab5bCEaD0e1dc34   "setResolver(uint256,address)"   12574331500417930745150951692014312166842720674563136141102103973686872637440   0x2f60a75E4Dcd037110a8feaAB4b15f57B2BB9973   --rpc-url https://ethereum-sepolia-rpc.publicnode.com   --private-key "$PRIVATE_KEY"
```

Transaction:

``` text
blockNumber: 11661625
transactionHash:
0xca2bf196362d903fd8c4d2cd544436417371bba9d4ea473278da4ae4f1bf2cda
status: success
gasUsed: 50480
```

## 9. Agent2--Agent4 State

Agent2:

``` text
status: 2
owner: 0xd1a3C06eB92DfD48fA1bf10BA2071DA25e39Cd47
token/resource:
12914604233378511217194968470333727029220150315766677847302245112977196843008
```

Agent3:

``` text
status: 2
owner: 0x072825B4Ba2c8019CcCeba10E59B29A40980BE94
token/resource:
24882966361113136950817130719402461944115959501011664480851322662980025319424
```

Agent4:

``` text
status: 2
owner: 0x67Bc424b83be66F7F5C4fc2324d4154744F1b310
token/resource:
25867443390725204143302380863756677661471551408995265114941947885204149370880
```

All three were `REGISTERED`.

Resolver-setting transactions:

``` text
agent2
block: 11661630
tx: 0x8d01fb7b1a23c0cd0212fd54703c26240e8cd7769cf03f6419b00def8b537823
status: success

agent3
block: 11661631
tx: 0xc4ee29493f6091067dfb75b2c1ebe9e8335f720e5d8cc5169570b48f9d97e090
status: success

agent4
block: 11661632
tx: 0x50334fa84a3c661ae700f44046d5a31468471d8429e26a2743481987ad0a7fb5
status: success
```

## 10. Resolver Address Records

Resolver:

``` text
0x2f60a75E4Dcd037110a8feaAB4b15f57B2BB9973
```

Function:

``` solidity
setAddr(bytes32 node, uint256 coinType, bytes addr)
```

Coin type:

``` text
2152525650
```

An initial attempt passed an ABI-padded 32-byte address and failed:

``` text
InvalidEVMAddress(...)
```

The corrected form passed the raw 20-byte address:

``` text
0x0427194a9c99599a8bbbcc292b1523be91e4101d
```

Agent1 transaction:

``` text
block: 11661637
tx: 0x42f6a8b148b3e1cd63f521be37ee5d01face87fb16cd73714865261d8f7829ff
status: success
gasUsed: 63028
```

Agent2:

``` text
block: 11661638
tx: 0x8494eb51a7dcee06cd8efeba064fdda2b5fa62e0eeee9ba44e24c2dbba1e4a2b
status: success
gasUsed: 63028
```

Agent3:

``` text
block: 11661651
tx: 0x86347d755279d28542314da9a8fb5793648ce9438f4fd9422a37b86715159f20
status: success
gasUsed: 63028
```

Agent4:

``` text
block: 11661653
tx: 0x39fab94d4227679e966055fd4760343b665286209f04eb3c0872e9a5edc12be8
status: success
gasUsed: 63028
```

All four succeeded.

## 11. Final Independent Application Verification

The final verification used the actual application resolution helpers:

``` js
import { createPublicClient, http } from 'viem';
import { sepolia } from 'viem/chains';
import { resolveArcWallet, resolveEnsResolver } from '@jx-nexus/coalition';

const rpc = 'https://ethereum-sepolia-rpc.publicnode.com';
const c = createPublicClient({
  chain: sepolia,
  transport: http(rpc)
});

const pairs = [
  ['agent1.agentpool.eth','0x0427194a9c99599a8bbbcc292b1523be91e4101d'],
  ['agent2.agentpool.eth','0xd1a3c06eb92dfd48fa1bf10ba2071da25e39cd47'],
  ['agent3.agentpool.eth','0x072825b4ba2c8019ccceba10e59b29a40980be94'],
  ['agent4.agentpool.eth','0x67bc424b83be66f7f5c4fc2324d4154744f1b310']
];

for (const [name, expect] of pairs) {
  const res = await resolveEnsResolver({ publicClient: c, name });
  const w = await resolveArcWallet({ publicClient: c, name });
  console.log(
    name,
    'resolver=' + res,
    'wallet=' + w,
    w?.toLowerCase() === expect.toLowerCase()
      ? 'MATCH'
      : 'MISMATCH'
  );
}
```

Transaction receipts:

``` text
0x42f6a8b1 status=success
0x8494eb51 status=success
0x86347d75 status=success
0x39fab94d status=success
```

Final resolution:

``` text
agent1.agentpool.eth
resolver=0x2f60a75E4Dcd037110a8feaAB4b15f57B2BB9973
wallet=0x0427194a9c99599a8bbbcc292b1523be91e4101d
MATCH

agent2.agentpool.eth
resolver=0x2f60a75E4Dcd037110a8feaAB4b15f57B2BB9973
wallet=0xd1a3c06eb92dfd48fa1bf10ba2071da25e39cd47
MATCH

agent3.agentpool.eth
resolver=0x2f60a75E4Dcd037110a8feaAB4b15f57B2BB9973
wallet=0x072825b4ba2c8019ccceba10e59b29a40980be94
MATCH

agent4.agentpool.eth
resolver=0x2f60a75E4Dcd037110a8feaAB4b15f57B2BB9973
wallet=0x67bc424b83be66f7f5c4fc2324d4154744F1b310
MATCH
```

This is the strongest verification from the session because it exercises
the same resolution path the application uses.

## 12. Dashboard Integration

The dashboard consumes this same resolution stack at request time: `GET /api/agents`
(`app/app/api/agents/route.ts`) resolves every seed through `resolveSeedAgents`
and surfaces an `unresolved` status with a reason (and no wallet) when a name
does not resolve to the expected Arc wallet. ENSv2 resolution is therefore part
of the running application, not only the standalone verification script in §11.
See [`ENS.md`](ENS.md) §7b for the enforcement details.

## 13. Secret Handling

Transactions in this record were signed by the parent owner
`0x78F31B03De0E6473db80f2Da8c1a1cf5DB44A42a`. The signing key was supplied
through the shell environment (`$PRIVATE_KEY`) for the session only. No private
key, seed phrase, or session token is recorded in this document or anywhere in
the repository.

## 14. Problems and Lessons

### CLI limitation

`ens resolver set` rejected nested ENSv2 names with:

``` text
ENSv2 resolver set currently only supports 2LD .eth names
```

Resolution: call the underlying ENSv2 registry directly.

### Registry identifier confusion

A full namehash returned an empty state in the direct `getState()` call.
Using the label identifier for the parent registry returned the
registered state.

Lesson: direct registry calls must use the identifier expected by that
registry function; do not blindly substitute an ENS namehash.

### Resolver address encoding

The first `setAddr()` attempt used a 32-byte ABI-padded address and
failed with `InvalidEVMAddress`.

Resolution: pass the raw 20-byte EVM address in the resolver's `bytes`
argument.

### Shell environment

Some signing commands failed with:

``` text
Failed to decode private key
```

because the `$PRIVATE_KEY` variable was not available in that shell
session.

Verification:

``` bash
cast wallet address "$PRIVATE_KEY"
```

Lesson: keep the signing key outside the repository and load it
consistently into the shell environment.

## 15. Final On-Chain State

``` text
agentpool.eth
│
├── agent1.agentpool.eth
│   └── addr → 0x0427194a9c99599a8bbbcc292b1523be91e4101d
│
├── agent2.agentpool.eth
│   └── addr → 0xd1a3c06eb92dfd48fa1bf10ba2071da25e39cd47
│
├── agent3.agentpool.eth
│   └── addr → 0x072825b4ba2c8019ccceba10e59b29a40980be94
│
└── agent4.agentpool.eth
    └── addr → 0x67bc424b83be66f7f5c4fc2324d4154744F1b310
```

Shared resolver:

``` text
0x2f60a75E4Dcd037110a8feaAB4b15f57B2BB9973
```

Parent registry:

``` text
0x365d676b7B95cf9c9E76531C8ab5bCEaD0e1dc34
```

Network:

``` text
Ethereum Sepolia
```

Final application-level result:

``` text
MATCH
MATCH
MATCH
MATCH
```

## 16. Reproducibility

Read-only verification requires no private key.

``` bash
export RPC_URL="https://ethereum-sepolia-rpc.publicnode.com"
```

Transaction receipts can be checked with:

``` bash
cast receipt 0x42f6a8b148b3e1cd63f521be37ee5d01face87fb16cd73714865261d8f7829ff   --rpc-url "$RPC_URL"

cast receipt 0x8494eb51a7dcee06cd8efeba064fdda2b5fa62e0eeee9ba44e24c2dbba1e4a2b   --rpc-url "$RPC_URL"

cast receipt 0x86347d755279d28542314da9a8fb5793648ce9438f4fd9422a37b86715159f20   --rpc-url "$RPC_URL"

cast receipt 0x39fab94d4227679e966055fd4760343b665286209f04eb3c0872e9a5edc12be8   --rpc-url "$RPC_URL"
```

The application-level `viem` resolution test can then be run from the
project environment.

## 17. ENSv2 Features Demonstrated

This debugging session directly demonstrates:

-   hierarchical ENSv2 subnames;
-   Permissioned Registry state;
-   subname ownership;
-   resolver assignment at the ENSv2 registry level;
-   resolver address records;
-   live Sepolia transactions;
-   dynamic application-side ENS resolution;
-   four independent agent identities backed by on-chain state.

The project is not merely displaying ENS names while keeping the actual
mapping hard-coded elsewhere.

## 18. Scope of This Record

This document records the ENSv2 mechanics exercised during the bring-up:
hierarchical subnames, Permissioned Registry state, subname ownership,
resolver assignment at the registry level, resolver address records, live
Sepolia transactions, and dynamic application-side ENS resolution.

It does **not** cover advanced Enhanced Access Control policies, namespace
aliasing, record aliasing, expiry/revocation behavior, or per-record delegated
permissions. Where those features are specified or available-but-not-exercised,
that status is recorded in [`ENS.md`](ENS.md) §4 and §5.

## 19. Judge-Facing Takeaway

The important story is not that several commands failed.

The important story is that the debugging process established a real
on-chain identity path:

``` text
Agent identity
      ↓
ENSv2 hierarchical name
      ↓
Permissioned Registry
      ↓
resolver
      ↓
addr record
      ↓
agent wallet
```

The application can therefore use:

``` text
agent1.agentpool.eth
```

as the agent's identity reference, while the actual execution address
remains the resolved wallet.

The final independent test resolved all four agent names through the ENS
resolution stack and obtained the expected wallets.

That is the milestone captured by DEBUG-1.

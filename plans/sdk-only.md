# Coalition SDK — Implementation Plan (SDK-only)

Source of truth for scope: `.omo/Coalition_10-Day_Implementation_Plan_Updated.md` §2 (repos/packages), §4 (Arc facts), Day-6 SDK bullet, §8 (Agent Stack decisions).
This plan covers **only `sdk/`**. No contracts, app, orchestrator, subgraph, or ENS work.

## 1. Goal

Build `sdk/` (`@jx-nexus/coalition`, v0.1.0) into a typed, tree-shakable protocol client that:

1. Exposes Arc chain config + dual-USDC decimal helpers (`chains/`).
2. Wraps ERC-8004 `IdentityRegistry` (register, setAgentWallet, resolve) (`identity/`).
3. Reads ERC-8004 `ReputationRegistry` summaries (`reputation/`).
4. Wraps the custom `ResourcePool` contract (commit, dropOut, finalize, reads) (`pool/`).
5. Ships with unit tests + docs so the Next.js app and agents can `npm install` it and dogfood it.

Success = `npm run check` clean, `npm run build` emits `dist/`, `npm test` green (mocked transports, no live RPC needed), README shows copy-paste usage for all four modules.

## 2. Non-goals (explicitly OUT)

- Writing/deploying `ResourcePool.sol` or any Foundry work in `contracts/`.
- Building `app/`, `orchestrator/`, `subgraph/`, ENSv2 subnames.
- Live Day-1 de-risk (wallet creation, faucet, live register) — plan for it, don't execute it here.
- Circle Agent Stack integration — Agent Wallets are canonical per §8 (custody/permissions guardrails). SDK takes injected viem `WalletClient`/account signers so Agent Stack signers plug in; no Agent Stack SDK import in the core path, no parallel DCA path, no Marketplace/UPI code in this plan.
- Publishing to npm (leave as local `dist/` build; publishing is a Day-10 decision).

## 3. Current state

- `sdk/package.json`: name `@jx-nexus/coalition`, ESM, `main ./dist/index.js`, scripts `build`/`check`/`test`, deps `viem`, devDeps `typescript` + `vitest`, engines `node>=26`.
- `sdk/tsconfig.json`: `ES2024`, `NodeNext`, `strict`, `declaration`, `outDir dist`, `rootDir src`.
- `sdk/src/index.ts`: stub — `VERSION` + `coalitionSdk()` only. No `chains/`, `identity/`, `reputation/`, `pool/`.
- Repo root has no `contracts/` yet → `ResourcePool` ABI is **unknown**. Plan handles this via a checked-in minimal ABI file with a TODO to replace from Foundry output.

## 4. Decisions locked by this plan (no further interview needed)

| Decision | Choice | Reason |
|---|---|---|
| Chain lib | `viem@^2` (peer: `^2`) | Modern, tree-shakable, typed contract calls; matches ESM + NodeNext. `ethers` rejected (heavier, v5/v6 churn). |
| Test runner | `vitest@^3` + `@vitest/coverage-v8` devDeps | ESM-native, fast, no ts-jest config tax. |
| Module style | Pure functions taking viem clients (`PublicClient`, `WalletClient`) — no class singletons | Testable with mocked transports; Agent Stack/agents inject their own signer later. |
| Address config | Constants with override: `ARC_TESTNET` object + per-registry address params defaulting to §4 values | Testnet addresses are confirm-before-rely; overridable params survive redeploys. |
| ResourcePool ABI | Hand-minimal `pool/abi.ts` (`commit`, `dropOut`, `finalizeExpired`, `settle`, view fns, events) marked `// TODO: replace with contracts/out/ResourcePool.sol/ResourcePool.json` | Unblocks SDK without blocking on contracts/. |
| Amount handling | All on-chain amounts as `bigint` atomic units; helpers `toAtomicUsdc(display, decimals)` / `fromAtomicUsdc` | Dual-decimal gotcha (18 native vs 6 ERC-20) must be explicit at call sites. |
| Exports | `src/index.ts` re-exports all four modules + `VERSION` | Stable public API; app imports one package. |

## 5. Target file tree

```
sdk/
├── package.json            # add viem (dep), vitest (dev), test script
├── tsconfig.json           # unchanged (already strict/NodeNext)
├── README.md               # expand: install, quickstart per module, decimals warning
├── src/
│   ├── index.ts            # re-export VERSION + chains/identity/reputation/pool
│   ├── chains/
│   │   ├── index.ts        # re-export
│   │   ├── arc.ts          # ARC_TESTNET chain def, RPC/explorer/faucet constants
│   │   └── usdc.ts         # NATIVE_DECIMALS=18, ERC20_DECIMALS=6, to/fromAtomic helpers
│   ├── identity/
│   │   ├── index.ts
│   │   ├── addresses.ts    # IDENTITY_REGISTRY_ADDRESS default 0x8004A818…BD9e (overridable)
│   │   ├── abi.ts          # minimal ERC-8004 IdentityRegistry ABI (register, setAgentWallet, getMetadata)
│   │   └── client.ts       # registerAgent(), setAgentWallet(), resolveAgent() using PublicClient/WalletClient
│   ├── reputation/
│   │   ├── index.ts
│   │   ├── addresses.ts    # REPUTATION_REGISTRY_ADDRESS default 0x8004B663…8713
│   │   ├── abi.ts          # minimal ABI (giveFeedback, getSummary, readFeedback)
│   │   └── client.ts       # getSummary(), readFeedback() (read-only → PublicClient only)
│   └── pool/
│       ├── index.ts
│       ├── addresses.ts    # RESOURCE_POOL_ADDRESS placeholder (required param, no default)
│       ├── abi.ts          # minimal ResourcePool ABI (commit/dropOut/finalizeExpired/settle + views + events)
│       ├── client.ts       # commitToPool(), dropOut(), finalizeExpired(), settlePool(), getPoolState()
│       └── types.ts        # PoolState, CommitParams, branded Address/Wei types
└── test/
    ├── chains.test.ts      # decimal round-trips, chain id/rpc constants
    ├── identity.test.ts    # mocked-transport call encoding for register/resolve
    ├── reputation.test.ts  # getSummary parsing
    └── pool.test.ts        # commit/dropOut/finalize encoding + PoolState mapping
```

Keep every file <250 LOC. No `src/common/` shared-misc bucket — shared types live in `pool/types.ts` or per-module files.

## 6. Module specs

### 6a. `chains/` — Arc config + dual decimals

```ts
// arc.ts
export const ARC_TESTNET_ID = 5042002;
export const ARC_TESTNET_RPC_HTTP = "https://rpc.testnet.arc.network";
export const ARC_TESTNET_RPC_WS = "wss://rpc.testnet.arc.network"; // verify on Day 1, keep WS constant separate
export const ARC_EXPLORER = "https://testnet.arcscan.app";
export const ARC_FAUCET = "https://faucet.circle.com";
export const ARC_TESTNET = { id, rpcUrls, blockExplorers, nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 } } // viem chain shape
// usdc.ts
export const USDC_NATIVE_DECIMALS = 18;
export const USDC_ERC20_DECIMALS = 6;
export function toAtomicUsdc(display: string, decimals?: 18 | 6): bigint  // decimal-string → bigint, throws on >decimals precision
export function fromAtomicUsdc(atomic: bigint, decimals?: 18 | 6): string // bigint → display string, no float math
```

Rules: never use `number`/`parseFloat` for amounts; `display` is always a decimal string.

### 6b. `identity/` — ERC-8004 IdentityRegistry wrapper

Functions (all take explicit clients, never import a global client):

```ts
registerAgent(p: { walletClient: WalletClient; account: Address; metadataURI: string; registry?: Address }): Promise<{ agentId: bigint; hash: Hash }>
setAgentWallet(p: { walletClient: WalletClient; account: Address; agentId: bigint; wallet: Address; registry?: Address }): Promise<{ hash: Hash }>
resolveAgent(p: { publicClient: PublicClient; agentId: bigint; registry?: Address }): Promise<{ metadataURI: string; wallet: Address }>
```

- `abi.ts`: `register(string) returns (uint256)`, `setAgentWallet(uint256,address)`, `getMetadata(uint256)`, `tokenURI(uint256)` — mark each entry `// verify selector against ERC-8004 ref deployment before Day-6 demo`.
- `addresses.ts`: `DEFAULT_IDENTITY_REGISTRY = "0x8004A818…" as Address` — full literal from the updated plan §4 (copy exact, don't truncate in code).
- Errors: typed `IdentityError` with `cause`; never swallow RPC errors.

### 6c. `reputation/` — ERC-8004 ReputationRegistry reads

```ts
getReputationSummary(p: { publicClient: PublicClient; agentId: bigint; registry?: Address }): Promise<{ score: bigint; count: bigint }>
readFeedback(p: { publicClient: PublicClient; agentId: bigint; index: bigint; registry?: Address }): Promise<FeedbackEntry>
```

- Read-only: `PublicClient` only, no signer needed.
- `FeedbackEntry = { from: Address; value: bigint; tag: string }` (shape to be tightened once live ABI confirmed; note assumption in code comment).

### 6d. `pool/` — ResourcePool wrapper (the differentiator)

```ts
commitToPool(p: { walletClient; account; pool: Address; amount: bigint }): Promise<{ hash: Hash }>
dropOut(p: { walletClient; account; pool: Address; agentId: bigint }): Promise<{ hash: Hash }>
finalizeExpired(p: { walletClient; account; pool: Address }): Promise<{ hash: Hash }>
settlePool(p: { walletClient; account; pool: Address }): Promise<{ hash: Hash }>
getPoolState(p: { publicClient; pool: Address }): Promise<PoolState>
// PoolState = { target: bigint; totalCommitted: bigint; settled: boolean; expired: boolean; participantCount: bigint }
```

- `addresses.ts` exports **no default** — `pool` is always a required param (one pool, one VPS; address comes from deploy output).
- `abi.ts` minimal: `commit(uint256)`, `dropOut(uint256)`, `finalizeExpired()`, `settle()`, views `target()`, `totalCommitted()`, `settled()`, `expired()`, `participantCount()`, events `Committed`, `Settled`, `Refunded`, `DroppedOut` — all marked TODO-replace from Foundry artifact.
- Amounts in/out as `bigint`; callers convert via `toAtomicUsdc` first. Cap check helper: `wouldExceedTarget(state, amount)` → boolean (mirrors "cap over-commit at targetAmount").

### 6e. `src/index.ts` public API

```ts
export const VERSION = "0.1.0";       // keep existing export (breaking change forbidden)
export function coalitionSdk(): string // keep existing (tests pin it)
export * from "./chains/index.js";
export * from "./identity/index.js";
export * from "./reputation/index.js";
export * from "./pool/index.js";
```

Note: NodeNext ESM → internal re-exports must use `.js` suffixes.

## 7. Test matrix (vitest, mocked transports — no live RPC)

| Test file | Cases | Assertion |
|---|---|---|
| `chains.test.ts` | `toAtomicUsdc("1.5",6)` → `1500000n`; round-trip `fromAtomicUsdc` | exact bigint/string equality |
| | `toAtomicUsdc("0.0000001",6)` throws (over-precision) | throws |
| | `ARC_TESTNET.id === 5042002`, RPC + explorer constants non-empty | equality |
| `identity.test.ts` | `registerAgent` encodes `register` with metadataURI via mock transport | request `to` = registry, data starts with selector |
| | `resolveAgent` returns mocked metadataURI + wallet | parsed shape |
| `reputation.test.ts` | `getReputationSummary` maps mocked tuple → `{score,count}` | equality |
| `pool.test.ts` | `commitToPool` encodes amount as bigint, no float path | data contains 32-byte amount |
| | `getPoolState` maps 5 mocked view returns → `PoolState` | equality |
| | `wouldExceedTarget` true/false boundary | boolean |
| existing | `coalitionSdk()` still returns `@jx-nexus/coalition/0.1.0` | pinned (no break) |

Mock pattern: `createPublicClient({ transport: custom({ request: async ({method}) => mock }) })` — assert on captured `params`. No `test.sequential` network calls.

## 8. Execution steps (in order, each verifiable)

1. **Deps**: `npm install -S viem && npm install -D vitest @vitest/coverage-v8` in `sdk/`. Verify: `npm ls viem vitest`.
2. **Chains**: add `src/chains/{arc,usdc,index}.ts` + `test/chains.test.ts`. Verify: `npx vitest run test/chains.test.ts`.
3. **Identity**: add `src/identity/{addresses,abi,client,index}.ts` + `test/identity.test.ts`. Verify: `npx vitest run test/identity.test.ts`.
4. **Reputation**: add `src/reputation/*` + `test/reputation.test.ts`. Verify: same per-file run.
5. **Pool**: add `src/pool/{addresses,abi,client,types,index}.ts` + `test/pool.test.ts`. Verify: same per-file run.
6. **Public API**: rewrite `src/index.ts` re-exports (keep `VERSION` + `coalitionSdk`). Verify: `npm run check`.
7. **Full gate**: `npm run check && npm run build && npx vitest run`. All green, `dist/` contains `chains/ identity/ reputation/ pool/` outputs + `.d.ts`.
8. **Docs**: expand `sdk/README.md` — install, per-module 10-line quickstart, dual-decimal warning box, "replace pool ABI from Foundry" note. Verify: code blocks typecheck by inspection against `src/`.

Each step touches only its module + its test. If a step fails its verify command, stop — don't proceed to the next module.

## 9. Acceptance gate (SDK done)

```
workdir=sdk/; npm run check && npm run build && npx vitest run
```

- `tsc --noEmit` exit 0 (strict, no `any`/`ts-ignore`).
- `tsc -p tsconfig.json` emits `dist/index.{js,d.ts}` + per-module outputs.
- All vitest files pass with mocked transports (zero network).
- README quickstarts match exported function names exactly.

## 10. Risks / assumptions to carry into build

1. ERC-8004 selectors/addresses in §4 are "confirm before relying" — code defaults them but every call accepts an override; Day-6 live check replaces literals.
2. `ResourcePool` ABI is a placeholder until `contracts/` lands — `pool/abi.ts` header must say so; do not invent extra functions beyond §6d list.
3. WS RPC URL form unverified — keep it a separate constant so a wrong guess breaks one line, not the chain def.
4. npm naming — RESOLVED: `@jx-nexus/coalition` (set in `package.json`). Do not rename in this plan.

## 11. What the worker must NOT do

- No `contracts/`, `app/`, `orchestrator/`, `subgraph/`, ENS code or docs.
- No live RPC calls, no faucet, no wallet creation, no deployments.
- No `as any`, `@ts-ignore`, empty `catch {}`, or float-based amount math.
- No commit/push (plan only defines code; version control is the caller's call).

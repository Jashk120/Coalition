# ENS.md — Best Use of ENSv2 ($4,500) submission receipt

**Overall: CONDITIONAL PASS.** The scored resolution path is implemented in
`sdk/src/ens/` and wired as the optional scored step in
`plans/agent-loop.md` §3b. On-chain Day-8 registration is not yet executed,
so every live-execution item below is a `TODO` — fill before submitting.

## 1. Qualification fit (per requirement)

| # | Requirement (Day-10 plan §7) | Verdict | Evidence |
|---|---|---|---|
| 1 | Built on ENSv2 Sepolia deployment | PASS (code) | `sdk/src/ens/addresses.ts`; all reads target Sepolia via viem `sepolia` client (`sdk/src/ens/client.ts`) |
| 2 | Subname registry + EAC central to identity flow, resolving to Arc wallet → ERC-8004, not hardcoded | CONDITIONAL PASS | Scored path `resolveEnsToAgents` (subname → Arc wallet → agent ids) is the §3b optional-first step; live registration + seed-wallet cross-check still TODO (Day-8 exit criteria) |
| 3 | Public repo + ENS.md receipt (Sepolia addresses, EAC roles) | PASS on receipt, TODO on visibility | This file; TODO-1 confirms repo visibility |
| 4 | Video AND live demo link | TODO | Placeholders in §8; Day-10 beats apply |
| 5 | Beta caveats on record | PASS | §9 below |

Do not claim central-use until TODO-4 (live `agent1.agentpool.eth` →
Arc wallet → ERC-8004 read on video) is done; until then the flow is
fallback-optional, not central.

## 2. Sepolia addresses used

Source of truth: `docs.ens.domains/learn/deployments/#sepolia-ensv2-beta` +
`contracts/deployments/sepolia/*.json` in `ensdomains/contracts-v2`.
Last checked against docs: **2026-09-07** (`plans/ensv2.md` header).
Re-check: **before Day 8 and again at demo time** — every literal below is
overridable per SDK call.

| Contract | Address in `sdk/src/ens/addresses.ts` | Status |
|---|---|---|
| UniversalResolver proxy | `0xeEeEEEeE14D718C2B47D9923Deab1335E144EeEe` | Stable; prefer the viem `sepolia` preset over the literal |
| ETHRegistry (`.eth`) | `0xbdc85dd5b15d7ecb354cd7cb6f2c50b4f2c4f0e2` | Re-check before use |
| ETHRegistrar | `0xa88553f454b77203b0d036a05c894d555eaaa2cc` | Re-check before use |
| RootRegistry | `0x8115186e8f2e0b0281e86ab91f0f48ba90364354` | Re-check before use |
| PermissionedResolver impl | `0x9eae5c2730a7dd16bdd1dee6421a1b91e3b0365e` | Re-check before use |
| UserRegistry impl | `0x624a25d67b59d587752ebec8dded8827dae52050` | Re-check before use |
| VerifiableFactory | TODO-2 — rotated already, no default exported on purpose | Re-fetch from `sepolia/*.json` |
| MockUSDC (mintable, 6-dec) | TODO-2 — rotated already | Re-fetch; `mint` open + `approve`-before-`register` |
| Parent `agentpool.eth` token/owner | TODO-3 — parent not yet registered | Register on Sepolia first |
| Per-subname resolver instances | TODO-4 — deployed at `registerSubname` time | Record after Day-8 run |

Cross-chain constants: Arc chain `5042002`, `ARC_COIN_TYPE = 2152525650`
(`0x80000000 | 5042002`, ENSIP-9/11; asserted vs `toCoinType(5042002)` in
`sdk/test/ens.test.ts`).

## 3. Names: parent + 4 subnames

Wallets are demo seeds (`demo/agents.seeds.json` — deterministic, no
on-chain writes by the file itself). `agentId` is `null` in seeds and is
filled at runtime via `registerAgent` — cross-check live at TODO-4.

| Name | Arc wallet (seed) | ERC-8004 agentId |
|---|---|---|
| `agentpool.eth` (parent) | — (operator-owned; TODO-3) | — |
| `agent1.agentpool.eth` | `0x0427194a9c99599a8bbbcc292b1523be91e4101d` | TODO-4 (runtime) |
| `agent2.agentpool.eth` | `0xd1a3c06eb92dfd48fa1bf10ba2071da25e39cd47` | TODO-4 (runtime) |
| `agent3.agentpool.eth` | `0x072825b4ba2c8019ccceba10e59b29a40980be94` | TODO-4 (runtime) |
| `agent4.agentpool.eth` | `0x67bc424b83be66f7f5c4fc2324d4154744f1b310` | TODO-4 (runtime) |

Held out (never a subname, never commits): resale buyer
`0x71846352cc198d7f3bfeb677f8631eb84d311329`.

## 4. EAC roles (specified; grants execute at TODO-4)

| Grant | Call | Intended value |
|---|---|---|
| Registrar on parent registry | `grantRootRoles` | `ROLE_REGISTRAR \| ROLE_RENEW` |
| Per-subname registration | `register(label, owner, registry, resolver, roleBitmap, expiry)` | `roleBitmap = SET_SUBREGISTRY(+ADMIN) \| SET_RESOLVER(+ADMIN) \| CAN_TRANSFER_ADMIN` |
| Per-agent record write | `authorizeAgentRecord` → `authorizeAddrRoles(dnsName, coinType 2152525650, agentWallet, true)` | Each agent wallet writes only its own Arc record; revoke with `allowed: false` |
| Optional single-key text | `authorizeTextRoles` (exposed in ABI, not in scored path) | Only if the demo needs one text key per agent |

Resolver addresses are looked up fresh per write (`resolveEnsResolver`,
never cached); label caches key by `labelhash`, never by mutable token id.

## 5. Resolver strategy

- **Own subname registry (chosen).** Deploy a `UserRegistry` proxy via
  `VerifiableFactory.deployProxy` with salt
  `keccak256("UserRegistry", namehash(parent), version)`
  (`buildUserRegistrySalt({ parentName, version })`), `initialize` with root
  roles, `setSubregistry` on the parent, `grantRootRoles` to the registrar.
- **Wildcard resolution (reserve, not used).** `IExtendedResolver.resolve`
  stays in reserve — longest-suffix inheritance means registration alone can
  be enough to resolve, so no wildcard gateway is needed for 4 flat subnames.
- **Permissioned Resolver per subname (chosen).** Each subname registers with
  its own resolver instance; all reads go through the Universal Resolver,
  never direct (`resolveArcWallet`, `resolveEnsResolver`).
- **Record aliasing via `setAlias` (reserve, not used).** No shared records
  needed — each agent owns exactly one Arc multicoin record.
- **Namespace aliasing, two names → same subregistry (not used).** Only if
  the demo needs a second parent; explicitly cut (one pool, one parent).
- **Expiry / revocable / transferability (specified).** Short `expiry` with
  `ROLE_RENEW` kept = expiring names; `unregister` = revocable; drop
  `CAN_TRANSFER_ADMIN` from the bitmap for non-transferable demo names.
  Final bitmap/expiry values are recorded at TODO-4. Lock-forever (revoke
  role *and* admin from self) is irreversible — do NOT use in the demo.

## 6. SDK methods and params used

`sdk/src/ens/client.ts` (reads via viem Universal Resolver; writes via
`writeContract`; ABIs in `sdk/src/ens/abi.ts`):

- `resolveArcWallet({ publicClient /* Sepolia */, name, coinType? (= 2152525650), universalResolver? })` → `Address | null`
- `resolveEnsResolver({ publicClient, name, universalResolver? })` → `Address` (fresh lookup, throws `EnsError` on `zeroAddress`)
- `resolveEnsToAgents({ sepoliaClient, arcClient, name, coinType?, identityRegistry? })` → `{ arcWallet, agentIds } | null` — the scored path (subname → Arc wallet → `findAgentsByOwner` on `Registered` logs, zero gas → per-id `resolveAgent` / `getReputationSummary`)
- `registerSubname({ walletClient, account, registrar, label, parentName? (= "agentpool.eth"), owner, registry, resolver, roleBitmap, expiry })` → `{ hash, name }`
- `setArcAddressRecord({ walletClient, publicClient?, account, name, arcWallet, resolver?, coinType? })` → `{ hash, resolver }` (`setAddr(namehash, coinType, bytes)`)
- `authorizeAgentRecord({ walletClient, account, name, resolver, agentWallet, allowed, coinType? })` → `{ hash }` (`authorizeAddrRoles(DNS-encoded name, …)`)
- `buildUserRegistrySalt({ parentName?, version })` → `Hex` (factory salt; encoding assumption — verify vs `VerifiableFactory` before Day 8)
- `createEnsLabelCache<T>()` — labelhash-keyed cache; never stores resolvers

## 7. ENSv2 prompt feature map

| Prompt feature (quoted) | Coalition usage or explicit non-use + reason |
|---|---|
| Hierarchical registry | USED — `agentpool.eth` parent → `agent1..4` subnames; own `UserRegistry` proxy under the parent (§5) |
| Wildcard resolution | RESERVE — not needed; longest-suffix inheritance covers flat subnames |
| Own subname registry | USED — `UserRegistry` via factory salt + `setSubregistry` + `grantRootRoles` (TODO-4 executes) |
| EAC delegation | USED — per-agent `authorizeAddrRoles` least privilege; registrar gets `ROLE_REGISTRAR \| ROLE_RENEW` |
| Permissioned Resolver ownership | USED — per-subname resolver set at `register`; fresh lookup per write, never cached |
| Record aliasing | RESERVE — `setAlias` record-sharing unused; 1 agent = 1 Arc record |
| Namespace aliasing | NOT USED — second parent only if demo needs it; cut per one-pool scope |
| Expiring / revocable / non-transferable vs transferable / forever names | SPECIFIED — short expiry + `ROLE_RENEW` (expiring), `unregister` (revocable), bitmap without `CAN_TRANSFER_ADMIN` (non-transferable); values recorded at TODO-4 |
| Agents-as-namespaces bonus (own identity + permissions) | USED — subname → Arc wallet → ERC-8004 `resolveAgent` + `getReputationSummary` is our own composition; each namespace carries its own EAC-scoped write permission |

## 8. Video timestamps + live demo URL

Spoken 2–4 min, 720p+; ENS discovery beat ~60s inside the resale + ENS
segment (Day-10 plan §Day 10). All values TODO until the cut exists.

| Beat | Timestamp | Content |
|---|---|---|
| ENS discovery | TODO-5 `MM:SS` | Live `agent1.agentpool.eth` → Arc wallet → ERC-8004 identity + reputation |
| Track-fit card (ENS) | TODO-5 `MM:SS` | Subname registry + EAC summary |
| Live demo URL | TODO-6 | Deployed app URL (Next.js consumer of `coalition-sdk`) |
| Video URL | TODO-5 | Hosted recording URL |

## 9. Honest limitations (beta on record)

- ENSv2 is **beta on Sepolia**: interfaces not final, addresses rotate —
  re-fetch the Deployments table before Day 8 and at demo time.
- `VerifiableFactory` (and `MockUSDC`) already rotated once between the docs
  pin and repo HEAD — no default exported; pass explicitly per call.
- Write ABIs in `sdk/src/ens/abi.ts` (`setAddr`, `authorizeAddrRoles`,
  `authorizeTextRoles`, `register`) must be verified against
  `ensdomains/contracts-v2` HEAD before the demo; selectors may have changed.
- Clean Beta registry (Alpha names wiped); fees are MockUSDC/testnet-USDC
  only with a 28-day grace window — no mainnet names involved.
- The ENS↔ERC-8004 hop (`resolveEnsToAgents`) is our own composition; no
  official doc blesses subname → L2 wallet → ERC-8004, and the agent-loop
  uses it as an optional scored-first step, not yet the live central path.
- `buildUserRegistrySalt` encoding is an assumption until verified against
  the live `VerifiableFactory`.

## 10. TODO fill-in list (owner + command)

- TODO-1 (owner: submitter): confirm repo is public; record URL.
  `gh repo view --json visibility,url`
- TODO-2 (owner: Day-8 operator): re-fetch Deployments table + factory JSONs;
  record `VerifiableFactory` + `MockUSDC` + re-check date in §2.
  `curl -s https://docs.ens.domains/learn/deployments/ && ls contracts-v2/contracts/deployments/sepolia/`
- TODO-3 (owner: Day-8 operator): register `agentpool.eth` on Sepolia;
  record tx hash + owner in §2/§3. `cast send <ETHRegistrar> "register(...)"`
  (exact args from live registrar ABI — verify first)
- TODO-4 (owner: Day-8 operator): deploy subname registry, register
  `agent1..4`, set Arc records, grant EAC roles; record resolver instances,
  tx hashes, final bitmap/expiry, runtime `agentId`s, and the seed-wallet
  cross-check (`resolveEnsToAgents` output vs `demo/agents.seeds.json`).
  Commands: `registerSubname` / `setArcAddressRecord` /
  `authorizeAgentRecord` via `sdk/` (Sepolia wallet client), then
  `resolveEnsToAgents({ sepoliaClient, arcClient, name })` per subname
- TODO-5 (owner: Day-10 editor): record video, fill §8 timestamps + video URL
- TODO-6 (owner: Day-10 deployer): deploy demo app, fill live demo URL in §8

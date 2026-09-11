# ENS.md: Best Use of ENSv2 ($4,500) submission receipt

**Overall: ENS is central and load-bearing, not optional.** Funding is gated
on `funderWallet == ENS wallet` (see §7b). Resolution was re-verified
2026-09-11 via `cast` against
`https://ethereum-sepolia-rpc.publicnode.com`, independent of the repo's
earlier receipts. EAC grant/revoke has not been exercised live. Video and
live demo URL are still TODO (§8, §10 TODO-5/6).

Repo is PUBLIC: https://github.com/Jashk120/Coalition (verified via GitHub
API: `private=false`). ENS commits are in `origin/main`.

## 1. Qualification fit (per requirement)

| # | Requirement (Day-10 plan §7) | Verdict | Evidence |
|---|---|---|---|
| 1 | Built on ENSv2 Sepolia deployment | PASS (code + live) | `sdk/src/ens/addresses.ts`; all reads target Sepolia via viem `sepolia` client (`sdk/src/ens/client.ts`); live resolution verified 2026-09-10 and re-verified 2026-09-11 via `https://ethereum-sepolia-rpc.publicnode.com` (§3) |
| 2 | Subname registry + EAC central to identity flow, resolving to Arc wallet to ERC-8004, not hardcoded | PASS on resolution and registry, AVAILABLE on EAC (not exercised live) | Scored path `resolveEnsToAgents` (subname to Arc wallet to agent ids) verified live for all 4 subnames 2026-09-11 with no fallback; own subname registry USED (§2, §5); EAC selectors present in resolver bytecode but no live grant exercised (§4) |
| 3 | Central, not cosmetic | PASS | ENS gates `GET /api/agents`, `POST /api/agents/run`, and `POST /api/agents/fund` (§7b); unresolved seeds get no wallet and cannot run or fund |
| 4 | Public repo + ENS.md receipt (Sepolia addresses, EAC roles) | PASS on receipt, PASS on visibility | This file; repo public at https://github.com/Jashk120/Coalition, ENS commits in `origin/main` |
| 5 | Video OR live demo | FAIL (TODO) | Placeholders in §8; TODO-5 (video) and TODO-6 (demo URL) still open; no video claimed |
| 6 | Beta caveats on record | PASS | §9 below |

Do not claim EAC enforcement or a video until §4 and §8 say otherwise.

## 2. Sepolia addresses used

Source of truth: `docs.ens.domains/learn/deployments/#sepolia-ensv2-beta` +
`contracts/deployments/sepolia/*.json` in `ensdomains/contracts-v2`.
Last checked against docs: **2026-09-07** (`plans/ensv2.md` header).
Live re-verification: **2026-09-11** via `cast` (§3 method).
Re-check: **at demo time**; every literal below is overridable per SDK call.

| Contract | Address | Status |
|---|---|---|
| UniversalResolver proxy | `0xeEeEEEeE14D718C2B47D9923Deab1335E144EeEe` | Docs-table literal; used for reads via viem `sepolia` preset |
| ETHRegistry (`.eth`) | `0xbdc85DD5b15D7ecb354cd7cb6f2c50b4f2c4F0E2` | Docs-table literal; USED as the `.eth` registry. `agentpool.eth` is REGISTERED here: `getState(keccak("agentpool"))` returns status 2, owner `0x78F31B03De0E6473db80f2Da8c1a1cf5DB44A42a`, expiry 1978259976 |
| ETHRegistrar | `0xa88553f454b77203b0d036a05c894d555eaaa2cc` | Docs-table literal; not used as the subname registry |
| RootRegistry | `0x8115186e8f2e0b0281e86ab91f0f48ba90364354` | Docs-table literal; reference only, not in the scored path |
| Parent subname registry (own, hierarchical) | `0x365d676b7B95cf9c9E76531C8ab5bCEaD0e1dc34` | LIVE as-built. EIP-1967 proxy; implementation slot = `0x624a25d67B59D587752EbEc8DdeD8827dAe52050` = official UserRegistry implementation. All 4 subnames are status 2 REGISTERED here. NOT the docs-table ETHRegistry literal |
| UserRegistry impl (slot value above) | `0x624a25d67B59D587752EbEc8DdeD8827dAe52050` | Docs-table literal; USED as the implementation behind the parent subname registry proxy |
| Shared Permissioned Resolver (all 4 subnames + parent) | `0x2f60a75E4Dcd037110a8feaAB4b15f57B2BB9973` | LIVE as-built. EIP-1967 proxy; implementation slot = `0x9EAe5C2730a7dD16BDD1DeE6421a1B91e3B0365e` = official PermissionedResolverImpl. Single shared instance, not per-subname (see §5) |
| PermissionedResolver impl (slot value above) | `0x9EAe5C2730a7dD16BDD1DeE6421a1B91e3B0365e` | Docs-table literal; USED as the implementation behind the shared resolver proxy |
| VerifiableFactory | No default exported on purpose | Rotated already; re-fetch from `sepolia/*.json`. Factory address and generation that deployed `0x365d…e1dc34` still unverified (TODO) |
| MockUSDC (mintable, 6-dec) | No default exported on purpose | Rotated already; re-fetch before use |
| Parent `agentpool.eth` token/owner | Parent resolves on Sepolia (resolver set, no Arc record as expected) | Owner `0x78F31B03De0E6473db80f2Da8c1a1cf5DB44A42a`, status 2, expiry 1978259976, verified 2026-09-11 in ETHRegistry `0xbdc85d…0E2` |
| Per-subname resolver instances | NOT USED; shared resolver observed | §5 records the as-built (shared) vs as-specified (per-subname) gap |

Cross-chain constants: Arc chain `5042002`, `ARC_COIN_TYPE = 2152525650`
(`0x80000000 | 5042002`, ENSIP-9/11; asserted vs `toCoinType(5042002)` in
`sdk/test/ens.test.ts`).

## 3. Names: parent + 4 subnames

Wallets are the demo seeds (`demo/agents.seeds.json`; deterministic, no
on-chain writes by the file itself). `agentId` is `null` in seeds and is
filled at runtime via `registerAgent`. Live resolution is re-verified below.

| Name | Arc wallet | Registry state | Expiry (unix) | Resolver | ERC-8004 agentId |
|---|---|---|---|---|---|
| `agentpool.eth` (parent) | None (operator-owned) | Status 2 REGISTERED in ETHRegistry `0xbdc85d…0E2`; owner `0x78F31B03De0E6473db80f2Da8c1a1cf5DB44A42a` | 1978259976 | `0x2f60a75E4Dcd037110a8feaAB4b15f57B2BB9973` | None |
| `agent1.agentpool.eth` | `0x0e14d61f2bf9e1a494677257b8855e7ed091d983` | Status 2 REGISTERED in `0x365d…e1dc34` | 1820412108 | `0x2f60a75E4Dcd037110a8feaAB4b15f57B2BB9973` | Runtime (unverified) |
| `agent2.agentpool.eth` | `0x253a4751cc35555253666bf90b88ad79b336b079` | Status 2 REGISTERED in `0x365d…e1dc34` | 1820412108 | `0x2f60a75E4Dcd037110a8feaAB4b15f57B2BB9973` | Runtime (unverified) |
| `agent3.agentpool.eth` | `0x336e65d480ceff959ea3245f0ade6dac96af0ee8` | Status 2 REGISTERED in `0x365d…e1dc34` | 1820412108 | `0x2f60a75E4Dcd037110a8feaAB4b15f57B2BB9973` | Runtime (unverified) |
| `agent4.agentpool.eth` | `0x96ae62a9559dc69f61e07e288ee616e9a6c1bc5f` | Status 2 REGISTERED in `0x365d…e1dc34` | 1820412108 | `0x2f60a75E4Dcd037110a8feaAB4b15f57B2BB9973` | Runtime (unverified) |

Held out (never a subname, never commits): resale buyer
`0x2e07588b8180c8235c2a1be7ffa2639545630dd1`.

> **Re-pointed 2026-09-11.** The Arc records were moved from the original
> (key-not-held) seed wallets to fresh self-custody wallets whose private keys
> live at `~/.coalition/seed-keys.json` (mode 600). Four
> `setAddr(node, 2152525650, …)` writes, all status success and re-resolved to
> the values above:
> agent1 `0x4b0dc5bc72c86bf58b25154a5eb65d953851d654ead640e7f59fd8b5ceb4c9ab`,
> agent2 `0x8c0d7ae7b5c13437ca61a5232ffed205aa65daecb45cb51094b99dd0dc8bafd8`,
> agent3 `0xdda95228339c766d76de157e37e340ccfc8592edadc11e5ab6c79ae9906ae19e`,
> agent4 `0x5e9543434a2dc7de5286c089bbdd9f68a8819da68157e749fef9e0e9f496efcc`.

### Live verification (2026-09-11, Sepolia `https://ethereum-sepolia-rpc.publicnode.com`)

Method: `cast call addr(bytes32,uint256)` with coinType 2152525650 against
resolver `0x2f60…9973` per `namehash(name)`, independent of the repo's
earlier receipts. All four resolved to the seed wallets above. Parent
`getState` read against ETHRegistry `0xbdc85d…0E2` returned status 2 with
the owner and expiry listed in §2.

Prior pass (2026-09-10): `getEnsResolver` + `getEnsAddress({ coinType:
2152525650n })` per name (same path as `resolveArcWallet` /
`resolveEnsToAgents`; no fallback) returned 4/4 MATCH with resolver
`0x2f60…9973` on every name; parent had the same resolver and `null` Arc
record as expected.

Tx evidence (already in repo, cited not re-verified here; full trail in
`DEBUG-1.md` §§8-11):

- `setResolver` txs: agent1 `0xca2bf196362d903fd8c4d2cd544436417371bba9d4ea473278da4ae4f1bf2cda`; agent2 `0x8d01fb7b1a23c0cd0212fd54703c26240e8cd7769cf03f6419b00def8b537823`; agent3 `0xc4ee29493f6091067dfb75b2c1ebe9e8335f720e5d8cc5169570b48f9d97e090`; agent4 `0x50334fa84a3c661ae700f44046d5a31468471d8429e26a2743481987ad0a7fb5`.
- `setAddr` (coinType 2152525650) txs: agent1 `0x42f6a8b148b3e1cd63f521be37ee5d01face87fb16cd73714865261d8f7829ff`; agent2 `0x8494eb51a7dcee06cd8efeba064fdda2b5fa62e0eeee9ba44e24c2dbba1e4a2b`; agent3 `0x86347d755279d28542314da9a8fb5793648ce9438f4fd9422a37b86715159f20`; agent4 `0x39fab94d4227679e966055fd4760343b665286209f04eb3c0872e9a5edc12be8`.

## 4. EAC roles (specified and available; on-chain grant state not exercised live)

| Grant | Call | Intended value |
|---|---|---|
| Registrar on parent registry | `grantRootRoles` | `ROLE_REGISTRAR \| ROLE_RENEW` |
| Per-subname registration | `register(label, owner, registry, resolver, roleBitmap, expiry)` | `roleBitmap = SET_SUBREGISTRY(+ADMIN) \| SET_RESOLVER(+ADMIN) \| CAN_TRANSFER_ADMIN` |
| Per-agent record write | `authorizeAgentRecord` to `authorizeAddrRoles(dnsName, coinType 2152525650, agentWallet, true)` | Each agent wallet writes only its own Arc record; revoke with `allowed: false` |
| Optional single-key text | `authorizeTextRoles` (exposed in ABI, not in scored path) | Only if the demo needs one text key per agent |

Availability fact (verified 2026-09-11 from deployed bytecode of
implementation `0x9eae5c…365e`): the bytecode contains selectors for
`authorizeAddrRoles(bytes,uint256,address,bool)` (`0x587eefd1`),
`authorizeTextRoles(bytes,string,address,bool)` (`0xf2d1eb25`),
`setAddr(bytes32,uint256,bytes)` (`0x8b95dd71`), and
`supportsInterface(bytes4)` (`0x01ffc9a7`). The resolver is therefore
EAC-capable. This is not proof any grant was exercised.

App path (specified, not exercised live): `POST /api/ens/delegate`
implements grant to write to revoke to fail. Live grant and revoke
transactions have not been run, so do not claim EAC enforcement.

Resolver addresses are looked up fresh per write (`resolveEnsResolver`,
never cached); label caches key by `labelhash`, never by mutable token id.

## 5. Resolver strategy

- **Own subname registry (used).** The as-built parent subname registry is
  `0x365d…e1dc34`, an EIP-1967 proxy with the official UserRegistry
  implementation in its slot. Intended setup path stays: `UserRegistry`
  proxy via `VerifiableFactory.deployProxy` with salt
  `keccak256("UserRegistry", namehash(parent), version)`
  (`buildUserRegistrySalt({ parentName, version })`), `initialize` with root
  roles, `setSubregistry` on the parent, `grantRootRoles` to the registrar.
- **Wildcard resolution (reserve, not used).** `IExtendedResolver.resolve`
  stays in reserve. Longest-suffix inheritance means registration alone can
  be enough to resolve, so no wildcard gateway is needed for 4 flat subnames.
- **Permissioned Resolver shared as-built (not per-subname).** Spec sets
  each subname's own resolver instance at `register`; all reads go
  through the Universal Resolver, never direct (`resolveArcWallet`,
  `resolveEnsResolver`). **As-built 2026-09-11: all 4 subnames + parent point
  at one shared resolver `0x2f60…9973`.** Either split to per-subname
  instances before submitting (matches the bounty "fully own their data"
  line) or justify shared + EAC scoping explicitly. Do not claim
  per-subname today.
- **Record aliasing via `setAlias` (reserve, not used).** No shared records
  needed. Each agent owns exactly one Arc multicoin record.
- **Namespace aliasing, two names to same subregistry (not used).** Only if
  the demo needs a second parent; explicitly cut (one pool, one parent).
- **Expiry / revocable / transferability (specified).** Short `expiry` with
  `ROLE_RENEW` kept = expiring names; `unregister` = revocable; drop
  `CAN_TRANSFER_ADMIN` from the bitmap for non-transferable demo names.
  Observed subname expiry is 1820412108 (§3). Final bitmap values for new
  registrations are recorded at TODO-4. Lock-forever (revoke
  role *and* admin from self) is irreversible. Do not use it in the demo.

## 6. SDK methods and params used

`sdk/src/ens/client.ts` (reads via viem Universal Resolver; writes via
`writeContract`; ABIs in `sdk/src/ens/abi.ts`):

- `resolveArcWallet({ publicClient /* Sepolia */, name, coinType? (= 2152525650), universalResolver? })` to `Address | null`
- `resolveEnsResolver({ publicClient, name, universalResolver? })` to `Address` (fresh lookup, throws `EnsError` on `zeroAddress`)
- `resolveEnsToAgents({ sepoliaClient, arcClient, name, coinType?, identityRegistry? })` to `{ arcWallet, agentIds } | null`. This is the scored path (subname to Arc wallet to `findAgentsByOwner` on `Registered` logs, zero gas, then per-id `resolveAgent` / `getReputationSummary`)
- `registerSubname({ walletClient, account, registrar, label, parentName? (= "agentpool.eth"), owner, registry, resolver, roleBitmap, expiry })` to `{ hash, name }`
- `setArcAddressRecord({ walletClient, publicClient?, account, name, arcWallet, resolver?, coinType? })` to `{ hash, resolver }` (`setAddr(namehash, coinType, bytes)`)
- `authorizeAgentRecord({ walletClient, account, name, resolver, agentWallet, allowed, coinType? })` to `{ hash }` (`authorizeAddrRoles(DNS-encoded name, …)`)
- `buildUserRegistrySalt({ parentName?, version })` to `Hex` (factory salt; encoding assumption, verify vs `VerifiableFactory` before Day 8)
- `createEnsLabelCache<T>()`: labelhash-keyed cache; never stores resolvers

Seed resolution lives in `sdk/src/demo` (`resolveSeedAgent` /
`resolveSeedAgents`). Its mandatory behavior is described in §7b, not here.

## 7. ENSv2 prompt feature map

| Prompt feature (quoted) | Coalition usage (mandatory where noted) |
|---|---|
| Hierarchical registry | USED: `agentpool.eth` parent to `agent1..4` subnames; parent registered in official ETHRegistry `0xbdc85d…0E2`, subnames in own registry `0x365d…e1dc34` |
| Wildcard resolution | RESERVE: not needed; longest-suffix inheritance covers flat subnames |
| Own subname registry | USED: `0x365d…e1dc34` proxy with official UserRegistry implementation (§2); setup via factory salt + `setSubregistry` + `grantRootRoles` |
| EAC delegation | AVAILABLE and SPECIFIED: `authorizeAddrRoles` / `authorizeTextRoles` selectors present in resolver implementation bytecode; registrar gets `ROLE_REGISTRAR \| ROLE_RENEW`; app `POST /api/ens/delegate` implements grant to write to revoke to fail; no live grant exercised |
| Permissioned Resolver ownership | SHARED AS-BUILT: single `0x2f60…9973` serves all 4 subnames + parent; per-subname split specified, not done |
| Record aliasing | RESERVE: `setAlias` record-sharing unused; 1 agent = 1 Arc record |
| Namespace aliasing | NOT USED: second parent only if demo needs it; cut per one-pool scope |
| Expiring / revocable / non-transferable vs transferable / forever names | AS-BUILT + SPECIFIED: observed subname expiry 1820412108; short expiry + `ROLE_RENEW` (expiring), `unregister` (revocable), bitmap without `CAN_TRANSFER_ADMIN` (non-transferable); values for new names recorded at TODO-4 |
| Agents-as-namespaces bonus (own identity + permissions) | USED: subname to Arc wallet to ERC-8004 `resolveAgent` + `getReputationSummary` is our own composition; each namespace carries its own EAC-scoped write permission (available, §4) |
| Funder binding | USED: funding requires `funderWallet == ENS wallet` per live attestation (§7b); no seed-wallet fallback |

## 7b. ENS enforcement (non-optional)

ENS is load-bearing. There is no seed-wallet fallback anywhere in the
current path.

- SDK `resolveSeedAgent` / `resolveSeedAgents` (`sdk/src/demo`): a seed
  with no Arc record, or whose resolved wallet differs from `seed.wallet`,
  returns `status: "unresolved"` with a reason. The `fallbackWallet` field
  was removed. `DemoAgentResolution` no longer carries any wallet on failure.
- `GET /api/agents` (app): surfaces `status: "unresolved"` with a reason.
  The old "showing seed fallbacks" degrade is gone. Total resolution
  failure yields unresolved entries with no wallets.
- `POST /api/agents/run` (app): resolves every seed live first. An
  unresolved seed cannot join (skip reason `"skip: ENS unresolved …"` or
  `"skip: ENS resolution unavailable …"`).
- `POST /api/agents/fund` (app): adds an ENS attestation pre-pass. For each
  Circle funder at index `i` it resolves `SEED_META[i].ensName` to its live
  Arc wallet and requires `funderWallet === ensWallet`
  (case-insensitive). When attestation fails (no Arc record, ENS lookup
  failed, Circle address unavailable, or mismatch) the step is `failed`
  and no approve, commit, or allocate happens. Each `FundStep` now carries
  `ensName`, `ensWallet`, `funderWallet`, `ensAttested`. The old
  `seed.wallet` fallback in `/allocate` was removed; allocation uses the
  attested ENS wallet.
- UI: the agents table shows an `"unresolved"` pill with the reason. Each
  fund step shows an `"ENS attested"` / `"ENS unattested"` badge with a
  title of the ENS to wallet mapping.

Operator alignment (chosen: self-custody) — **DONE 2026-09-11**. The Arc
records previously pointed at four seed wallets (`0x0427…`, `0xd1a3…`,
`0x0728…`, `0x67bc…`) whose private keys were not held and not recoverable
(Circle never exposes keys; no local key material existed). They were
re-pointed to four fresh self-custody wallets whose private keys live at
`~/.coalition/seed-keys.json` (mode 600):

| agent | ENS name | wallet (self-custody, live) |
|---|---|---|
| agent-1 | `agent1.agentpool.eth` | `0x0e14d61f2bf9e1a494677257b8855e7ed091d983` |
| agent-2 | `agent2.agentpool.eth` | `0x253a4751cc35555253666bf90b88ad79b336b079` |
| agent-3 | `agent3.agentpool.eth` | `0x336e65d480ceff959ea3245f0ade6dac96af0ee8` |
| agent-4 | `agent4.agentpool.eth` | `0x96ae62a9559dc69f61e07e288ee616e9a6c1bc5f` |

Re-point command used (owner/resolver-admin `0x78F3…`; keep for future
rotations — the script prompts for the key, or reads `SEPOLIA_PRIVATE_KEY`):

```sh
cd app
node scripts/repoint-ens.mjs --map agent1=0x0e14d61f2bf9e1a494677257b8855e7ed091d983,agent2=0x253a4751cc35555253666bf90b88ad79b336b079,agent3=0x336e65d480ceff959ea3245f0ade6dac96af0ee8,agent4=0x96ae62a9559dc69f61e07e288ee616e9a6c1bc5f
```

The SDK/app seed `wallet` constants expect these addresses, and the on-chain
records now match. `POST /api/agents/fund` signs with these keys (viem
`approve` + `commit`, keys read from `~/.coalition/seed-keys.json`) and keeps
the ENS attestation, so a key whose address the name does not resolve to fails
closed. Remaining operational step: fund the four wallets with Arc testnet USDC.

## 8. Video timestamps + live demo URL

Spoken 2-4 min, 720p+. ENS discovery beat about 60s inside the resale + ENS
segment (Day-10 plan §Day 10). All values TODO until the cut exists. No
video is claimed here.

| Beat | Timestamp | Content |
|---|---|---|
| ENS discovery | TODO-5 `MM:SS` | Live `agent1.agentpool.eth` to Arc wallet to ERC-8004 identity + reputation |
| Track-fit card (ENS) | TODO-5 `MM:SS` | Subname registry + EAC summary |
| Live demo URL | TODO-6 | Deployed app URL (Next.js consumer of `coalition-sdk`) |
| Video URL | TODO-5 | Hosted recording URL |

## 9. Honest limitations (beta on record)

- ENSv2 is **beta on Sepolia**: interfaces not final, addresses rotate.
  Re-fetch the Deployments table at demo time.
- `VerifiableFactory` (and `MockUSDC`) already rotated once between the docs
  pin and repo HEAD. No default exported; pass explicitly per call.
- Write ABIs in `sdk/src/ens/abi.ts` (`setAddr`, `authorizeAddrRoles`,
  `authorizeTextRoles`, `register`) must be verified against
  `ensdomains/contracts-v2` HEAD before the demo; selectors may have changed.
- Clean Beta registry (Alpha names wiped); fees are MockUSDC/testnet-USDC
  only with a 28-day grace window. No mainnet names involved.
- The ENS to ERC-8004 hop (`resolveEnsToAgents`) is our own composition. No
  official doc blesses subname to L2 wallet to ERC-8004. The agent loop
  now uses it as the mandatory first step (§7b), not an optional scored step.
- `buildUserRegistrySalt` encoding is an assumption until verified against
  the live `VerifiableFactory`.
- Sepolia receipt RPC for older `DEBUG-1.md` tx hashes was flaky in past
  passes. The 8 hashes in §3 are cited from the repo trail, not re-verified
  in the 2026-09-11 `cast` pass (which covered live `addr` / `getState`
  reads). Re-check with `cast receipt <hash> --rpc-url
  https://ethereum-sepolia-rpc.publicnode.com` before submitting.
- As-built uses a shared resolver, not per-subname instances. Parent
  subname operations ran against registry `0x365d…e1dc34`, not the
  docs-table `ETHRegistry` generation. Factory address + generation that
  owns this deployment are still unverified; record them so judges can
  reproduce it.
- ENS records align on-chain with the self-custody wallets, and
  `POST /api/agents/fund` signs with those keys (§3, §7b); a key that does not
  derive its subname's wallet fails closed. The four wallets must be funded
  (Arc testnet USDC) before a round. Per-subname resolvers are not used.

## 10. TODO fill-in list (owner + command)

- TODO-1 (owner: submitter): DONE. Repo is public
  (https://github.com/Jashk120/Coalition, `private=false`); ENS commits in
  `origin/main`. Record: `gh repo view --json visibility,url`.
- TODO-2 (owner: Day-8 operator): re-fetch Deployments table + factory JSONs;
  record `VerifiableFactory` + `MockUSDC` + re-check date in §2.
  `curl -s https://docs.ens.domains/learn/deployments/ && ls contracts-v2/contracts/deployments/sepolia/`
- TODO-3 (owner: Day-8 operator): parent registration DONE live (parent
  resolves; owner/token state in §2-§3 verified 2026-09-11); still open:
  record generation/factory that owns registry `0x365d…e1dc34`.
- TODO-4 (owner: Day-8 operator): resolution DONE live (4/4 MATCH §3); Arc
  records re-pointed to the self-custody wallets on 2026-09-11 (4 `setAddr`
  txs in §3). Still open: `cast receipt` re-check of the older `DEBUG-1.md`
  hashes, live EAC grant-state read (grant has not been exercised), runtime
  `agentId` registration + `resolveEnsToAgents` cross-check, per-subname vs
  shared resolver decision, and switching the fund signer to the local keys.
- TODO-5 (owner: Day-10 editor): record video, fill §8 timestamps + video URL.
  No video exists yet.
- TODO-6 (owner: Day-10 deployer): deploy demo app, fill live demo URL in §8.

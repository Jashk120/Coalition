# ENSv2 — Stack and Heavy Usage

Verified 2026-09-07 against docs.ens.domains/ensv2, `ensdomains/contracts-v2`,
npm. **Everything below is beta on Sepolia: interfaces not final, addresses
rotate — re-fetch the Deployments table before Day 8 and at demo time.**

## 1. Stack + versions

| Piece | Pin | Role |
|---|---|---|
| `viem` | `>= 2.35.0` | Reads (`getEnsAddress/Text/Resolver`), all writes via `writeContract` + `multicall` |
| `@ensdomains/ensjs` | `4.2.3` stable (reads) | `getAddressRecord`, `getRecords`; only lib with write helpers (`setRecords`, `setAddressRecord`) |
| `@ensdomains/ensjs` | `5.0.0-alpha` (preview) | v2 writes: `/public/v2`, `/wallet/v2`, `/utils/v2`, `@ensdomains/ensjs-abi/v2/*` |
| `ensdomains/contracts-v2` | Sepolia beta | Registry, resolver, factory, registrar sources of truth |

No namehash change: `normalize`/`namehash`/`packetToBytes` from `viem/ens` work
unchanged. What changed is *where* you call (resolver looked up fresh per
write, never cached) and *who may call* (EAC roles). Token IDs are **mutable**
— key caches by **labelhash**, resolve `findTokenId` at tx time.

Key docs: app-dev tutorial, contract-dev tutorial (full subname-registrar
build), registry-hierarchy, enhanced-access-control, permissioned-registry,
permissioned-resolver, universal-resolver-v2, verifiable-factory,
eth-registrar (`docs.ens.domains/ensv2/*`).

## 2. Sepolia addresses — re-fetch, do not hardcode

Source of truth: `docs.ens.domains/learn/deployments/#sepolia-ensv2-beta` +
`contracts/deployments/sepolia/*.json`. Rotation already observed between docs
pin and repo HEAD. Stable proxy (use via library): UniversalResolver
`0xeEeEEEeE14D718C2B47D9923Deab1335E144EeEe`.

| Contract | Beta-table value (re-check) |
|---|---|
| `ETHRegistry` (`.eth`) | `0xbdc85DD5b15D7ecb354cd7cb6f2c50b4f2c4F0E2` |
| `ETHRegistrar` | `0xa88553f454b77203b0d036a05c894d555eaaa2cc` |
| `RootRegistry` | `0x8115186e8f2e0b0281e86ab91f0f48ba90364354` |
| `PermissionedResolverImpl` | `0x9EAe5C2730a7dD16BDD1DeE6421a1B91e3B0365e` |
| `UserRegistryImpl` | `0x624a25d67B59D587752EbEc8DdeD8827dAe52050` |
| `VerifiableFactory` | rotated already — re-fetch |
| `MockUSDC` (mintable, 6 dec) | rotated already — re-fetch |

Project as-built (verified 2026-09-11, full receipt in `ENS.md` §§2–3):
parent `agentpool.eth` lives in ETHRegistry
`0xbdc85DD5b15D7ecb354cd7cb6f2c50b4f2c4F0E2`, owner
`0x78F31B03De0E6473db80f2Da8c1a1cf5DB44A42a; own subname registry
`0x365d676b7B95cf9c9E76531C8ab5bCEaD0e1dc34` (EIP-1967 proxy, impl
`0x624a25d67B59D587752EbEc8DdeD8827dAe52050`); shared Permissioned Resolver
`0x2f60a75E4Dcd037110a8feaAB4b15f57B2BB9973` (proxy, impl
`0x9EAe5C2730a7dD16BDD1DeE6421a1B91e3B0365e`).

Beta facts: clean Beta registry (Alpha names wiped), `MockUSDC.mint` open +
`approve`-before-`register`, 28-day grace, MockUSDC/testnet-USDC fees only,
experimental-software notice.

## 3. Heavy usage per piece (our discovery flow)

**Reads — always via Universal Resolver, never direct.** `getEnsAddress({ name,
coinType })`, `getEnsResolver({ name })` on a Sepolia viem client (resolution
starts on L1 even though wallets live on Arc). Subname with no resolver
inherits the parent's via longest-suffix match — registration alone can be
enough to resolve.

**Registry — own subname registry for `agentpool.eth`.** Deploy `UserRegistry`
proxy via factory (`deployProxy` + salt `keccak256("UserRegistry",
namehash(parent), version)` → `ProxyDeployed` gives address), `initialize`
with root roles, `setSubregistry` on the parent, `grantRootRoles` to the
registrar. Per-agent: `register(label, owner, registry, resolver, roleBitmap,
expiry)` — bitmap `SET_SUBREGISTRY(+ADMIN) | SET_RESOLVER(+ADMIN) |
CAN_TRANSFER_ADMIN`; drop the last for non-transferable, short `expiry` +
kept `ROLE_RENEW` for expiring, `unregister` for revocable.

**Arc address records — `coinType = 2152525650`.** ENSIP-9/11 multicoin:
`setAddr(node, coinType, bytes)` with `coinType = 0x80000000 | 5042002`
(`toCoinType(5042002)`). Same `0x` bytes as EVM — the coinType disambiguates.
Reads: `getEnsAddress({ name: "agent1.agentpool.eth", coinType: 2152525650 })`.

**EAC — per-agent least privilege.** `authorizeAddrRoles(dnsName, coinType,
agentWallet, true)` (+ optional single-key `authorizeTextRoles`) so each agent
writes only its own Arc record; revoke with `false`. Registry side:
`ROLE_REGISTRAR | ROLE_RENEW` for the registrar. Lock forever by revoking role
*and* admin from self (irreversible).

**Fallbacks, not primaries.** Resolver `setAlias` record-sharing and wildcard
`IExtendedResolver.resolve` stay in reserve; namespace aliasing (two names →
same subregistry) only if the demo needs a second parent.

## 4. Resolution flow (the scored path)

`agent1.agentpool.eth` → Sepolia UR → Arc wallet (`coinType 2152525650`) →
`findAgentsByOwner` (indexed `owner` on `Registered` logs — zero gas, no
Enumerable in ERC-8004 to lean on) → ERC-8004 `resolveAgent` +
`getReputationSummary`. The ENS↔ERC-8004 hop is our own composition (no
official doc blesses it) — valid, and exactly the
"agents as namespaces with own identity and permissions" bonus the bounty names.

Pool member enumeration follows the same split: the contract records members
at commit time (one SSTORE inside an already-paid commit — cheapest possible
on-chain enumeration, spec'd for `contracts/`), reads stay free, and the
subgraph's `Commitment` entities serve discovery queries. No Enumerable-style
add-on anywhere: reads are free, writes pay once.

As-built verified state (2026-09-11 via `cast` against
`https://ethereum-sepolia-rpc.publicnode.com`; full receipt in `ENS.md`
§§2–3): `agentpool.eth` is registered in the official ETHRegistry
`0xbdc85DD5b15D7ecb354cd7cb6f2c50b4f2c4F0E2` (status 2); subname operations ran against the project's own
registry `0x365d676b7B95cf9c9E76531C8ab5bCEaD0e1dc34` (EIP-1967 proxy with official UserRegistry
implementation `0x624a25d67B59D587752EbEc8DdeD8827dAe52050` in its slot); all 4 subnames plus the parent
use the shared PermissionedResolver `0x2f60a75E4Dcd037110a8feaAB4b15f57B2BB9973` (proxy with official
implementation `0x9EAe5C2730a7dD16BDD1DeE6421a1B91e3B0365e` in its slot); all 4 subnames are status 2
REGISTERED with expiry 1820412108.

`agentN.agentpool.eth` Arc records (`coinType 2152525650`) resolve to the
Circle Developer-Controlled Wallets (verified 2026-09-11). `POST
/api/agents/fund` reads `CIRCLE_WALLET_IDS`; index `i` maps to
`SEED_META[i].ensName` (agent`i+1`):

| # | `ensName` | Circle funder wallet | Re-point tx (2026-09-11) |
|---|---|---|---|
| agent1 | `agent1.agentpool.eth` | `0x4f188f3da697984f0fc02e61fda4a34b00abf39a` | `0x7e0674fbfe58d404f9aa5c6571ed22bfe0d5b1854739f16868f128720987cffd` |
| agent2 | `agent2.agentpool.eth` | `0x8c4d4ca5fe56c4aef3e7b424879f25693e9d5a2b` | `0x224c9605a905aba44fdbe52025c2c751cb59a971739519c944d9b63f90033f0d` |
| agent3 | `agent3.agentpool.eth` | `0xde086aa43915670c74444b3e5a464d992e1f7770` | `0x2bf02ca29fd8861cb908128d32363c2c3554c0bc97a93db325b0338c57a7c661` |
| agent4 | `agent4.agentpool.eth` | `0x0a6415e892972214bceb0271746cb45932f7eaf1` | `0xb137974200dfcbd9e1406908d66c306b4ccfa6d45bdd45434d5a515d9f817203` |

`CIRCLE_PROVIDER_WALLET_ID` is funder 4 (`0x0a6415e892972214bceb0271746cb45932f7eaf1`),
so agent4 is also the pool provider. Demo pool round 11 is settled: open a
fresh round before funding.

ENS is mandatory (funder == ENS): `POST /api/agents/fund` requires
`funderWallet == ENS wallet` per live attestation, and a funder whose Circle
address != the live record fails the step with no transaction (no approve,
no commit, no allocate). `FundStep` carries `wallet`, `ensName`,
`ensWallet`, `funderWallet`, `ensAttested`. There is no seed-wallet fallback
and no self-custody path: `app/lib/seed-keys.ts`,
`~/.coalition/seed-keys.json`, `SEED_KEYS_FILE`, `SEED_PRIVATE_KEYS`, and
`fund-pool.mjs` for agent funding are removed; funding signs via Circle
(`circle wallet execute` / DCW). `POST /api/agents/run` is a dry-run that
resolves every seed live. The App Kit treasury rail (`POST
/api/agents/treasury`, `kit.send` from `CIRCLE_TREASURY_WALLET_ID`) is
currently UNSET (503 until set) and must not be the provider.

## 5. `sdk/ens/` shape (when built)

Thin wrapper over viem + direct calls (reads stable, writes beta): wrap
`getEnsAddress({coinType})`, `getEnsResolver`, `setAddr`,
`authorizeAddrRoles`, factory `deployProxy` + `register`; labelhash-keyed
caching, fresh resolver lookup per write, Sepolia client for ENS even though
wallets are Arc. Mocked-transport tests like the other modules. No `ethers`,
no hardcoded resolver addresses.

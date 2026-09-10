# ENSv2 Sepolia Beta — Live Verification + Registration Plan (agentpool.eth + 4 agents)

Verified 2026-09-08 (UTC). **Report only — no on-chain writes were made, no private keys touched.**
SDK code under `sdk/src/ens/*` was **not** edited (spec/report only, per task).

> ⚠️ **Beta rotation warning (actionable):** the docs Deployments table (pin
> `97a57293`) matches the SDK literals in `sdk/src/ens/addresses.ts`, but
> `contracts-v2` **`main` HEAD already shows a NEWER deployment generation**
> (all impl/registry/registrar addresses differ, both generations have code on
> Sepolia). **Re-fetch the Deployments table + `sepolia/*.json` at demo time
> and use whichever generation the Universal Resolver / app.ens.dev points at
> that day. Every address below is an explicit per-call input — never rely on
> a checked-in literal.**

## 1. Fresh deployment addresses (verified 2026-09-08)

Sources: `docs.ens.domains/learn/deployments/#sepolia-ensv2-beta` (pin
`97a57293f3b4279d94b571e678edb53ce62638f4`) + raw
`contracts/deployments/sepolia/*.json` on `main` HEAD. Code-existence
confirmed via `cast code` on Sepolia (`https://ethereum-sepolia-rpc.publicnode.com`).

| Contract | Docs table (= SDK literal) | `main` HEAD (2026-09-08) | On-chain code? | Use |
|---|---|---|---|---|
| UniversalResolver proxy | `0xeEeEEEeE14D718C2B47D9923Deab1335E144EeEe` | **same** ✅ stable | yes (proxy runtime) | Prefer viem `sepolia` preset over literal |
| ETHRegistry (`.eth`) | `0xbdc85dd5b15d7ecb354cd7cb6f2c50b4f2c4f0e2` | `0x67b728a792e789a8978b30cf1b3b641f19354b43` ⚠️ | **both** have code | **re-check at demo** |
| ETHRegistrar | `0xa88553f454b77203b0d036a05c894d555eaaa2cc` | `0xa4449a0dd2b83007553d9b1d28b583a46a805a30` ⚠️ | **both** have code | **re-check at demo** |
| RootRegistry | `0x8115186e8f2e0b0281e86ab91f0f48ba90364354` | `0x11b5bfbe9078d826b1edbdd1cfc12f5828d9f50c` ⚠️ | **both** have code | **re-check at demo** |
| PermissionedResolverImpl | `0x9eae5c2730a7dd16bdd1dee6421a1b91e3b0365e` | `0x7e4b2d59938930168024201752ee5503df402303` ⚠️ | **both** have code | **re-check at demo** |
| UserRegistryImpl | `0x624a25d67b59d587752ebec8dded8827dae52050` | `0x840fa461059862ea466a711e8c98c8de732061c0` ⚠️ | **both** have code | **re-check at demo** |
| VerifiableFactory | `0x10dc6333cdfe1fcef624c6e0a8221b91804cd7ef` (pin; already rotated once before) | `0x118bc31a50d559f7015a8da26d54b3b030cdb70f` ⚠️ | **both** have code | **NO default — explicit per-call input** |
| MockUSDC (6-dec, `mint` open) | `0x768f42455a2d082e23ceef7d51e5787c82d67a39` (pin) | `0xd3322b29a7bdee707d1684676f149bf41aa3422f` ⚠️ | **both** have code | **re-check at demo** |
| StandardRentPriceOracle | not in SDK | `0x09340d50a6489e7bfb2959acc4e32bcbc401e203` (HEAD) | not checked | fee quote at demo |
| ETHRenewerV1 | not in SDK | `0x1be516ae1b72765ae55bd5e9ca628c9058a1c622` (HEAD) | not checked | renewals |
| PublicResolverV2 | not in SDK | `0xd25f66dd4ff61486c2c5c1e6201a23576698d3df` (HEAD) | not checked | alt resolver option |
| UniversalResolverV2 (impl) | not in SDK | `0x4a1817d13e9cf196f471725176355c1234b63c70` | not checked | behind proxy |

Notes:
- `cast call … "available(string)(bool)" "agentpool"` **reverted on BOTH**
  registrar generations (v2 registrar has no v1-style `available(string)`);
  parent-name availability/ownership must be checked at demo time via the
  Explorer (`explorer.ens.dev`) or the v2 registrar ABI from the fresh
  `ETHRegistrar.json`. Marked **re-check-required** (not a failure of this
  report — read path, not write path).
- ABIs in `sdk/src/ens/abi.ts` (`setAddr`, `authorizeAddrRoles`,
  `register(string,address,address,address,uint256,uint64)`) match the shapes
  in the live `PermissionedRegistry`/`UserRegistry` JSONs fetched from HEAD
  (`register(label,owner,registry,resolver,roleBitmap,expiry) → uint256` ✅);
  still re-verify selectors against HEAD at demo time (beta caveat).

## 2. Parent-name strategy: `agentpool.eth` on Sepolia

- Single parent `agentpool.eth` (`DEFAULT_PARENT_NAME` in SDK), subnames
  `agent1.agentpool.eth` … `agent4.agentpool.eth`.
- Human registers `agentpool.eth` first via the **ETHRegistrar of the live
  generation** (fee in **MockUSDC of the same generation** — `mint` open,
  `approve` registrar before `register`; 28-day grace; MockUSDC/testnet-USDC
  fees only).
- Then deploys a **`UserRegistry` proxy for the parent via the live
  `VerifiableFactory.deployProxy(impl, salt, initData)`** (see §5 salt),
  `initialize`s it, `setSubregistry` on the parent, `grantRootRoles` to the
  registrar — per `plans/ensv2.md` §3.
- Per-agent subnames are created with `registerSubname` on the **parent
  registrar** (one parent, one deployment — `registrar` always explicit).

Precomputed (pure viem, no RPC):
- `namehash("agentpool.eth") = 0xab547a6ba92dbfc559647b54dd7f860881715cc9596e8454eba36f6c243b15fc`
- `namehash(agent1.agentpool.eth) = 0xb198dea98defd524689c3498175a7c9284744578ebffda98f8374db00c6a10c9`
- `namehash(agent2.agentpool.eth) = 0xdcb91763dd8c9eaaab033df423dc4f29236d6f6439ee5a223e79e71fa092e7dd`
- `namehash(agent3.agentpool.eth) = 0x3c1676910c3cd794063f48a94aabe4bf142acbcc22c69fdc9a2dcbf4222aefdf`
- `namehash(agent4.agentpool.eth) = 0xb996c13aae1be0b6ac58903a44311058d181b3d2fa0ed46fd86c112b6d2dc508`

## 3. User-registry vs wildcard-off-parent trade-off (decision: user-registry)

| Option | How | Pros | Cons |
|---|---|---|---|
| **User-registry per parent (CHOSEN)** | `UserRegistry` proxy via factory; each subname its own `register()` entry with resolver + roles + expiry | Per-agent ownership, per-agent expiry/revocation (`unregister`), EAC roles scoped per subname, matches SDK (`registry` param per `registerSubname`) | One extra proxy deployment tx |
| Wildcard off parent | Single resolver on parent, `IExtendedResolver.resolve` answers `*.agentpool.eth` off-chain/wildcard | Zero per-agent registration txs | No per-agent token/expiry, coarse auth (anyone with parent write can change all), no clean revocation story, fights the scored "agents as namespaces with own permissions" arc |

Decision: **user-registry** — it is what `plans/ensv2.md` §3 and
`registerSubname({registry,…})` already assume, and only it gives per-agent
expiry + revocation + least-privilege EAC.

## 4. EAC role plan — each agent edits only its own records

Role constants (live `RegistryRolesLib.sol` @ `main` HEAD — nybble-packed bitmap):
- `ROLE_SET_SUBREGISTRY = 1<<20 = 0x100000`
- `ROLE_SET_RESOLVER = 1<<24 = 0x1000000`
- `ROLE_RENEW = 1<<16 = 0x10000`
- `*_ADMIN` = role `<< 128`; `ROLE_CAN_TRANSFER_ADMIN = (1<<28)<<128`

Registry-side `roleBitmap` for each `registerSubname` (demo default =
**non-transferable, renewable**):
- `0x110000000000000000000000000000001110000`
  (= `SET_SUBREGISTRY|SET_SUBREGISTRY_ADMIN|SET_RESOLVER|SET_RESOLVER_ADMIN|RENEW`;
  `CAN_TRANSFER_ADMIN` **dropped** so agent subnames can't be sold out from under the pool).
- Fully-transferable variant (only if demo explicitly needs it):
  `0x1110000000000000000000000000000001100000` (adds `CAN_TRANSFER_ADMIN`).
- Revocation: parent owner calls `unregister(tokenId)` or
  `revokeRoles(anyId, bitmap, account)`; expiry short + `ROLE_RENEW` kept for
  expiring demo names.

Resolver-side (EAC, per subname — **least privilege**):
- `authorizeAgentRecord({ name: "agentN.agentpool.eth", resolver, agentWallet, allowed: true })`
  → `authorizeAddrRoles(dnsName, ARC_COIN_TYPE, agentWallet, true)` where
  `dnsName = toHex(packetToBytes(name))`. Each agent wallet may write **only
  its own Arc record** (coin type scoped). Revoke with `allowed: false`.
- Optional single-key text record: `authorizeTextRoles` (in ABI, not used in plan).

## 5. Permissioned Resolver per subname + salt computation

- Each `registerSubname` sets the subname's resolver to a **Permissioned
  Resolver instance** (fresh proxy; impl = live-generation
  `PermissionedResolverImpl`). Resolver looked up **fresh per write**
  (`resolveEnsResolver`); never cached (`sdk/src/ens/client.ts`).
- `UserRegistry` proxy salt — `buildUserRegistrySalt({parentName, version})`:
  `keccak256(encodePacked(["string","bytes32","uint256"], ["UserRegistry", namehash(parent), version]))`.
  ⚠️ Encoding assumption flagged in SDK — verify against the live
  `VerifiableFactory.deployProxy` + `ProxyDeployed` event before Day-8.
  Precomputed for `agentpool.eth` (viem, no RPC):
  - `version=1n → 0xcee327e4388b49f118807ab3a6078e27c27773d5ba4c21dfe4eb475f7441f793`
  - `version=2n → 0x4e5aa906072e41fb653a9f570d502735ed7ccab02c1bd77a22445f4685d37d43`
  - NOTE: factory CREATE2 salt is `keccak256(abi.encode(msg.sender, salt))`,
    so the final proxy address also depends on the deployer — compute at signing time.

## 6. Record aliasing note

- `setAlias` record-sharing and wildcard `IExtendedResolver.resolve` stay
  **fallbacks, not primaries** (per `plans/ensv2.md` §3): aliasing two names
  → one subregistry is reserved only if the demo needs a second parent
  (e.g. `coalition.eth` → same registry). Default: 4 independent subnames,
  4 independent resolvers, 4 independent Arc records.
- A subname with **no resolver inherits the parent's** via longest-suffix
  match — registration alone can be enough to resolve; records still set
  explicitly per §7.

## 7. Exact call sequence (SDK function names + params)

`ARC_COIN_TYPE = 2152525650` (`0x80000000 | 5042002`; asserted vs
`toCoinType(5042002)` in `sdk/test/ens.test.ts` ✅, re-verified 2026-09-08).

Agent ↔ Arc-wallet mapping (EAC grantees — all verified EOAs, `cast code = 0x`,
20 native-USDC balance each on Arc testnet, pool `0xC6f9…B4fd` has code):

| Subname | Arc wallet (EAC grantee + record value) |
|---|---|
| `agent1.agentpool.eth` | `0x0427194a9c99599a8bbbcc292b1523be91e4101d` |
| `agent2.agentpool.eth` | `0xd1a3c06eb92dfd48fa1bf10ba2071da25e39cd47` |
| `agent3.agentpool.eth` | `0x072825b4ba2c8019ccceba10e59b29a40980be94` |
| `agent4.agentpool.eth` | `0x67bc424b83be66f7f5c4fc2324d4154744f1b310` |

Prerequisites (human, Day-8): parent `agentpool.eth` owned; `UserRegistry`
proxy deployed + wired; one Permissioned-Resolver instance per subname (or one
shared instance — per-subname preferred); all addresses below = **live
generation re-fetched at demo time**.

For EACH `agentN` (`label = "agentN"`, `owner` = parent-owner safe or the
agent's Sepolia key per demo script, `registry` = UserRegistry proxy,
`resolver` = Permissioned Resolver instance, `roleBitmap = 0x1100…1110000n`
(§4), `expiry` = demo value e.g. `1786156800n` ≈ +1y):

1. `registerSubname({ walletClient, account: parentOwner, registrar, label: "agentN", parentName: "agentpool.eth", owner, registry, resolver, roleBitmap, expiry })`
   → `register(label, owner, registry, resolver, roleBitmap, expiry)` on `registrar`; returns `{ hash, name }`.
2. `resolveEnsResolver({ publicClient: sepoliaClient, name: "agentN.agentpool.eth" })` — fresh lookup (or reuse the explicit `resolver` from step 1).
3. `authorizeAgentRecord({ walletClient, account: parentOwner, name: "agentN.agentpool.eth", resolver, agentWallet: <Arc wallet N>, allowed: true, coinType: 2152525650 })`
   → `authorizeAddrRoles(dnsName, 2152525650n, agentWallet, true)` on `resolver`.
4. `setArcAddressRecord({ walletClient, publicClient: sepoliaClient, account: parentOwner, name: "agentN.agentpool.eth", arcWallet: <Arc wallet N>, resolver, coinType: 2152525650 })`
   → `setAddr(namehash(name), 2152525650n, arcWalletBytes)` on `resolver`.
5. Verify (read-only): `resolveArcWallet({ publicClient: sepoliaClient, name: "agentN.agentpool.eth" })` === `<Arc wallet N>`; then
   `resolveEnsToAgents({ sepoliaClient, arcClient, name })` → `{ arcWallet, agentIds }`.

CLI equivalents (read-only shown; writes are for the human at demo):
```sh
# reads (safe now)
cast call <UR-proxy> "resolve(bytes,bytes)" <dnsName> <data> --rpc-url $SEPOLIA_RPC
# per-call address inputs come from: curl .../contracts-v2/.../sepolia/<Name>.json | jq .address
```

## 8. Fees — Sepolia ETH + MockUSDC

- **Sepolia ETH (gas):** every write above (parent registration, proxy deploy,
  4× register + 4× authorize + 4× setAddr ≈ 13+ txs) needs Sepolia ETH on the
  **parent-owner key**. Fund generously from any public faucet before the demo.
  Agent Arc wallets hold **0 Sepolia ETH** (checked 2026-09-08) — fine, because
  the parent owner performs all writes; agents only need Sepolia ETH later if
  they self-update their own records via EAC.
- **MockUSDC (registration fee):** parent `.eth` registration fee is collected
  in **MockUSDC of the live generation** (`mint(to, amount)` open — anyone can
  mint; 6 decimals, e.g. `100_000_000n` = 100 USDC), then
  `approve(ETHRegistrar, amount)` before `register`. Subname `register()` takes
  no fee args (gas + expiry only). Exact parent fee: quote the live
  `StandardRentPriceOracle` at demo time (**re-check-required**).
- Grace: 28-day renewal grace on `.eth` names.

## 9. Expiry / revocation settings

- Subname `expiry`: `uint64` per `register` — demo suggestion `1786156800n`
  (≈ 2026-09-08 + 365d; compute exact at signing). Keep `ROLE_RENEW` in the
  bitmap so the demo can `renew(anyId, newExpiry)`; `CannotReduceExpiry` /
  `CannotSetPastExpiry` enforced on-chain.
- Revocation paths: `unregister(anyId)` (emits `LabelUnregistered`) or
  `revokeRoles` registry-side + `authorizeAgentRecord(allowed: false)`
  resolver-side. Lock-forever (NOT for demo): revoke role *and* admin from self.
- Caches: SDK `createEnsLabelCache` keys by **labelhash** (token IDs mutable —
  `TokenRegenerated` event); resolvers **never cached**.

## 10. What the human must fund / sign (Day-8 checklist)

1. Own a Sepolia key with **Sepolia ETH** (faucet) — the parent owner.
2. Register `agentpool.eth` (MockUSDC mint → approve → register) **on the live generation**.
3. Deploy + `initialize` the `UserRegistry` proxy via the **live
   `VerifiableFactory` address read that day** (paste explicitly — no default).
4. Deploy (or clone) 4 Permissioned-Resolver instances from the live impl.
5. Sign §7 steps 1–4 for agent1..agent4 (12 writes + setup), then run §7 step 5 reads.
6. Re-verify: Deployments table, `*.json` addresses, ABI selectors, price-oracle fee.

## 11. Beta caveats (standing)

- Interfaces not final; addresses rotate — demonstrated LIVE by this report
  (docs pin ≠ HEAD). Re-fetch before Day-8 **and** at demo time.
- Resolver looked up fresh per write, never cached; token IDs mutable,
  labelhash cache key.
- Beta registry is clean (Alpha names wiped); experimental-software notice applies.

## 12. Re-check-required items (live fetch failed or time-sensitive)

> 2026-09-10 update: UR resolution re-verified live
> (`https://ethereum-sepolia-rpc.publicnode.com`) — `agent1..4.agentpool.eth`
> 4/4 MATCH to seed Arc wallets via shared resolver `0x2f60…9973`; parent
> `agentpool.eth` resolves (no Arc record, as expected). Receipts, EAC grant
> state, and registrar-side owner/tokenId still open. See `ENS.md` §3.

- [ ] Which generation (pin `97a57293` vs HEAD `0x118b…` factory family) the UR proxy + app.ens.dev serve at demo time.
- [x] `agentpool.eth` + `agent1..4` resolve via the UR proxy at demo time (verified 2026-09-10: 4/4 MATCH, parent resolves with no Arc record). Still open: registrar-side availability/owner on the live `ETHRegistry`/`ETHRegistrar` generation that owns registry `0x365d…e1dc34` (v1-style `available(string)` reverts on v2 — use Explorer or v2 ABI).
- [ ] Live `VerifiableFactory` address as explicit per-call input (DO NOT hardcode).
- [ ] Live `MockUSDC` address + exact parent fee from live price oracle.
- [ ] Write-function selectors vs `contracts-v2` HEAD (`register`, `authorizeAddrRoles`, `setAddr`, `deployProxy`).
- [ ] `buildUserRegistrySalt` encoding assumption vs live factory (`ProxyDeployed` address check).

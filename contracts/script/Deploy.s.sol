// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Script} from "forge-std/Script.sol";
import {ResourcePool} from "../src/ResourcePool.sol";

/// @notice Deploys one ResourcePool (one pool, one VPS — no factory).
///
/// @dev All params come from the environment so nothing chain-specific is baked in:
///   USDC                ERC-20 USDC on the target chain (Arc testnet: 0x3600000000000000000000000000000000000000)
///   PROVIDER            VPS provider payout address
///   TARGET              funding target in ERC-20 atomic units, e.g. 10000000 = 10 USDC
///   DEADLINE            unix timestamp after which an unfilled pool can finalizeExpired
///   REPUTATION_REGISTRY ERC-8004 ReputationRegistry (Arc testnet: 0x8004B663056A597Dffe9eCcC1965A193B7388713)
///   RESOURCE_URI        off-chain resource description + terms, e.g. ipfs://... (empty = unpublished;
///                       immutable once deployed, so decide before deploy, not after)
///   MAX_PARTICIPANTS    hard cap on distinct committers for the round-1 seed;
///                       bounds iteration on every path
///                       (default 200 — sizing for the hundred-agent README scale with headroom)
///   MAX_PARTICIPANTS_CAP deploy-time ceiling for EVERY round's maxParticipants
///                       (startRound reverts CapExceeded above it; defaults to MAX_PARTICIPANTS)
///                       Later rounds supply their own target/duration/maxParticipants via
///                       startRound — TARGET/DEADLINE below only seed round 1.
///
/// Dry run (no keys needed):
///   USDC=0x3600000000000000000000000000000000000000 PROVIDER=0x... TARGET=10000000 \
///     DEADLINE=1893456000 REPUTATION_REGISTRY=0x8004B663056A597Dffe9eCcC1965A193B7388713 \
///     RESOURCE_URI=ipfs://... MAX_PARTICIPANTS=200 \
///     forge script script/Deploy.s.sol --rpc-url https://rpc.testnet.arc.io
///
/// Live (Arc testnet, chain 5042002):
///   ... forge script script/Deploy.s.sol --rpc-url https://rpc.testnet.arc.io \
///     --broadcast --verify --verifier blockscout --verifier-url https://testnet.arcscan.app/api
contract Deploy is Script {
    function run() external returns (ResourcePool pool) {
        address usdc = vm.envAddress("USDC");
        address provider = vm.envAddress("PROVIDER");
        uint256 target = vm.envUint("TARGET");
        uint64 deadline = uint64(vm.envUint("DEADLINE"));
        address reputationRegistry = vm.envAddress("REPUTATION_REGISTRY");
        string memory resourceURI = vm.envOr("RESOURCE_URI", string(""));
        uint256 maxParticipants = vm.envOr("MAX_PARTICIPANTS", uint256(200));
        uint256 maxParticipantsCap = vm.envOr("MAX_PARTICIPANTS_CAP", maxParticipants);

        vm.startBroadcast();
        pool = new ResourcePool(
            usdc, provider, target, deadline, reputationRegistry, resourceURI, maxParticipants, maxParticipantsCap
        );
        vm.stopBroadcast();
    }
}

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
///
/// Dry run (no keys needed):
///   USDC=0x3600000000000000000000000000000000000000 PROVIDER=0x... TARGET=10000000 \
///     DEADLINE=1893456000 REPUTATION_REGISTRY=0x8004B663056A597Dffe9eCcC1965A193B7388713 \
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

        vm.startBroadcast();
        pool = new ResourcePool(usdc, provider, target, deadline, reputationRegistry);
        vm.stopBroadcast();
    }
}

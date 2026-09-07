// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {ResourcePool} from "../src/ResourcePool.sol";

/// @notice Mintable USDC stand-in (6 decimals like the ERC-20 view on Arc).
contract MockUSDC {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        require(allowed >= amount, "allowance");
        allowance[from][msg.sender] = allowed - amount;
        require(balanceOf[from] >= amount, "balance");
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        require(balanceOf[msg.sender] >= amount, "balance");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

/// @notice Records ERC-8004 feedback writes for assertions (parallel arrays keep getters scalar).
contract MockReputation {
    uint256[] public ids;
    int128[] public values;
    string[] public tag1s;

    function giveFeedback(
        uint256 agentId,
        int128 value,
        uint8,
        string calldata tag1,
        string calldata,
        string calldata,
        string calldata,
        bytes32
    ) external {
        ids.push(agentId);
        values.push(value);
        tag1s.push(tag1);
    }

    function callCount() external view returns (uint256) {
        return ids.length;
    }
}

contract ResourcePoolTest is Test {
    MockUSDC usdc;
    MockReputation rep;
    ResourcePool pool;

    address provider = makeAddr("provider");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address carol = makeAddr("carol");

    uint256 constant TARGET = 10_000_000; // 10 USDC, ERC-20 view
    uint64 deadline;

    event Committed(address indexed agent, uint256 amount);
    event Settled(uint256 total);
    event Refunded(address indexed agent, uint256 amount);
    event DroppedOut(address indexed agent, uint256 forfeited);

    function setUp() public {
        usdc = new MockUSDC();
        rep = new MockReputation();
        deadline = uint64(block.timestamp + 7 days);
        pool = new ResourcePool(address(usdc), provider, TARGET, deadline, address(rep));

        usdc.mint(alice, 100_000_000);
        usdc.mint(bob, 100_000_000);
        usdc.mint(carol, 100_000_000);
    }

    function _commit(address who, uint256 amount) internal {
        vm.startPrank(who);
        usdc.approve(address(pool), amount);
        pool.commit(amount);
        vm.stopPrank();
    }

    // --- Path 1: fill + settle -------------------------------------------------

    function test_fillAndSettle() public {
        _commit(alice, 4_000_000);
        _commit(bob, 3_000_000);
        _commit(carol, 3_000_000);

        assertEq(pool.totalCommitted(), TARGET);
        assertEq(uint256(pool.participantCount()), 3);

        vm.startPrank(alice);
        pool.bindAgentId(1);
        vm.stopPrank();
        vm.startPrank(bob);
        pool.bindAgentId(2);
        vm.stopPrank();

        vm.expectEmit(false, false, false, true);
        emit Settled(TARGET);
        pool.settle();

        assertTrue(pool.settled());
        assertEq(usdc.balanceOf(provider), TARGET);
        assertEq(usdc.balanceOf(address(pool)), 0, "no stranded funds");

        // Completion feedback composed into ERC-8004 for bound agents only.
        assertEq(rep.callCount(), 2);
        assertEq(rep.ids(0), 1);
        assertEq(rep.values(0), 1);
        assertEq(rep.tag1s(0), "completion");
        assertEq(rep.ids(1), 2);
    }

    function test_settleAfterDeadlineStillWorksWhenFilled() public {
        _commit(alice, TARGET);
        vm.warp(deadline + 1);
        assertFalse(pool.expired(), "filled pool never reads expired");
        pool.settle();
        assertTrue(pool.settled());
        assertEq(usdc.balanceOf(provider), TARGET);
    }

    // --- Path 2: expire + refund ------------------------------------------------

    function test_expireAndRefund() public {
        _commit(alice, 4_000_000);
        _commit(bob, 2_000_000);

        assertFalse(pool.expired());
        vm.warp(deadline + 1);
        assertTrue(pool.expired(), "unfilled pool reads expired past deadline");

        uint256 aliceBefore = usdc.balanceOf(alice);
        uint256 bobBefore = usdc.balanceOf(bob);

        vm.expectEmit(true, false, false, true);
        emit Refunded(alice, 4_000_000);
        vm.expectEmit(true, false, false, true);
        emit Refunded(bob, 2_000_000);
        pool.finalizeExpired();

        assertEq(usdc.balanceOf(alice) - aliceBefore, 4_000_000);
        assertEq(usdc.balanceOf(bob) - bobBefore, 2_000_000);
        assertEq(usdc.balanceOf(address(pool)), 0, "no stranded funds");
    }

    function test_refundDustNeverStrands() public {
        // 7 USDC across 3 agents: 7/3-style splits leave dust without the fix-up.
        _commit(alice, 3_000_000);
        _commit(bob, 2_000_000);
        _commit(carol, 2_000_000);
        vm.warp(deadline + 1);
        pool.finalizeExpired();
        assertEq(usdc.balanceOf(address(pool)), 0, "no stranded funds");
        assertEq(usdc.balanceOf(provider), 0, "nothing siphoned to provider");
    }

    // --- Path 3: dropout + forfeit ----------------------------------------------

    function test_dropoutForfeitsAndRewardsRemainers() public {
        _commit(alice, 4_000_000);
        _commit(bob, 4_000_000);

        vm.startPrank(alice);
        vm.expectEmit(true, false, false, true);
        emit DroppedOut(alice, 4_000_000);
        pool.dropOut(11);
        vm.stopPrank();

        assertEq(pool.forfeitedTotal(), 4_000_000);
        assertEq(uint256(pool.participantCount()), 1);
        assertEq(rep.callCount(), 1);
        assertEq(rep.ids(0), 11);
        assertEq(rep.values(0), -1);
        assertEq(rep.tag1s(0), "dropout");

        // Forfeiture stays locked and counts toward target: carol tops up to fill.
        assertEq(pool.totalCommitted(), 8_000_000);
        _commit(carol, 2_000_000);
        pool.settle();
        assertEq(usdc.balanceOf(provider), TARGET);
        assertEq(usdc.balanceOf(address(pool)), 0, "no stranded funds");
    }

    function test_dropoutBonusOnRefundPath() public {
        _commit(alice, 4_000_000);
        _commit(bob, 2_000_000);

        vm.prank(alice);
        pool.dropOut(11);

        vm.warp(deadline + 1);
        uint256 bobBefore = usdc.balanceOf(bob);
        pool.finalizeExpired();

        // Bob staked 2M of 6M active... pool holds 6M: bob gets all 6M (own 2M + alice's 4M forfeit).
        assertEq(usdc.balanceOf(bob) - bobBefore, 6_000_000);
        assertEq(usdc.balanceOf(address(pool)), 0, "no stranded funds");
        assertEq(usdc.balanceOf(alice), 100_000_000 - 4_000_000, "dropout gets nothing back");
    }

    function test_allDroppedOutSendsBalanceToProvider() public {
        _commit(alice, 4_000_000);
        vm.prank(alice);
        pool.dropOut(11);
        vm.warp(deadline + 1);
        pool.finalizeExpired();
        assertEq(usdc.balanceOf(provider), 4_000_000, "forfeit with no remainers goes to provider");
        assertEq(usdc.balanceOf(address(pool)), 0, "no stranded funds");
    }

    // --- Path 4: unauthorized writes rejected ------------------------------------

    function test_reverts() public {
        // Commit over target is capped.
        _commit(alice, TARGET);
        vm.startPrank(bob);
        usdc.approve(address(pool), 1);
        vm.expectRevert(abi.encodeWithSelector(ResourcePool.OverTarget.selector, TARGET + 1, TARGET));
        pool.commit(1);
        vm.stopPrank();

        // Settle works once filled; second settle reverts.
        pool.settle();
        vm.expectRevert(ResourcePool.PoolSettled.selector);
        pool.settle();

        // Everything else is closed after settle.
        vm.startPrank(bob);
        usdc.approve(address(pool), 1);
        vm.expectRevert(ResourcePool.PoolSettled.selector);
        pool.commit(1);
        vm.expectRevert(ResourcePool.PoolSettled.selector);
        pool.dropOut(2);
        vm.stopPrank();
        vm.expectRevert(ResourcePool.PoolSettled.selector);
        pool.finalizeExpired();
    }

    function test_finalizeBeforeDeadlineReverts() public {
        _commit(alice, 1_000_000);
        vm.expectRevert(abi.encodeWithSelector(ResourcePool.NotExpired.selector, uint64(block.timestamp), deadline));
        pool.finalizeExpired();
    }

    function test_settleBeforeFillReverts() public {
        _commit(alice, 1_000_000);
        vm.expectRevert(abi.encodeWithSelector(ResourcePool.NotFilled.selector, 1_000_000, TARGET));
        pool.settle();
    }

    function test_strangerDropOutReverts() public {
        _commit(alice, 1_000_000);
        vm.prank(bob);
        vm.expectRevert(ResourcePool.NotParticipant.selector);
        pool.dropOut(2);
    }

    function test_doubleDropOutReverts() public {
        _commit(alice, 1_000_000);
        vm.startPrank(alice);
        pool.dropOut(1);
        vm.expectRevert(ResourcePool.AlreadyDroppedOut.selector);
        pool.dropOut(1);
        vm.stopPrank();
    }

    function test_zeroCommitReverts() public {
        vm.prank(alice);
        vm.expectRevert(ResourcePool.ZeroAmount.selector);
        pool.commit(0);
    }

    // --- Registry failures never brick funds --------------------------------------

    function test_reputationRevertDoesNotBrickSettle() public {
        ResourcePool noRegistry = new ResourcePool(address(usdc), provider, TARGET, deadline, address(0));
        vm.startPrank(alice);
        usdc.approve(address(noRegistry), TARGET);
        noRegistry.commit(TARGET);
        vm.stopPrank();
        noRegistry.settle();
        assertEq(usdc.balanceOf(provider), TARGET);
    }
}

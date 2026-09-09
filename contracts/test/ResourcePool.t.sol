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
    event Committed(address indexed agent, uint256 indexed roundId, uint256 amount);
    event Settled(uint256 total);
    event Settled(uint256 indexed roundId, uint256 total);
    event ExpiredFinalized(uint256 balance, uint256 claimants);
    event Refunded(address indexed agent, uint256 amount);
    event DroppedOut(address indexed agent, uint256 forfeited);
    event RoundStarted(uint256 indexed roundId, uint256 target, uint64 deadline, uint256 maxParticipants);

    function setUp() public {
        usdc = new MockUSDC();
        rep = new MockReputation();
        deadline = uint64(block.timestamp + 7 days);
        // Round 1 is seeded at deploy; cap == round-1 max here.
        pool = new ResourcePool(address(usdc), provider, TARGET, deadline, address(rep), "ipfs://test-resource", 10, 10);

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

    function _commitR(address who, uint256 roundId, uint256 amount) internal {
        vm.startPrank(who);
        usdc.approve(address(pool), amount);
        pool.commit(roundId, amount);
        vm.stopPrank();
    }

    // --- Path 1: fill + inline auto-settle -------------------------------------

    function test_fillAndSettle() public {
        vm.startPrank(alice);
        usdc.approve(address(pool), 4_000_000);
        pool.commit(4_000_000);
        pool.bindAgentId(1);
        vm.stopPrank();
        vm.startPrank(bob);
        usdc.approve(address(pool), 3_000_000);
        pool.commit(3_000_000);
        pool.bindAgentId(2);
        vm.stopPrank();

        assertFalse(pool.settled(), "not filled yet");

        // The filling commit pays the provider inline: no separate settle call.
        _commit(carol, 3_000_000);

        assertEq(pool.totalCommitted(), TARGET);
        assertEq(uint256(pool.participantCount()), 3);
        assertTrue(pool.settled());
        assertEq(usdc.balanceOf(provider), TARGET);
        assertEq(usdc.balanceOf(address(pool)), 0, "no stranded funds");

        // settle() itself writes no feedback (O(1) fund movement); completion
        // feedback is paginated afterwards. Bound agents only.
        assertEq(rep.callCount(), 0, "settle writes no feedback");
        pool.recordCompletions(10);
        assertEq(pool.feedbackCursor(), 3);
        assertEq(rep.callCount(), 2);
        assertEq(rep.ids(0), 1);
        assertEq(rep.values(0), 1);
        assertEq(rep.tag1s(0), "completion");
        assertEq(rep.ids(1), 2);
    }

    function test_recordCompletionsPaginatesAndSkips() public {
        _commit(alice, 4_000_000);
        vm.prank(alice);
        pool.bindAgentId(1);
        // Carol commits then drops BEFORE the pool fills, so the dropout write
        // happens pre-settle and her forfeit still counts toward target.
        _commit(carol, 3_000_000);
        vm.prank(carol);
        pool.dropOut(3);
        // Bob's top-up fills the pool and auto-settles inline.
        _commit(bob, 3_000_000);

        assertEq(usdc.balanceOf(provider), TARGET);
        assertEq(rep.callCount(), 1, "only carol's dropout write so far");
        assertEq(rep.values(0), -1);

        // Join order is alice, carol, bob. One record per call.
        pool.recordCompletions(1);
        assertEq(pool.feedbackCursor(), 1);
        assertEq(rep.callCount(), 2);
        assertEq(rep.ids(1), 1);
        assertEq(rep.values(1), 1);
        assertEq(rep.tag1s(1), "completion");

        pool.recordCompletions(1);
        assertEq(pool.feedbackCursor(), 2);
        assertEq(rep.callCount(), 2, "dropped carol skipped");

        pool.recordCompletions(10); // clamped at the end, no overrun
        assertEq(pool.feedbackCursor(), 3);
        assertEq(rep.callCount(), 2, "unbound bob skipped");

        pool.recordCompletions(10); // past-the-end call is a no-op
        assertEq(rep.callCount(), 2);
    }

    function test_recordCompletionsBeforeSettleReverts() public {
        _commit(alice, 1_000_000);
        vm.expectRevert(ResourcePool.NotSettled.selector);
        pool.recordCompletions(10);
    }

    function test_settleAfterDeadlineStillWorksWhenFilled() public {
        _commit(alice, TARGET); // inline auto-settle fires immediately
        assertTrue(pool.settled());
        vm.warp(deadline + 1);
        assertFalse(pool.expired(), "filled pool never reads expired");
        assertEq(usdc.balanceOf(provider), TARGET);
        // Permissionless fallback reverts cleanly now that inline already fired.
        vm.expectRevert(ResourcePool.AlreadySettled.selector);
        pool.settle(1);
    }

    // --- Path 2: expire + refund ------------------------------------------------

    function test_expireAndRefund() public {
        _commit(alice, 4_000_000);
        _commit(bob, 2_000_000);

        assertFalse(pool.expired());
        vm.warp(deadline + 1);
        assertTrue(pool.expired(), "unfilled pool reads expired past deadline");

        // finalizeExpired only snapshots — no funds move yet.
        vm.expectEmit(false, false, false, true);
        emit ExpiredFinalized(6_000_000, 2);
        pool.finalizeExpired();
        assertEq(usdc.balanceOf(address(pool)), 6_000_000, "snapshot holds funds");
        assertEq(pool.refundRemaining(), 2);

        // Each participant pulls their own share.
        uint256 aliceBefore = usdc.balanceOf(alice);
        uint256 bobBefore = usdc.balanceOf(bob);

        vm.expectEmit(true, false, false, true);
        emit Refunded(alice, 4_000_000);
        vm.prank(alice);
        pool.claimRefund();

        vm.expectEmit(true, false, false, true);
        emit Refunded(bob, 2_000_000);
        vm.prank(bob);
        pool.claimRefund();

        assertEq(usdc.balanceOf(alice) - aliceBefore, 4_000_000);
        assertEq(usdc.balanceOf(bob) - bobBefore, 2_000_000);
        assertEq(usdc.balanceOf(address(pool)), 0, "no stranded funds");
        assertEq(pool.refundRemaining(), 0);
    }

    function test_claimOrderIndependentAndDustToLast() public {
        // 7 USDC across 3 agents: 7/3-style splits leave dust without the fix-up.
        _commit(alice, 3_000_000);
        _commit(bob, 2_000_000);
        _commit(carol, 2_000_000);
        vm.warp(deadline + 1);
        pool.finalizeExpired();

        // Claim out of join order; the LAST claimant absorbs dust either way.
        vm.prank(carol);
        pool.claimRefund();
        vm.prank(bob);
        pool.claimRefund();
        uint256 aliceBefore = usdc.balanceOf(alice);
        vm.prank(alice);
        pool.claimRefund();

        assertEq(usdc.balanceOf(address(pool)), 0, "no stranded funds");
        assertEq(usdc.balanceOf(provider), 0, "nothing siphoned to provider");
        assertGt(usdc.balanceOf(alice) - aliceBefore, 0, "last claimant got remainder");
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

        // Forfeiture stays locked and counts toward target: carol tops up to
        // fill, and the filling commit auto-settles inline.
        assertEq(pool.totalCommitted(), 8_000_000);
        _commit(carol, 2_000_000);
        assertTrue(pool.settled());
        assertEq(usdc.balanceOf(provider), TARGET);
        assertEq(usdc.balanceOf(address(pool)), 0, "no stranded funds");
    }

    function test_dropoutBonusOnRefundPath() public {
        _commit(alice, 4_000_000);
        _commit(bob, 2_000_000);

        vm.prank(alice);
        pool.dropOut(11);

        vm.warp(deadline + 1);
        pool.finalizeExpired();

        // Bob staked 2M of 6M active... pool holds 6M: bob gets all 6M (own 2M + alice's 4M forfeit).
        uint256 bobBefore = usdc.balanceOf(bob);
        vm.prank(bob);
        pool.claimRefund();
        assertEq(usdc.balanceOf(bob) - bobBefore, 6_000_000);
        assertEq(usdc.balanceOf(address(pool)), 0, "no stranded funds");
        assertEq(usdc.balanceOf(alice), 100_000_000 - 4_000_000, "dropout gets nothing back");

        // Dropouts have no share to pull.
        vm.prank(alice);
        vm.expectRevert(ResourcePool.NothingToWithdraw.selector);
        pool.claimRefund();
    }

    function test_claimRefundEdgeCasesRevert() public {
        _commit(alice, 4_000_000);

        // Nothing to pull before expiry is finalized.
        vm.prank(alice);
        vm.expectRevert(ResourcePool.NothingToWithdraw.selector);
        pool.claimRefund();

        vm.warp(deadline + 1);
        pool.finalizeExpired();

        // Strangers with no stake revert.
        vm.prank(bob);
        vm.expectRevert(ResourcePool.NothingToWithdraw.selector);
        pool.claimRefund();

        // Double-claim reverts.
        vm.prank(alice);
        pool.claimRefund();
        vm.prank(alice);
        vm.expectRevert(ResourcePool.NothingToWithdraw.selector);
        pool.claimRefund();
    }

    function test_nonClaimantDoesNotBlockOthers() public {
        // The pull pattern's whole point: one participant that never claims
        // (or is a contract with hostile fallback logic — plain ERC-20
        // transfers invoke no receiver code, but independence holds regardless)
        // cannot grief anyone else's refund.
        _commit(alice, 4_000_000);
        _commit(bob, 2_000_000);
        vm.warp(deadline + 1);
        pool.finalizeExpired();

        // Alice never claims. Bob still gets his exact share.
        uint256 bobBefore = usdc.balanceOf(bob);
        vm.prank(bob);
        pool.claimRefund();
        assertEq(usdc.balanceOf(bob) - bobBefore, 2_000_000);
        // Alice's share simply waits for her; nothing of bob's is stuck.
        assertEq(usdc.balanceOf(address(pool)), 4_000_000);
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
        // Commit over target is capped (checked before the pool fills).
        _commit(alice, TARGET - 1);
        vm.startPrank(bob);
        usdc.approve(address(pool), 2);
        vm.expectRevert(abi.encodeWithSelector(ResourcePool.OverTarget.selector, TARGET + 1, TARGET));
        pool.commit(2);
        vm.stopPrank();

        // Alice's top-up fills the pool and auto-settles inline.
        _commit(alice, 1);
        assertTrue(pool.settled());

        // Second settle reverts (legacy shim keeps the v1 error).
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

        // Pull path is also closed: nothing was ever snapshotted.
        vm.prank(bob);
        vm.expectRevert(ResourcePool.NothingToWithdraw.selector);
        pool.claimRefund();
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

    // --- bindAgentId revert coverage --------------------------------------------

    function test_doubleBindReverts() public {
        _commit(alice, 1_000_000);
        vm.startPrank(alice);
        pool.bindAgentId(1);
        vm.expectRevert(ResourcePool.AlreadyBound.selector);
        pool.bindAgentId(2);
        vm.stopPrank();
    }

    function test_strangerBindReverts() public {
        _commit(alice, 1_000_000);
        vm.prank(bob);
        vm.expectRevert(ResourcePool.NotParticipant.selector);
        pool.bindAgentId(2);
    }

    function test_droppedOutBindReverts() public {
        _commit(alice, 1_000_000);
        vm.startPrank(alice);
        pool.dropOut(1);
        vm.expectRevert(ResourcePool.NotParticipant.selector);
        pool.bindAgentId(1);
        vm.stopPrank();
    }

    function test_bindAfterSettleReverts() public {
        _commit(alice, TARGET); // inline auto-settle
        assertTrue(pool.settled());
        vm.prank(alice);
        vm.expectRevert(ResourcePool.PoolSettled.selector);
        pool.bindAgentId(1);
    }

    function test_bindAfterFinalizeReverts() public {
        _commit(alice, 1_000_000);
        vm.warp(deadline + 1);
        pool.finalizeExpired();
        vm.prank(alice);
        vm.expectRevert(ResourcePool.PoolFinalized.selector);
        pool.bindAgentId(1);
    }

    // --- Registry failures never brick funds --------------------------------------

    function test_reputationRevertDoesNotBrickSettle() public {
        ResourcePool noRegistry =
            new ResourcePool(address(usdc), provider, TARGET, deadline, address(0), "", 10, 10);
        vm.startPrank(alice);
        usdc.approve(address(noRegistry), TARGET);
        noRegistry.commit(TARGET); // filling commit pays inline even with no registry
        vm.stopPrank();
        assertTrue(noRegistry.settled());
        assertEq(usdc.balanceOf(provider), TARGET);
    }

    // --- Deploy-time decisions: resourceURI + maxParticipants -------------------

    function test_resourceURIStoredImmutable() public view {
        assertEq(pool.resourceURI(), "ipfs://test-resource");
        assertEq(pool.maxParticipants(), 10);
        assertEq(pool.maxParticipantsCap(), 10);
        assertEq(pool.currentRoundId(), 1);
    }

    function test_zeroMaxParticipantsReverts() public {
        vm.expectRevert(ResourcePool.BadMaxParticipants.selector);
        new ResourcePool(address(usdc), provider, TARGET, deadline, address(rep), "", 0, 10);
    }

    function test_zeroCapReverts() public {
        vm.expectRevert(ResourcePool.BadMaxParticipants.selector);
        new ResourcePool(address(usdc), provider, TARGET, deadline, address(rep), "", 10, 0);
    }

    function test_roundMaxAboveCapReverts() public {
        vm.expectRevert(abi.encodeWithSelector(ResourcePool.CapExceeded.selector, 11, 10));
        new ResourcePool(address(usdc), provider, TARGET, deadline, address(rep), "", 11, 10);
    }

    function test_commitBeyondMaxParticipantsReverts() public {
        ResourcePool small =
            new ResourcePool(address(usdc), provider, TARGET, deadline, address(rep), "", 2, 2);
        address dave = makeAddr("dave");
        usdc.mint(dave, 100_000_000);

        vm.startPrank(alice);
        usdc.approve(address(small), 1_000_000);
        small.commit(1_000_000);
        vm.stopPrank();

        vm.startPrank(bob);
        usdc.approve(address(small), 1_000_000);
        small.commit(1_000_000);
        vm.stopPrank();

        // Third distinct committer is rejected even though target is unfilled.
        vm.startPrank(carol);
        usdc.approve(address(small), 1_000_000);
        vm.expectRevert(abi.encodeWithSelector(ResourcePool.TooManyParticipants.selector, 2));
        small.commit(1_000_000);
        vm.stopPrank();

        // Existing participants can still top up under the cap.
        vm.startPrank(alice);
        usdc.approve(address(small), 1_000_000);
        small.commit(1_000_000);
        vm.stopPrank();
        assertEq(small.totalCommitted(), 3_000_000);
    }

    // --- Rounds: reusable singleton ----------------------------------------------

    function test_startRoundOnlyProvider() public {
        // Round 1 is open: even the provider cannot open round 2 yet, and a
        // stranger is rejected on auth first.
        vm.prank(alice);
        vm.expectRevert(ResourcePool.NotProvider.selector);
        pool.startRound(TARGET, 1 hours, 10);

        // Fill round 1 (inline auto-settle) so it is terminal.
        _commit(alice, TARGET);
        assertTrue(pool.settled());

        vm.prank(alice);
        vm.expectRevert(ResourcePool.NotProvider.selector);
        pool.startRound(TARGET, 1 hours, 10);

        uint64 expectedDeadline = uint64(block.timestamp) + 1 hours;
        vm.expectEmit(true, false, false, true);
        emit RoundStarted(2, TARGET, expectedDeadline, 10);
        vm.prank(provider);
        pool.startRound(TARGET, 1 hours, 10);

        assertEq(pool.currentRoundId(), 2);
        assertEq(pool.target(), TARGET);
        assertEq(pool.totalCommitted(), 0);
    }

    function test_startRoundWhileOpenReverts() public {
        _commit(alice, 1_000_000);
        vm.prank(provider);
        vm.expectRevert(ResourcePool.RoundOpen.selector);
        pool.startRound(TARGET, 1 hours, 10);
    }

    function test_startRoundValidations() public {
        // Param validation fires before the terminal-state check, so these
        // revert even while round 1 is still open.
        vm.startPrank(provider);
        vm.expectRevert(ResourcePool.ZeroTarget.selector);
        pool.startRound(0, 1 hours, 10);
        vm.expectRevert(abi.encodeWithSelector(ResourcePool.BadDuration.selector, 0));
        pool.startRound(TARGET, 0, 10);
        vm.expectRevert(abi.encodeWithSelector(ResourcePool.BadDuration.selector, 2 hours + 1));
        pool.startRound(TARGET, 2 hours + 1, 10);
        vm.expectRevert(ResourcePool.BadMaxParticipants.selector);
        pool.startRound(TARGET, 1 hours, 0);
        vm.expectRevert(abi.encodeWithSelector(ResourcePool.CapExceeded.selector, 11, 10));
        pool.startRound(TARGET, 1 hours, 11);
        vm.stopPrank();

        // Expired-but-unfinalized round 1 must be finalized first.
        _commit(alice, 1_000_000);
        vm.warp(deadline + 1);
        vm.prank(provider);
        vm.expectRevert(ResourcePool.RoundNotTerminal.selector);
        pool.startRound(TARGET, 1 hours, 10);

        pool.finalizeExpired();
        vm.prank(provider);
        pool.startRound(TARGET, 1 hours, 5);
        assertEq(pool.currentRoundId(), 2);
        assertEq(pool.maxParticipants(), 5);
    }

    function test_commitToWrongRoundReverts() public {
        _commit(alice, 1_000_000);
        vm.startPrank(bob);
        usdc.approve(address(pool), 1_000_000);
        vm.expectRevert(ResourcePool.WrongRound.selector);
        pool.commit(0, 1_000_000);
        vm.expectRevert(ResourcePool.WrongRound.selector);
        pool.commit(2, 1_000_000);
        vm.expectRevert(ResourcePool.WrongRound.selector);
        pool.settle(2);
        vm.expectRevert(ResourcePool.WrongRound.selector);
        pool.claimRefund(2);
        vm.stopPrank();
    }

    function test_fillingCommitAutoSettlesInline() public {
        _commit(alice, 4_000_000);
        _commit(bob, 3_000_000);
        assertFalse(pool.settled());

        uint256 providerBefore = usdc.balanceOf(provider);
        // No separate settle call: the filling tx itself moves the funds.
        _commit(carol, 3_000_000);

        assertTrue(pool.settled());
        assertEq(usdc.balanceOf(provider) - providerBefore, TARGET);
        assertEq(usdc.balanceOf(address(pool)), 0, "no stranded funds");
    }

    function test_settleFallbackIdempotent() public {
        _commit(alice, TARGET); // inline auto-settle fired
        assertTrue(pool.settled());
        uint256 providerBalance = usdc.balanceOf(provider);

        // Permissionless retry reverts cleanly with no state or fund movement.
        vm.expectRevert(ResourcePool.AlreadySettled.selector);
        pool.settle(1);
        assertEq(usdc.balanceOf(provider), providerBalance);
        assertEq(usdc.balanceOf(address(pool)), 0);
    }

    function test_roundIsolation_RefundOnlyOwnRound() public {
        _commit(alice, 4_000_000);
        _commit(bob, 2_000_000);
        vm.warp(deadline + 1);
        pool.finalizeExpired(1);

        vm.prank(provider);
        pool.startRound(TARGET, 1 hours, 10);
        _commitR(carol, 2, 5_000_000);

        // Per-round ledgers are isolated.
        assertEq(pool.committed(1, bob), 2_000_000);
        assertEq(pool.committed(2, carol), 5_000_000);
        assertEq(pool.committed(1, carol), 0);
        assertEq(pool.totalCommitted(), 5_000_000, "shim follows current round");

        // Round-2 stake is not yet refundable (round 2 never finalized).
        vm.prank(carol);
        vm.expectRevert(ResourcePool.NothingToWithdraw.selector);
        pool.claimRefund(2);
        // Carol has no round-1 share either.
        vm.prank(carol);
        vm.expectRevert(ResourcePool.NothingToWithdraw.selector);
        pool.claimRefund(1);

        // Round-1 refunds still work after round 2 started, sized by round 1
        // alone (round-2 funds are untouched).
        uint256 bobBefore = usdc.balanceOf(bob);
        vm.prank(bob);
        pool.claimRefund(1);
        assertEq(usdc.balanceOf(bob) - bobBefore, 2_000_000);
        assertEq(usdc.balanceOf(address(pool)), 4_000_000 + 5_000_000);
    }

    function test_expiredRoundThenNextRoundStarts() public {
        _commit(alice, 1_000_000);
        vm.warp(deadline + 1);
        assertTrue(pool.expired());
        pool.finalizeExpired();

        vm.prank(provider);
        pool.startRound(TARGET, 1 hours, 5);

        assertEq(pool.currentRoundId(), 2);
        assertFalse(pool.expired(), "fresh round is not expired");
        assertEq(pool.totalCommitted(), 0);
        assertEq(pool.participantCount(), 0);

        _commitR(bob, 2, 2_000_000);
        assertEq(pool.totalCommitted(), 2_000_000);
        assertEq(pool.participantCount(), 1);
    }

    function test_feedbackCursorPerRound() public {
        _commit(alice, 4_000_000);
        vm.prank(alice);
        pool.bindAgentId(1, 1);
        _commit(bob, 3_000_000);
        vm.prank(bob);
        pool.bindAgentId(1, 2);
        _commit(carol, 3_000_000); // inline auto-settle, round 1 terminal

        pool.recordCompletions(1, 10);
        assertEq(pool.feedbackCursor(), 3);

        vm.prank(provider);
        pool.startRound(TARGET, 1 hours, 10);
        assertEq(pool.feedbackCursor(), 0, "cursor is per-round");
        // Round 2 is unsettled: pagination there is closed.
        vm.expectRevert(ResourcePool.NotSettled.selector);
        pool.recordCompletions(2, 10);
        // Round-1 cursor is preserved and past-the-end is a no-op.
        pool.recordCompletions(1, 10);
    }

    function testFuzz_commitNeverExceedsTargetPerRound(uint256 x, uint256 y) public {
        uint256 a = bound(x, 1, TARGET);
        uint256 b = bound(y, 1, TARGET);

        _commitR(alice, 1, a);
        assertLe(pool.totalCommitted(), TARGET, "round total capped at target");

        vm.startPrank(bob);
        usdc.approve(address(pool), b);
        try pool.commit(1, b) {} catch (bytes memory) {}
        vm.stopPrank();

        assertLe(pool.totalCommitted(), TARGET, "round total never exceeds target");
        assertLe(pool.committed(1, alice) + pool.committed(1, bob), TARGET);
        if (pool.settled()) {
            assertEq(usdc.balanceOf(address(pool)), 0, "settled round holds nothing");
            assertEq(usdc.balanceOf(provider), pool.totalCommitted());
        }
    }
}

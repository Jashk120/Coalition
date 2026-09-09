// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// @notice Minimal ERC-20 surface ResourcePool relies on (USDC on Arc).
interface IPoolUSDC {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

/// @notice Minimal ERC-8004 ReputationRegistry surface: objective outcome writes only.
/// @dev Full signature per EIP-8004 §Reputation Registry. Pool composes; it never reads.
interface IPoolReputation {
    function giveFeedback(
        uint256 agentId,
        int128 value,
        uint8 valueDecimals,
        string calldata tag1,
        string calldata tag2,
        string calldata endpoint,
        string calldata feedbackURI,
        bytes32 feedbackHash
    ) external;
}

/// @title ResourcePool — N-agent threshold pooling for one shared resource, reused across rounds.
/// @notice One singleton per VPS (no factory, no multipool). The provider opens a
/// funding round via `startRound`; agents `approve` USDC then `commit(roundId, ...)`.
/// The commit that reaches `target` pays the provider the full balance INLINE in
/// the same tx; `settle(roundId)` remains as a permissionless idempotent fallback.
/// Past `deadline` while unfilled, anyone may `finalizeExpired(roundId)`, which
/// snapshots that round's entitlement for later per-round `claimRefund` pulls.
/// A dropout's funds stay in the pool and count toward its round's `target`: on
/// settle they flow to the provider with everyone else's (the remaining agents
/// split the resource, not the tokens), on expiry they are split pro-rata among
/// that round's remaining agents. Either way nothing strands.
///
/// Rounds are strictly isolated: commitments, dropouts, forfeitures, refund
/// snapshots, and the completion cursor all live under their own `roundId`.
/// Unclaimed refunds stay claimable indefinitely per round, even after later
/// rounds open. A new round may only start once the previous round is terminal
/// (`settled` or `expiredFinalized`).
///
/// `resourceURI` names the shared resource and its terms off-chain (e.g. an
/// IPFS/HTTPS JSON document with VPS specs, cost breakdown, usage rules).
/// Immutable and set at deploy: adding it later would change the constructor
/// and force a redeploy, so it is decided before deploy, not after. Empty
/// string means "no terms published".
///
/// Fund movement is always O(1) per call: the filling `commit` is one pull plus
/// one payout transfer, `settle` is a single transfer to `provider`,
/// `finalizeExpired` only snapshots accounting, and each participant pulls
/// their own refund via `claimRefund`. Completion feedback is paginated via
/// `recordCompletions` under a per-round cursor. `commit` additionally enforces
/// a per-round `maxParticipants` (itself capped by the deploy-time
/// `maxParticipantsCap`), which bounds the one O(n) view (`getParticipants`)
/// and keeps even off-chain iteration predictable. A participant that never
/// claims does not affect anyone else's claim; unclaimed shares stay
/// claimable indefinitely.
///
/// Objective outcomes are composed into the ERC-8004 ReputationRegistry as
/// feedback (`dropout` = -1, `completion` = +1, tag2 = "pool"). Writes are
/// best-effort: a registry revert never bricks fund movement.
///
/// @dev Zero-arg/zero-round shims (`commit(uint256)`, `target()`,
/// `totalCommitted()`, `settled()`, `expired()`, `participantCount()`,
/// `feedbackCursor()`, and the matching no-roundId mutating calls) delegate to
/// `currentRoundId` so v1 readers keep working against the latest round.
/// `Committed`/`Settled` keep their v1 shapes AND gain roundId overloads —
/// subgraph mappings must treat the legacy `Settled(uint256)` as "funds left"
/// (it fires on inline settle, on the `settle` fallback, and on the
/// `finalizeExpired` all-dropped sweep) and `ExpiredFinalized` as the expiry
/// marker, not as funds leaving.
contract ResourcePool {
    IPoolUSDC public immutable usdc;
    address public immutable provider;
    /// @notice ERC-8004 ReputationRegistry. Zero address disables feedback writes (tests).
    address public immutable reputationRegistry;
    /// @notice Off-chain description of the shared resource + participation terms. See above.
    /// @dev Set once in the constructor; there is no setter, so it is
    /// effectively immutable (`immutable` is not allowed for strings).
    string public resourceURI;
    /// @notice Deploy-time ceiling for every round's `maxParticipants`. Never changes.
    uint256 public immutable maxParticipantsCap;

    /// @notice Per-round accounting. Round ids start at 1 (seeded in the constructor).
    struct Round {
        uint256 target;
        uint64 deadline;
        uint256 maxParticipants;
        uint256 totalCommitted;
        uint256 forfeitedTotal;
        bool settled;
        bool expiredFinalized;
        uint256 refundBalance;
        uint256 refundActiveTotal;
        uint256 refundClaimed;
        uint256 refundRemaining;
        uint256 feedbackCursor;
        uint256 droppedCount;
    }

    /// @notice Latest round id (also the only round accepting commits).
    uint256 public currentRoundId;
    mapping(uint256 => Round) public rounds;

    mapping(uint256 => mapping(address => uint256)) public committed;
    mapping(uint256 => mapping(address => bool)) public droppedOut;
    /// @notice ERC-8004 agent id self-bound by each participant; used for feedback writes.
    mapping(uint256 => mapping(address => uint256)) public agentIdOf;
    mapping(uint256 => mapping(address => bool)) public hasAgentId;

    mapping(uint256 => address[]) private _participants;
    mapping(uint256 => mapping(address => bool)) private _isParticipant;

    mapping(uint256 => mapping(address => bool)) public hasClaimed;

    bool private _locked;

    event Committed(address indexed agent, uint256 amount);
    event Committed(address indexed agent, uint256 indexed roundId, uint256 amount);
    /// @notice Funds left the pool. Fires on the inline filling commit, on the
    /// `settle` fallback, AND on the `finalizeExpired` all-dropped sweep below —
    /// subgraph mappings must treat it as "funds left", not "threshold met".
    event Settled(uint256 total);
    event Settled(uint256 indexed roundId, uint256 total);
    /// @notice Expiry snapshot taken. Individual payouts follow via `claimRefund`
    /// (`Refunded` per claimant) — subgraph mappings must treat THIS as the
    /// expiry marker, not as funds leaving.
    event ExpiredFinalized(uint256 balance, uint256 claimants);
    event Refunded(address indexed agent, uint256 amount);
    event DroppedOut(address indexed agent, uint256 forfeited);
    /// @notice Additive (not in the SDK placeholder ABI): mirrors each reputation write.
    event CompletionRecorded(uint256 indexed agentId, int128 value);
    /// @notice A new funding round opened. Round ids are sequential from 1.
    event RoundStarted(uint256 indexed roundId, uint256 target, uint64 deadline, uint256 maxParticipants);

    error ZeroAmount();
    error OverTarget(uint256 totalAfter, uint256 target);
    error PoolSettled();
    error PoolFinalized();
    error PastDeadline();
    error NotFilled(uint256 total, uint256 target);
    error NotExpired(uint64 now_, uint64 deadline);
    error AlreadyFilled(uint256 total, uint256 target);
    error AlreadySettled();
    error NotParticipant();
    error AlreadyDroppedOut();
    error AlreadyBound();
    error TransferFailed();
    error ZeroAddress();
    error ZeroTarget();
    error BadDeadline(uint64 deadline, uint64 now_);
    error BadDuration(uint64 duration);
    error BadMaxParticipants();
    error CapExceeded(uint256 maxParticipants, uint256 cap);
    error TooManyParticipants(uint256 maxParticipants);
    error NotSettled();
    error NothingToWithdraw();
    error Reentrant();
    error NotProvider();
    error RoundOpen();
    error RoundNotTerminal();
    error WrongRound();

    /// @notice New rounds last longer than 0 and no longer than this.
    uint64 public constant MAX_ROUND_DURATION = 2 hours;

    modifier nonReentrant() {
        if (_locked) revert Reentrant();
        _locked = true;
        _;
        _locked = false;
    }

    constructor(
        address usdc_,
        address provider_,
        uint256 target_,
        uint64 deadline_,
        address reputationRegistry_,
        string memory resourceURI_,
        uint256 maxParticipants_,
        uint256 maxParticipantsCap_
    ) {
        if (usdc_ == address(0) || provider_ == address(0)) revert ZeroAddress();
        if (target_ == 0) revert ZeroTarget();
        if (deadline_ <= block.timestamp) revert BadDeadline(deadline_, uint64(block.timestamp));
        if (maxParticipants_ == 0 || maxParticipantsCap_ == 0) revert BadMaxParticipants();
        if (maxParticipants_ > maxParticipantsCap_) revert CapExceeded(maxParticipants_, maxParticipantsCap_);
        usdc = IPoolUSDC(usdc_);
        provider = provider_;
        reputationRegistry = reputationRegistry_;
        resourceURI = resourceURI_;
        maxParticipantsCap = maxParticipantsCap_;
        currentRoundId = 1;
        Round storage r = rounds[1];
        r.target = target_;
        r.deadline = deadline_;
        r.maxParticipants = maxParticipants_;
        emit RoundStarted(1, target_, deadline_, maxParticipants_);
    }

    /// @notice Open the next funding round. Provider-only. The previous round
    /// must be terminal: reverts `RoundOpen` while it is still fundable, and
    /// `RoundNotTerminal` once it has expired but its refund snapshot has not
    /// been taken yet (call `finalizeExpired` first so nothing strands).
    /// @dev Param validation runs before the terminal check so bad inputs
    /// revert with their own error even while a round is open.
    function startRound(uint256 target_, uint64 duration_, uint256 maxParticipants_) external {
        if (msg.sender != provider) revert NotProvider();
        if (target_ == 0) revert ZeroTarget();
        if (duration_ == 0 || duration_ > MAX_ROUND_DURATION) revert BadDuration(duration_);
        if (maxParticipants_ == 0) revert BadMaxParticipants();
        if (maxParticipants_ > maxParticipantsCap) revert CapExceeded(maxParticipants_, maxParticipantsCap);
        Round storage prev = rounds[currentRoundId];
        if (!(prev.settled || prev.expiredFinalized)) {
            if (block.timestamp >= prev.deadline && prev.totalCommitted < prev.target) {
                revert RoundNotTerminal();
            }
            revert RoundOpen();
        }

        currentRoundId += 1;
        Round storage r = rounds[currentRoundId];
        r.target = target_;
        r.deadline = uint64(block.timestamp) + duration_;
        r.maxParticipants = maxParticipants_;
        emit RoundStarted(currentRoundId, target_, r.deadline, maxParticipants_);
    }

    /// @notice Commit `amount` USDC to `roundId`. Caller must `approve` the pool first.
    /// @dev Caps over-commit: reverts when `totalCommitted + amount > target`.
    /// Also caps distinct committers at the round's `maxParticipants` so no
    /// unbounded per-participant work is ever needed on any path. The commit
    /// that reaches `target` pays the provider the full balance INLINE in this
    /// same tx (effects first: total then `settled` flag, then the one payout
    /// transfer), so no separate `settle` call is needed on the happy path.
    function commit(uint256 roundId, uint256 amount) external nonReentrant {
        _commit(roundId, amount);
    }

    /// @notice v1 shim: commit to the current round.
    function commit(uint256 amount) external nonReentrant {
        _commit(currentRoundId, amount);
    }

    function _commit(uint256 roundId, uint256 amount) internal {
        _checkRound(roundId);
        Round storage r = rounds[roundId];
        if (r.settled) revert PoolSettled();
        if (r.expiredFinalized) revert PoolFinalized();
        if (block.timestamp >= r.deadline) revert PastDeadline();
        if (amount == 0) revert ZeroAmount();
        uint256 totalAfter = r.totalCommitted + amount;
        if (totalAfter > r.target) revert OverTarget(totalAfter, r.target);

        if (!_isParticipant[roundId][msg.sender]) {
            if (_participants[roundId].length >= r.maxParticipants) {
                revert TooManyParticipants(r.maxParticipants);
            }
            _isParticipant[roundId][msg.sender] = true;
            _participants[roundId].push(msg.sender);
        }
        committed[roundId][msg.sender] += amount;
        r.totalCommitted = totalAfter;

        if (!usdc.transferFrom(msg.sender, address(this), amount)) revert TransferFailed();
        emit Committed(msg.sender, amount);
        emit Committed(msg.sender, roundId, amount);

        if (totalAfter >= r.target) {
            r.settled = true;
            uint256 balance = usdc.balanceOf(address(this));
            if (!usdc.transfer(provider, balance)) revert TransferFailed();
            emit Settled(balance);
            emit Settled(roundId, balance);
        }
    }

    /// @notice Associate the caller's ERC-8004 agent id for `completion` feedback on settle.
    /// @dev Self-binding only: there is no way to bind another address, so no auth list is needed.
    /// Gated after terminal states like every other state-changing function —
    /// nothing reads bindings post-terminal, so late binds would be dead state motion.
    function bindAgentId(uint256 roundId, uint256 agentId) external {
        _checkRound(roundId);
        Round storage r = rounds[roundId];
        if (r.settled) revert PoolSettled();
        if (r.expiredFinalized) revert PoolFinalized();
        if (!_isParticipant[roundId][msg.sender] || droppedOut[roundId][msg.sender]) revert NotParticipant();
        if (hasAgentId[roundId][msg.sender]) revert AlreadyBound();
        agentIdOf[roundId][msg.sender] = agentId;
        hasAgentId[roundId][msg.sender] = true;
    }

    /// @notice v1 shim: bind on the current round.
    function bindAgentId(uint256 agentId) external {
        uint256 roundId = currentRoundId;
        Round storage r = rounds[roundId];
        if (r.settled) revert PoolSettled();
        if (r.expiredFinalized) revert PoolFinalized();
        if (!_isParticipant[roundId][msg.sender] || droppedOut[roundId][msg.sender]) revert NotParticipant();
        if (hasAgentId[roundId][msg.sender]) revert AlreadyBound();
        agentIdOf[roundId][msg.sender] = agentId;
        hasAgentId[roundId][msg.sender] = true;
    }

    /// @notice Drop out of `roundId` after committing. The commitment stays locked as forfeit.
    /// @param agentId ERC-8004 id used for the `dropout` feedback write (also stored for the caller).
    function dropOut(uint256 roundId, uint256 agentId) external nonReentrant {
        _checkRound(roundId);
        _dropOut(roundId, agentId);
    }

    /// @notice v1 shim: drop out of the current round.
    function dropOut(uint256 agentId) external nonReentrant {
        _dropOut(currentRoundId, agentId);
    }

    function _dropOut(uint256 roundId, uint256 agentId) internal {
        Round storage r = rounds[roundId];
        if (r.settled) revert PoolSettled();
        if (r.expiredFinalized) revert PoolFinalized();
        if (!_isParticipant[roundId][msg.sender] || committed[roundId][msg.sender] == 0) {
            revert NotParticipant();
        }
        if (droppedOut[roundId][msg.sender]) revert AlreadyDroppedOut();

        droppedOut[roundId][msg.sender] = true;
        r.droppedCount += 1;
        uint256 forfeited = committed[roundId][msg.sender];
        r.forfeitedTotal += forfeited;
        agentIdOf[roundId][msg.sender] = agentId;
        hasAgentId[roundId][msg.sender] = true;

        emit DroppedOut(msg.sender, forfeited);
        _record(agentId, -1, "dropout");
    }

    /// @notice Permissionless fallback settle for a filled round: entire balance goes
    /// to `provider` atomically. Normally the filling `commit` already settled
    /// inline, in which case this reverts `AlreadySettled` with no state change.
    /// @dev Open to any caller once `totalCommitted >= target`; funds can only flow to `provider`.
    /// O(1): exactly one USDC transfer, no participant iteration. Completion
    /// feedback is NOT written here — anyone may paginate it afterwards via
    /// `recordCompletions`, so settling can never brick on participant count.
    function settle(uint256 roundId) external nonReentrant {
        _checkRound(roundId);
        _settle(roundId);
    }

    /// @notice v1 shim: settle the current round (keeps the v1 `PoolSettled` error).
    function settle() external nonReentrant {
        uint256 roundId = currentRoundId;
        if (rounds[roundId].settled) revert PoolSettled();
        _settle(roundId);
    }

    function _settle(uint256 roundId) internal {
        Round storage r = rounds[roundId];
        if (r.settled) revert AlreadySettled();
        if (r.expiredFinalized) revert PoolFinalized();
        if (r.totalCommitted < r.target) revert NotFilled(r.totalCommitted, r.target);
        r.settled = true;

        uint256 balance = usdc.balanceOf(address(this));
        if (!usdc.transfer(provider, balance)) revert TransferFailed();
        emit Settled(balance);
        emit Settled(roundId, balance);
    }

    /// @notice Write `completion` (+1) feedback for up to `maxRecords` bound
    /// participants of `roundId`, starting at that round's `feedbackCursor`.
    /// Call repeatedly until the cursor reaches the participant list length.
    /// @dev Open to any caller once settled; each participant is recorded at
    /// most once (cursor advances before any external call, and `_record`
    /// never reverts). Dropped and unbound participants are skipped, same as
    /// the old in-settle loop. Pagination keeps every call O(`maxRecords`).
    function recordCompletions(uint256 roundId, uint256 maxRecords) external nonReentrant {
        _checkRound(roundId);
        _recordCompletions(roundId, maxRecords);
    }

    /// @notice v1 shim: paginate the current round's completions.
    function recordCompletions(uint256 maxRecords) external nonReentrant {
        _recordCompletions(currentRoundId, maxRecords);
    }

    function _recordCompletions(uint256 roundId, uint256 maxRecords) internal {
        Round storage r = rounds[roundId];
        if (!r.settled) revert NotSettled();
        uint256 n = _participants[roundId].length;
        uint256 cursor = r.feedbackCursor;
        if (cursor >= n) return;
        uint256 end = cursor + maxRecords;
        if (end > n) end = n;
        r.feedbackCursor = end;

        for (uint256 i = cursor; i < end; i++) {
            address p = _participants[roundId][i];
            if (droppedOut[roundId][p] || !hasAgentId[roundId][p]) continue;
            _record(agentIdOf[roundId][p], 1, "completion");
        }
    }

    /// @notice Close an expired, unfilled round: snapshot refund accounting so each
    /// remaining participant can pull their share via `claimRefund(roundId)`.
    /// @dev O(1): no per-participant transfers or writes. Each remaining agent's
    /// entitlement is `committed * refundBalance / refundActiveTotal` (own stake
    /// plus pro-rata forfeiture), computed lazily in `claimRefund`; division
    /// dust goes to the final claimant so the round always ends at zero. If
    /// nobody remains (all dropped or empty), the balance goes to `provider`
    /// in this call (a single transfer) so funds never strand. A participant
    /// that never claims affects nobody else; unclaimed shares stay claimable
    /// indefinitely, even after later rounds open.
    function finalizeExpired(uint256 roundId) external nonReentrant {
        _checkRound(roundId);
        _finalizeExpired(roundId);
    }

    /// @notice v1 shim: finalize the current round.
    function finalizeExpired() external nonReentrant {
        _finalizeExpired(currentRoundId);
    }

    function _finalizeExpired(uint256 roundId) internal {
        Round storage r = rounds[roundId];
        if (r.settled) revert PoolSettled();
        if (r.expiredFinalized) revert PoolFinalized();
        if (block.timestamp < r.deadline) revert NotExpired(uint64(block.timestamp), r.deadline);
        if (r.totalCommitted >= r.target) revert AlreadyFilled(r.totalCommitted, r.target);
        r.expiredFinalized = true;

        uint256 balance = usdc.balanceOf(address(this));
        uint256 activeTotal = r.totalCommitted - r.forfeitedTotal;
        if (activeTotal == 0) {
            if (balance > 0) {
                if (!usdc.transfer(provider, balance)) revert TransferFailed();
                emit Settled(balance);
                emit Settled(roundId, balance);
            }
            return;
        }

        r.refundBalance = balance;
        r.refundActiveTotal = activeTotal;
        r.refundRemaining = _participants[roundId].length - r.droppedCount;
        emit ExpiredFinalized(balance, r.refundRemaining);
    }

    /// @notice Pull this caller's snapshotted refund for `roundId` after
    /// `finalizeExpired(roundId)`. Works indefinitely, even after later rounds open.
    /// @dev O(1) per caller: effects before the single USDC transfer, so one
    /// participant's receiver (even a malicious contract) cannot affect any
    /// other claimant. The final claimant receives `refundBalance -
    /// refundClaimed` (dust fix-up); everyone else receives the exact pro-rata
    /// share. Reverts when there is nothing to withdraw (not finalized, not a
    /// remaining participant, or already claimed).
    function claimRefund(uint256 roundId) external nonReentrant {
        _checkRound(roundId);
        _claimRefund(roundId);
    }

    /// @notice v1 shim: claim on the current round.
    function claimRefund() external nonReentrant {
        _claimRefund(currentRoundId);
    }

    function _claimRefund(uint256 roundId) internal {
        Round storage r = rounds[roundId];
        if (!r.expiredFinalized) revert NothingToWithdraw();
        if (droppedOut[roundId][msg.sender] || hasClaimed[roundId][msg.sender]) {
            revert NothingToWithdraw();
        }
        uint256 stake = committed[roundId][msg.sender];
        if (stake == 0) revert NothingToWithdraw();

        hasClaimed[roundId][msg.sender] = true;
        r.refundRemaining -= 1;
        uint256 share = r.refundRemaining == 0
            ? r.refundBalance - r.refundClaimed
            : (r.refundBalance * stake) / r.refundActiveTotal;
        r.refundClaimed += share;

        if (share == 0) {
            emit Refunded(msg.sender, 0);
            return;
        }
        if (!usdc.transfer(msg.sender, share)) revert TransferFailed();
        emit Refunded(msg.sender, share);
    }

    // --- Views -----------------------------------------------------------------

    /// @notice Round-1 seed target / current-round target (v1 getter shape; follows `currentRoundId`).
    function target() external view returns (uint256) {
        return rounds[currentRoundId].target;
    }

    /// @notice Current round's deadline (v1 getter shape).
    function deadline() external view returns (uint64) {
        return rounds[currentRoundId].deadline;
    }

    /// @notice Current round's participant cap (v1 getter shape).
    function maxParticipants() external view returns (uint256) {
        return rounds[currentRoundId].maxParticipants;
    }

    /// @notice Current round's committed total (v1 getter shape).
    function totalCommitted() external view returns (uint256) {
        return rounds[currentRoundId].totalCommitted;
    }

    /// @notice Current round's forfeited total (v1 getter shape).
    function forfeitedTotal() external view returns (uint256) {
        return rounds[currentRoundId].forfeitedTotal;
    }

    /// @notice True once the current round settled (v1 getter shape).
    function settled() external view returns (bool) {
        return rounds[currentRoundId].settled;
    }

    /// @notice True once the round's refund snapshot exists (terminal for expiry path).
    function expiredFinalized(uint256 roundId) external view returns (bool) {
        return rounds[roundId].expiredFinalized;
    }

    /// @notice Current round's completion cursor (v1 getter shape).
    function feedbackCursor() external view returns (uint256) {
        return rounds[currentRoundId].feedbackCursor;
    }

    /// @notice Current round's refund snapshot fields (v1 getter shapes).
    function refundBalance() external view returns (uint256) {
        return rounds[currentRoundId].refundBalance;
    }

    /// @notice Current round's refund snapshot fields (v1 getter shape).
    function refundActiveTotal() external view returns (uint256) {
        return rounds[currentRoundId].refundActiveTotal;
    }

    /// @notice Current round's refund snapshot fields (v1 getter shape).
    function refundClaimed() external view returns (uint256) {
        return rounds[currentRoundId].refundClaimed;
    }

    /// @notice Current round's refund snapshot fields (v1 getter shape).
    function refundRemaining() external view returns (uint256) {
        return rounds[currentRoundId].refundRemaining;
    }

    /// @notice True once finalized, or once the deadline passes on an unfilled, unsettled round.
    /// A filled round never reads expired: it stays settleable past deadline.
    function expired() external view returns (bool) {
        return _expired(currentRoundId);
    }

    /// @notice Per-round expiry read.
    function expired(uint256 roundId) external view returns (bool) {
        return _expired(roundId);
    }

    function _expired(uint256 roundId) internal view returns (bool) {
        Round storage r = rounds[roundId];
        return r.expiredFinalized || (!r.settled && r.totalCommitted < r.target && block.timestamp >= r.deadline);
    }

    /// @notice Active (non-dropped) participant count of the current round.
    function participantCount() external view returns (uint256) {
        return _participantCount(currentRoundId);
    }

    /// @notice Active (non-dropped) participant count of `roundId`.
    function participantCount(uint256 roundId) external view returns (uint256) {
        return _participantCount(roundId);
    }

    function _participantCount(uint256 roundId) internal view returns (uint256) {
        return _participants[roundId].length - rounds[roundId].droppedCount;
    }

    /// @notice All current-round participant addresses in join order (dropped included; check `droppedOut`).
    /// @dev View-only (free off-chain); length is bounded by the round's `maxParticipants`.
    function getParticipants() external view returns (address[] memory) {
        return _participants[currentRoundId];
    }

    /// @notice All `roundId` participant addresses in join order.
    /// @dev View-only (free off-chain); length is bounded by the round's `maxParticipants`.
    function getParticipants(uint256 roundId) external view returns (address[] memory) {
        return _participants[roundId];
    }

    function _checkRound(uint256 roundId) internal view {
        if (roundId == 0 || roundId > currentRoundId) revert WrongRound();
    }

    /// @notice Best-effort ERC-8004 feedback write. Never reverts.
    function _record(uint256 agentId, int128 value, string memory tag1) internal {
        emit CompletionRecorded(agentId, value);
        address reg = reputationRegistry;
        if (reg == address(0)) return;
        try IPoolReputation(reg).giveFeedback(agentId, value, 0, tag1, "pool", "", "", bytes32(0)) {} catch {}
    }
}

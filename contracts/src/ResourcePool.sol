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

/// @title ResourcePool — N-agent threshold pooling for one shared resource.
/// @notice Scope is one pool on one VPS (no factory, no multipool).
/// Agents `approve` USDC then `commit`. At `target`, anyone may `settle` to
/// `provider`. Past `deadline` while unfilled, anyone may `finalizeExpired`,
/// which snapshots each remaining participant's entitlement (own commitment
/// plus a pro-rata share of forfeited collateral) for later `claimRefund`
/// pull-withdrawal. A dropout's funds stay in the pool and count toward
/// `target`: on settle they flow to the provider with everyone else's (the
/// remaining agents split the resource, not the tokens), on expiry they are
/// split pro-rata among the remaining agents. Either way nothing strands.
///
/// `resourceURI` names the shared resource and its terms off-chain (e.g. an
/// IPFS/HTTPS JSON document with VPS specs, cost breakdown, usage rules).
/// Immutable and set at deploy: adding it later would change the constructor
/// and force a redeploy, so it is decided before deploy, not after. Empty
/// string means "no terms published".
///
/// Fund movement is always O(1) per call: `settle` is a single transfer to
/// `provider`, `finalizeExpired` only snapshots accounting, and each
/// participant pulls their own refund via `claimRefund`. Completion feedback
/// is paginated via `recordCompletions` under a cursor. `commit` additionally
/// enforces `maxParticipants`, which bounds the one O(n) view (`getParticipants`)
/// and keeps even off-chain iteration predictable. A participant that never
/// claims does not affect anyone else's claim; unclaimed shares stay
/// claimable indefinitely.
///
/// Objective outcomes are composed into the ERC-8004 ReputationRegistry as
/// feedback (`dropout` = -1, `completion` = +1, tag2 = "pool"). Writes are
/// best-effort: a registry revert never bricks fund movement.
///
/// @dev Function and event names/shapes are frozen to `sdk/src/pool/abi.ts`
/// (`commit`, `dropOut`, `finalizeExpired`, `claimRefund`, `settle`,
/// `recordCompletions`, `target`, `totalCommitted`, `settled`, `expired`,
/// `participantCount`, `Committed`, `Settled`, `ExpiredFinalized`, `Refunded`,
/// `DroppedOut`). `bindAgentId` and `CompletionRecorded` are additive only
/// and invisible to the current SDK.
contract ResourcePool {
    IPoolUSDC public immutable usdc;
    address public immutable provider;
    uint256 public immutable target;
    uint64 public immutable deadline;
    /// @notice ERC-8004 ReputationRegistry. Zero address disables feedback writes (tests).
    address public immutable reputationRegistry;
    /// @notice Off-chain description of the shared resource + participation terms. See above.
    /// @dev Set once in the constructor; there is no setter, so it is
    /// effectively immutable (`immutable` is not allowed for strings).
    string public resourceURI;
    /// @notice Hard cap on distinct committers. Bounds iteration; enforced in `commit`.
    uint256 public immutable maxParticipants;

    mapping(address => uint256) public committed;
    mapping(address => bool) public droppedOut;
    /// @notice ERC-8004 agent id self-bound by each participant; used for feedback writes.
    mapping(address => uint256) public agentIdOf;
    mapping(address => bool) public hasAgentId;

    address[] private _participants;
    mapping(address => bool) private _isParticipant;

    uint256 public totalCommitted;
    uint256 public forfeitedTotal;
    uint256 private _droppedCount;
    bool public settled;
    bool private _expiredFinalized;
    bool private _locked;
    /// @notice Cursor for paginated `recordCompletions` over `_participants` (settle path).
    uint256 public feedbackCursor;
    /// @notice Refund accounting snapshotted by `finalizeExpired` (expiry path).
    uint256 public refundBalance;
    uint256 public refundActiveTotal;
    uint256 public refundClaimed;
    uint256 public refundRemaining;
    mapping(address => bool) public hasClaimed;

    event Committed(address indexed agent, uint256 amount);
    /// @notice Funds left the pool. Fires on `settle` (threshold met) AND on the
    /// `finalizeExpired` all-dropped sweep below — subgraph mappings must treat it
    /// as "funds left", not "threshold met".
    event Settled(uint256 total);
    /// @notice Expiry snapshot taken. Individual payouts follow via `claimRefund`
    /// (`Refunded` per claimant) — subgraph mappings must treat THIS as the
    /// expiry marker, not as funds leaving.
    event ExpiredFinalized(uint256 balance, uint256 claimants);
    event Refunded(address indexed agent, uint256 amount);
    event DroppedOut(address indexed agent, uint256 forfeited);
    /// @notice Additive (not in the SDK placeholder ABI): mirrors each reputation write.
    event CompletionRecorded(uint256 indexed agentId, int128 value);

    error ZeroAmount();
    error OverTarget(uint256 totalAfter, uint256 target);
    error PoolSettled();
    error PoolFinalized();
    error PastDeadline();
    error NotFilled(uint256 total, uint256 target);
    error NotExpired(uint64 now_, uint64 deadline);
    error AlreadyFilled(uint256 total, uint256 target);
    error NotParticipant();
    error AlreadyDroppedOut();
    error AlreadyBound();
    error TransferFailed();
    error ZeroAddress();
    error ZeroTarget();
    error BadDeadline(uint64 deadline, uint64 now_);
    error BadMaxParticipants();
    error TooManyParticipants(uint256 maxParticipants);
    error NotSettled();
    error NothingToWithdraw();
    error Reentrant();

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
        uint256 maxParticipants_
    ) {
        if (usdc_ == address(0) || provider_ == address(0)) revert ZeroAddress();
        if (target_ == 0) revert ZeroTarget();
        if (deadline_ <= block.timestamp) revert BadDeadline(deadline_, uint64(block.timestamp));
        if (maxParticipants_ == 0) revert BadMaxParticipants();
        usdc = IPoolUSDC(usdc_);
        provider = provider_;
        target = target_;
        deadline = deadline_;
        reputationRegistry = reputationRegistry_;
        resourceURI = resourceURI_;
        maxParticipants = maxParticipants_;
    }

    /// @notice Commit `amount` USDC. Caller must `approve` the pool first.
    /// @dev Caps over-commit: reverts when `totalCommitted + amount > target`.
    /// Also caps distinct committers at `maxParticipants` so no unbounded
    /// per-participant work is ever needed on any path.
    function commit(uint256 amount) external nonReentrant {
        if (settled) revert PoolSettled();
        if (_expiredFinalized) revert PoolFinalized();
        if (block.timestamp >= deadline) revert PastDeadline();
        if (amount == 0) revert ZeroAmount();
        uint256 totalAfter = totalCommitted + amount;
        if (totalAfter > target) revert OverTarget(totalAfter, target);

        if (!_isParticipant[msg.sender]) {
            if (_participants.length >= maxParticipants) revert TooManyParticipants(maxParticipants);
            _isParticipant[msg.sender] = true;
            _participants.push(msg.sender);
        }
        committed[msg.sender] += amount;
        totalCommitted = totalAfter;

        if (!usdc.transferFrom(msg.sender, address(this), amount)) revert TransferFailed();
        emit Committed(msg.sender, amount);
    }

    /// @notice Associate the caller's ERC-8004 agent id for `completion` feedback on settle.
    /// @dev Self-binding only: there is no way to bind another address, so no auth list is needed.
    /// Gated after terminal states like every other state-changing function —
    /// nothing reads bindings post-terminal, so late binds would be dead state motion.
    function bindAgentId(uint256 agentId) external {
        if (settled) revert PoolSettled();
        if (_expiredFinalized) revert PoolFinalized();
        if (!_isParticipant[msg.sender] || droppedOut[msg.sender]) revert NotParticipant();
        if (hasAgentId[msg.sender]) revert AlreadyBound();
        agentIdOf[msg.sender] = agentId;
        hasAgentId[msg.sender] = true;
    }

    /// @notice Drop out after committing. The commitment stays locked as forfeit.
    /// @param agentId ERC-8004 id used for the `dropout` feedback write (also stored for the caller).
    function dropOut(uint256 agentId) external nonReentrant {
        if (settled) revert PoolSettled();
        if (_expiredFinalized) revert PoolFinalized();
        if (!_isParticipant[msg.sender] || committed[msg.sender] == 0) revert NotParticipant();
        if (droppedOut[msg.sender]) revert AlreadyDroppedOut();

        droppedOut[msg.sender] = true;
        _droppedCount += 1;
        uint256 forfeited = committed[msg.sender];
        forfeitedTotal += forfeited;
        agentIdOf[msg.sender] = agentId;
        hasAgentId[msg.sender] = true;

        emit DroppedOut(msg.sender, forfeited);
        _record(agentId, -1, "dropout");
    }

    /// @notice Settle a filled pool: entire balance goes to `provider` atomically.
    /// @dev Open to any caller once `totalCommitted >= target`; funds can only flow to `provider`.
    /// O(1): exactly one USDC transfer, no participant iteration. Completion
    /// feedback is NOT written here — anyone may paginate it afterwards via
    /// `recordCompletions`, so settling can never brick on participant count.
    function settle() external nonReentrant {
        if (settled) revert PoolSettled();
        if (_expiredFinalized) revert PoolFinalized();
        if (totalCommitted < target) revert NotFilled(totalCommitted, target);
        settled = true;

        uint256 balance = usdc.balanceOf(address(this));
        if (!usdc.transfer(provider, balance)) revert TransferFailed();
        emit Settled(balance);
    }

    /// @notice Write `completion` (+1) feedback for up to `maxRecords` bound
    /// participants, starting at `feedbackCursor`. Call repeatedly until
    /// `feedbackCursor == participant list length`.
    /// @dev Open to any caller once settled; each participant is recorded at
    /// most once (cursor advances before any external call, and `_record`
    /// never reverts). Dropped and unbound participants are skipped, same as
    /// the old in-settle loop. Pagination keeps every call O(`maxRecords`).
    function recordCompletions(uint256 maxRecords) external nonReentrant {
        if (!settled) revert NotSettled();
        uint256 n = _participants.length;
        uint256 cursor = feedbackCursor;
        if (cursor >= n) return;
        uint256 end = cursor + maxRecords;
        if (end > n) end = n;
        feedbackCursor = end;

        for (uint256 i = cursor; i < end; i++) {
            address p = _participants[i];
            if (droppedOut[p] || !hasAgentId[p]) continue;
            _record(agentIdOf[p], 1, "completion");
        }
    }

    /// @notice Close an expired, unfilled pool: snapshot refund accounting so each
    /// remaining participant can pull their share via `claimRefund`.
    /// @dev O(1): no per-participant transfers or writes. Each remaining agent's
    /// entitlement is `committed * refundBalance / refundActiveTotal` (own stake
    /// plus pro-rata forfeiture), computed lazily in `claimRefund`; division
    /// dust goes to the final claimant so the pool always ends at zero. If
    /// nobody remains (all dropped or empty), the balance goes to `provider`
    /// in this call (a single transfer) so funds never strand. A participant
    /// that never claims affects nobody else; unclaimed shares stay claimable
    /// indefinitely.
    function finalizeExpired() external nonReentrant {
        if (settled) revert PoolSettled();
        if (_expiredFinalized) revert PoolFinalized();
        if (block.timestamp < deadline) revert NotExpired(uint64(block.timestamp), deadline);
        if (totalCommitted >= target) revert AlreadyFilled(totalCommitted, target);
        _expiredFinalized = true;

        uint256 balance = usdc.balanceOf(address(this));
        uint256 activeTotal = totalCommitted - forfeitedTotal;
        if (activeTotal == 0) {
            if (balance > 0) {
                if (!usdc.transfer(provider, balance)) revert TransferFailed();
                emit Settled(balance);
            }
            return;
        }

        refundBalance = balance;
        refundActiveTotal = activeTotal;
        refundRemaining = _participants.length - _droppedCount;
        emit ExpiredFinalized(balance, refundRemaining);
    }

    /// @notice Pull this caller's snapshotted refund after `finalizeExpired`.
    /// @dev O(1) per caller: effects before the single USDC transfer, so one
    /// participant's receiver (even a malicious contract) cannot affect any
    /// other claimant. The final claimant receives `refundBalance -
    /// refundClaimed` (dust fix-up); everyone else receives the exact pro-rata
    /// share. Reverts when there is nothing to withdraw (not finalized, not a
    /// remaining participant, or already claimed).
    function claimRefund() external nonReentrant {
        if (!_expiredFinalized) revert NothingToWithdraw();
        if (droppedOut[msg.sender] || hasClaimed[msg.sender]) revert NothingToWithdraw();
        uint256 stake = committed[msg.sender];
        if (stake == 0) revert NothingToWithdraw();

        hasClaimed[msg.sender] = true;
        refundRemaining -= 1;
        uint256 share = refundRemaining == 0
            ? refundBalance - refundClaimed
            : (refundBalance * stake) / refundActiveTotal;
        refundClaimed += share;

        if (share == 0) {
            emit Refunded(msg.sender, 0);
            return;
        }
        if (!usdc.transfer(msg.sender, share)) revert TransferFailed();
        emit Refunded(msg.sender, share);
    }

    /// @notice True once finalized, or once the deadline passes on an unfilled, unsettled pool.
    /// A filled pool never reads expired: it stays settleable past deadline.
    function expired() external view returns (bool) {
        return _expiredFinalized || (!settled && totalCommitted < target && block.timestamp >= deadline);
    }

    /// @notice Active (non-dropped) participant count.
    function participantCount() external view returns (uint256) {
        return _participants.length - _droppedCount;
    }

    /// @notice All participant addresses in join order (dropped included; check `droppedOut`).
    /// @dev View-only (free off-chain); length is bounded by `maxParticipants`.
    function getParticipants() external view returns (address[] memory) {
        return _participants;
    }

    /// @notice Best-effort ERC-8004 feedback write. Never reverts.
    function _record(uint256 agentId, int128 value, string memory tag1) internal {
        emit CompletionRecorded(agentId, value);
        address reg = reputationRegistry;
        if (reg == address(0)) return;
        try IPoolReputation(reg).giveFeedback(agentId, value, 0, tag1, "pool", "", "", bytes32(0)) {} catch {}
    }
}

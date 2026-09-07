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
/// which refunds remaining participants their commitment plus a pro-rata share
/// of forfeited collateral. A dropout's funds stay in the pool and count toward
/// `target`: on settle they flow to the provider with everyone else's (the
/// remaining agents split the resource, not the tokens), on refund they are
/// split pro-rata among the remaining agents. Either way nothing strands.
///
/// Objective outcomes are composed into the ERC-8004 ReputationRegistry as
/// feedback (`dropout` = -1, `completion` = +1, tag2 = "pool"). Writes are
/// best-effort: a registry revert never bricks fund movement.
///
/// @dev Function and event names/shapes are frozen to `sdk/src/pool/abi.ts`
/// (`commit`, `dropOut`, `finalizeExpired`, `settle`, `target`,
/// `totalCommitted`, `settled`, `expired`, `participantCount`, `Committed`,
/// `Settled`, `Refunded`, `DroppedOut`). `bindAgentId` and
/// `CompletionRecorded` are additive only and invisible to the current SDK.
contract ResourcePool {
    IPoolUSDC public immutable usdc;
    address public immutable provider;
    uint256 public immutable target;
    uint64 public immutable deadline;
    /// @notice ERC-8004 ReputationRegistry. Zero address disables feedback writes (tests).
    address public immutable reputationRegistry;

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

    event Committed(address indexed agent, uint256 amount);
    /// @notice Funds left the pool. Fires on `settle` (threshold met) AND on the
    /// `finalizeExpired` all-dropped sweep below — subgraph mappings must treat it
    /// as "funds left", not "threshold met".
    event Settled(uint256 total);
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
    error Reentrant();

    modifier nonReentrant() {
        if (_locked) revert Reentrant();
        _locked = true;
        _;
        _locked = false;
    }

    constructor(address usdc_, address provider_, uint256 target_, uint64 deadline_, address reputationRegistry_) {
        if (usdc_ == address(0) || provider_ == address(0)) revert ZeroAddress();
        if (target_ == 0) revert ZeroTarget();
        if (deadline_ <= block.timestamp) revert BadDeadline(deadline_, uint64(block.timestamp));
        usdc = IPoolUSDC(usdc_);
        provider = provider_;
        target = target_;
        deadline = deadline_;
        reputationRegistry = reputationRegistry_;
    }

    /// @notice Commit `amount` USDC. Caller must `approve` the pool first.
    /// @dev Caps over-commit: reverts when `totalCommitted + amount > target`.
    function commit(uint256 amount) external nonReentrant {
        if (settled) revert PoolSettled();
        if (_expiredFinalized) revert PoolFinalized();
        if (block.timestamp >= deadline) revert PastDeadline();
        if (amount == 0) revert ZeroAmount();
        uint256 totalAfter = totalCommitted + amount;
        if (totalAfter > target) revert OverTarget(totalAfter, target);

        if (!_isParticipant[msg.sender]) {
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
    /// KNOWN LIMITATION (testnet-acceptable, mainnet-blocking): the completion-feedback
    /// loop below is O(n) over an unbounded participant array, and `finalizeExpired`
    /// additionally pushes one USDC transfer per participant in-loop. At demo scale
    /// (single-digit agents) this is fine; at hundreds of agents either call can
    /// exceed block gas and brick funds with no recovery path, and a malicious
    /// participant contract with an expensive fallback can grief the whole refund.
    /// Before anything mainnet-adjacent: switch to pull-pattern withdrawals or
    /// paginated settlement. No participant cap is enforced — keep demo pools small.
    function settle() external nonReentrant {
        if (settled) revert PoolSettled();
        if (_expiredFinalized) revert PoolFinalized();
        if (totalCommitted < target) revert NotFilled(totalCommitted, target);
        settled = true;

        uint256 balance = usdc.balanceOf(address(this));
        if (!usdc.transfer(provider, balance)) revert TransferFailed();
        emit Settled(balance);

        uint256 n = _participants.length;
        for (uint256 i = 0; i < n; i++) {
            address p = _participants[i];
            if (droppedOut[p] || !hasAgentId[p]) continue;
            _record(agentIdOf[p], 1, "completion");
        }
    }

    /// @notice Close an expired, unfilled pool and push refunds to remaining participants.
    /// @dev Each remaining agent receives `committed * balance / activeTotal`
    /// (own stake plus pro-rata forfeiture). Division dust goes to the last
    /// payee so the pool always ends at zero. If nobody remains (all dropped
    /// or empty), the balance goes to `provider` so funds never strand.
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

        uint256 paid = 0;
        address last;
        uint256 n = _participants.length;
        for (uint256 i = 0; i < n; i++) {
            if (!droppedOut[_participants[i]] && committed[_participants[i]] > 0) {
                last = _participants[i];
            }
        }
        for (uint256 i = 0; i < n; i++) {
            address p = _participants[i];
            if (droppedOut[p]) continue;
            uint256 stake = committed[p];
            if (stake == 0) continue;
            uint256 share = p == last ? balance - paid : (balance * stake) / activeTotal;
            paid += share;
            if (share == 0) continue;
            if (!usdc.transfer(p, share)) revert TransferFailed();
            emit Refunded(p, share);
        }
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

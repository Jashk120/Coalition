package settle

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"math"
	"math/big"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/Jashk120/Coalition/orchestrator/internal/store"
)

var errParticipants = errors.New("settle: invalid split inputs")

// errRPC is returned when the JSON-RPC endpoint answers with an error object.
var errRPC = errors.New("settle: rpc error")

// settledSelector is keccak256("Settled(uint256)"), the pool's terminal event.
// Derived with `cast keccak "Settled(uint256)"` (0xcc31...b2ad). Keccak differs
// from NIST SHA3, so stdlib crypto/sha3 cannot reproduce it; the precomputed
// constant keeps the module dependency-free and is verifiable with one cast call.
const settledSelector = "0xcc3183593ff0e17b930d6f19f832ddcf865bf7ef55eb16754850c55ac447b2ad"

// totalCommittedSelector is the first 4 bytes of keccak256("totalCommitted()").
// Derived with `cast keccak "totalCommitted()"` (0x1d3231d4...). Keccak differs
// from NIST SHA3, so stdlib crypto/sha3 cannot reproduce it; the precomputed
// constant keeps the module dependency-free and is verifiable with one cast call.
const totalCommittedSelector = "0x1d3231d4"

// settledSelectorView is the first 4 bytes of keccak256("settled()"), the
// auto-generated getter for the pool's `bool public settled` flag.
const settledSelectorView = "0x8f775839"

// expiredSelectorView is the first 4 bytes of keccak256("expired()"), the
// pool's funding-window expiry view.
const expiredSelectorView = "0x4c2067c7"

// roundStartedSelector is keccak256("RoundStarted(uint256,uint256,uint64,uint256)"),
// the v2 pool's round-open event. Round ids ride topics[1] (indexed); target,
// deadline, and maxParticipants ride the data words in order.
// Derived with `cast keccak "RoundStarted(uint256,uint256,uint64,uint256)"`.
const roundStartedSelector = "0x034cf9cb7bf3a1bcfb361d696f0639e27528bfd9493427d973b377b04e638360"

// settledV2Selector is keccak256("Settled(uint256,uint256)"), the v2 pool's
// round-scoped terminal event. The round id rides topics[1] (indexed); the
// payout total rides data. The legacy Settled(uint256) fires alongside it in
// the same transaction, so a v1 listener still sees funds leave.
// Derived with `cast keccak "Settled(uint256,uint256)"`.
const settledV2Selector = "0xf5b268a3ff315cc44ccceeef86259c9e8eef81ceecb14001543809115380dd62"

// currentRoundIdSelector is the first 4 bytes of keccak256("currentRoundId()").
// Derived with `cast sig "currentRoundId()"`.
const currentRoundIdSelector = "0x9cbe5efd"

// roundsSelector is the first 4 bytes of keccak256("rounds(uint256)"), the
// auto-generated getter for the v2 pool's per-round accounting tuple.
// Derived with `cast sig "rounds(uint256)"`.
const roundsSelector = "0x8c65c81f"

// expiredAtSelector is the first 4 bytes of keccak256("expired(uint256)"),
// the v2 pool's per-round expiry view.
// Derived with `cast sig "expired(uint256)"`.
const expiredAtSelector = "0xba065e1f"

// participantCountAtSelector is the first 4 bytes of
// keccak256("participantCount(uint256)"), the v2 pool's per-round active
// participant count view.
const participantCountAtSelector = "0x0d1df8d0"

// committedSelector is the first 4 bytes of
// keccak256("committed(uint256,address)"), the auto-generated getter for the
// v2 pool's per-round per-wallet stake mapping. A nonzero answer is the
// chain proof that a wallet funded a round.
// Derived with `cast sig "committed(uint256,address)"`.
const committedSelector = "0xb29d3b09"

// Listener polls eth_getLogs for POOL_ADDRESS on a time.Ticker. The filter pins
// topics[0] to the Settled selector, so only the terminal event matches.
// Before flipping the ledger it verifies on-chain funding via eth_call
// totalCommitted() >= the configured target: a Settled log alone never flips.
//
// With WithV2Pool the same poller additionally tracks the v2 round-scoped
// pool: RoundStarted logs (and the currentRoundId view) advance the tracked
// round, Settled(roundId,total) logs flip only their own round's ledger entry
// after a per-round chain gate (rounds(roundId).totalCommitted >=
// rounds(roundId).target), and every poll re-evaluates that gate from chain
// state so a top-up with no new event still flips. The v1 flow is untouched:
// the legacy Settled(uint256) still drives the global ledger flag.
type Listener struct {
	rpcURL   string
	pool     string
	interval time.Duration
	ledger   *store.Store
	logger   *slog.Logger
	client   *http.Client

	targetAtomic  *big.Int
	confirmations uint64

	v2pool       string
	views        *Client
	trackedRound *big.Int
	roundCursors map[string]string

	mu        sync.Mutex
	lastBlock string
}

// ListenerOption tunes optional Listener behavior; zero options keep the
// legacy log-only flip used by unit tests that stub no commitment view.
type ListenerOption func(*Listener)

// WithCommitmentTarget requires totalCommitted() >= target before MarkSettled.
func WithCommitmentTarget(target *big.Int) ListenerOption {
	return func(l *Listener) { l.targetAtomic = target }
}

// WithConfirmations requires logs and receipts to be at least n blocks deep
// before they count. Values < 1 are normalized to 1.
func WithConfirmations(n uint64) ListenerOption {
	return func(l *Listener) {
		if n < 1 {
			n = 1
		}
		l.confirmations = n
	}
}

// WithV2Pool enables round-scoped tracking for the v2 pool address. Empty
// keeps the legacy v1-only behavior. The listener stays read-only: no keys,
// no signing.
func WithV2Pool(pool string) ListenerOption {
	return func(l *Listener) { l.v2pool = pool }
}

// NewListener builds a poller. Disable by not constructing (empty POOL_ADDRESS).
// The cursor boots at "latest": on restart only new blocks are scanned, never
// a genesis rescan.
func NewListener(rpcURL, pool string, interval time.Duration, ledger *store.Store, logger *slog.Logger, opts ...ListenerOption) *Listener {
	l := &Listener{
		rpcURL:        rpcURL,
		pool:          pool,
		interval:      interval,
		ledger:        ledger,
		logger:        logger,
		client:        &http.Client{Timeout: 15 * time.Second},
		views:         NewClient(rpcURL),
		roundCursors:  make(map[string]string),
		lastBlock:     "latest",
		confirmations: 1,
	}
	for _, opt := range opts {
		opt(l)
	}
	if l.confirmations < 1 {
		l.confirmations = 1
	}
	return l
}

// Run polls every tick until ctx is cancelled, then returns nil. It spawns no
// goroutines of its own, so cancellation leaks nothing; the ticker is stopped
// by defer. Polling continues harmlessly after settle: the ledger flip is
// idempotent and the transition is logged exactly once.
func (l *Listener) Run(ctx context.Context) error {
	ticker := time.NewTicker(l.interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return nil
		case <-ticker.C:
			first, err := l.Check(ctx)
			if err != nil {
				l.logger.Warn("settle-poll-failed", slog.Any("err", err))
				continue
			}
			if first {
				l.logger.Info("settled-detected", slog.String("pool", l.pool))
			}
		}
	}
}

// Check performs one poll round across the v1 pool and, when configured,
// the v2 round-scoped pool. It reports whether this call transitioned either
// ledger. An empty v1 pool address skips the legacy flow (v2-only mode);
// when the v1 pool address equals the v2 pool address (case-insensitive,
// same contract) the legacy flow is also skipped: the v1 settled() getter
// mirrors the current round and its Settled(uint256) log fires alongside the
// v2 Settled(uint256,uint256), so the legacy gate/log scan would flip the
// permanent v1 settled flag on a shared address and pin FundingClosed() true
// forever across rotates. Polling continues harmlessly after settle on both.
func (l *Listener) Check(ctx context.Context) (bool, error) {
	latest, err := l.blockNumber(ctx)
	if err != nil {
		return false, err
	}
	flipped := false
	switch {
	case l.pool == "":
	case l.v2pool != "" && strings.EqualFold(l.pool, l.v2pool):
		l.logger.Warn("legacy-skipped-same-as-v2", slog.String("pool", l.pool))
	default:
		flipped, err = l.checkLegacy(ctx, latest)
		if err != nil {
			return flipped, err
		}
	}
	if l.v2pool == "" {
		return flipped, nil
	}
	vflipped, err := l.checkV2(ctx, latest)
	if err != nil {
		return flipped, err
	}
	return flipped || vflipped, nil
}

// checkLegacy is the v1 poll round: it queries logs from the last checked
// block, and flips the ledger on the first sufficiently-confirmed match
// whose on-chain commitment covers the target.
// The cursor never advances past unprocessed logs: on the first
// unmatching or unverifiable log the cursor pins to that log's block so the
// round is retried, and only a fully processed round advances to latest.
// Independently of logs, every poll re-evaluates the funding gate from chain
// state (totalCommitted eth_call), so a top-up that lands after the cursor
// with no new event still flips. It reports whether this call transitioned.
func (l *Listener) checkLegacy(ctx context.Context, latest string) (bool, error) {
	if flipped, err := l.checkChainGate(ctx, latest); err != nil || flipped {
		return flipped, err
	}
	logs, err := l.getLogs(ctx, latest)
	if err != nil {
		return false, err
	}
	confirmed, err := l.confirmedLogs(ctx, logs, latest)
	if err != nil {
		return false, err
	}
	if len(confirmed) == 0 {
		l.setLastBlock(latest)
		return false, nil
	}
	if l.targetAtomic == nil {
		l.setLastBlock(latest)
		return l.ledger.MarkSettled(), nil
	}
	for _, lg := range confirmed {
		committed, err := l.totalCommitted(ctx, latest)
		if err != nil {
			l.pinCursor(lg)
			return false, err
		}
		if committed.Cmp(l.targetAtomic) < 0 {
			l.logger.Warn("settled-log-below-target",
				slog.String("pool", l.pool),
				slog.String("committed", committed.String()),
				slog.String("target", l.targetAtomic.String()))
			l.pinCursor(lg)
			return false, nil
		}
	}
	l.setLastBlock(latest)
	return l.ledger.MarkSettled(), nil
}

// checkChainGate re-evaluates funding from chain state alone: when a target
// is configured and totalCommitted covers it, the ledger flips even with no
// new logs in range. A below-target reading flips nothing and errors nothing.
func (l *Listener) checkChainGate(ctx context.Context, latest string) (bool, error) {
	if l.targetAtomic == nil || l.ledger.IsSettled() {
		return false, nil
	}
	committed, err := l.totalCommitted(ctx, latest)
	if err != nil {
		return false, err
	}
	if committed.Cmp(l.targetAtomic) < 0 {
		return false, nil
	}
	l.setLastBlock(latest)
	return l.ledger.MarkSettled(), nil
}

// checkV2 performs one poll round for the round-scoped pool: reconcile the
// tracked round against currentRoundId, re-evaluate the per-round funding
// gate from chain state, then scan RoundStarted/Settled(roundId,total) logs.
// A RoundStarted for a newer round advances tracking and restarts that
// round's cursor at the event block; a Settled log for the tracked round
// flips only that round's ledger entry after its own chain gate passes. The
// cursor never advances past an unverifiable log: it pins to that log's
// block per round so the round is retried. It reports whether this call
// transitioned.
func (l *Listener) checkV2(ctx context.Context, latest string) (bool, error) {
	tracked := l.trackedV2Round()
	onchain, err := l.views.CurrentRoundId(ctx, l.v2pool, latest)
	if err != nil {
		return false, err
	}
	if onchain == nil || onchain.Sign() < 1 {
		return false, fmt.Errorf("v2 pool %s currentRoundId = %v", l.v2pool, onchain)
	}
	if tracked == nil || onchain.Cmp(tracked) > 0 {
		l.advanceRound(onchain, latest)
		tracked = onchain
	}
	if funded, err := l.roundFunded(ctx, latest, tracked); err != nil || funded {
		if err != nil {
			return false, err
		}
		l.setRoundCursor(tracked, latest)
		return l.ledger.MarkRoundSettled(tracked), nil
	}
	if l.ledger.IsRoundSettled(tracked) {
		l.setRoundCursor(tracked, latest)
		return false, nil
	}
	logs, err := l.getV2Logs(ctx, tracked, latest)
	if err != nil {
		return false, err
	}
	confirmed, err := l.confirmedLogs(ctx, logs, latest)
	if err != nil {
		return false, err
	}
	if len(confirmed) == 0 {
		l.setRoundCursor(tracked, latest)
		return false, nil
	}
	for _, lg := range confirmed {
		roundId, kind, err := parseV2Log(lg)
		if err != nil {
			continue
		}
		switch kind {
		case v2LogRoundStarted:
			if roundId.Cmp(tracked) > 0 {
				l.advanceRound(roundId, logBlock(lg, latest))
				tracked = roundId
			}
		case v2LogSettled:
			if roundId.Cmp(tracked) != 0 {
				continue
			}
			funded, err := l.roundFunded(ctx, latest, tracked)
			if err != nil {
				l.pinRoundCursor(tracked, lg)
				return false, err
			}
			if !funded {
				views, _ := l.views.ReadRoundViews(ctx, l.v2pool, tracked)
				committed, target := "?", "?"
				if views != nil {
					committed, target = views.TotalCommitted.String(), views.Target.String()
				}
				l.logger.Warn("settled-log-below-target",
					slog.String("pool", l.v2pool),
					slog.String("round", tracked.String()),
					slog.String("committed", committed),
					slog.String("target", target))
				l.pinRoundCursor(tracked, lg)
				return false, nil
			}
			l.setRoundCursor(tracked, latest)
			return l.ledger.MarkRoundSettled(tracked), nil
		}
	}
	l.setRoundCursor(tracked, latest)
	return false, nil
}

// roundFunded re-evaluates one round's funding gate from chain state: the
// rounds(roundId) tuple covers its own target, so a top-up with no new event
// still settles. A zero target never counts as funded.
func (l *Listener) roundFunded(ctx context.Context, latest string, roundId *big.Int) (bool, error) {
	views, err := l.views.ReadRoundViews(ctx, l.v2pool, roundId)
	if err != nil {
		return false, err
	}
	if views.Target.Sign() <= 0 {
		return false, nil
	}
	return views.TotalCommitted.Cmp(views.Target) >= 0, nil
}

// v2 log kinds by topics[0].
type v2LogKind int

const (
	v2LogUnknown v2LogKind = iota
	v2LogRoundStarted
	v2LogSettled
)

// parseV2Log decodes a RoundStarted or Settled(roundId,total) log: the kind
// from topics[0], the round id from topics[1] (indexed in both events).
// Anything else is v2LogUnknown with the decode error.
func parseV2Log(lg json.RawMessage) (*big.Int, v2LogKind, error) {
	var entry struct {
		Topics []string `json:"topics"`
	}
	if err := json.Unmarshal(lg, &entry); err != nil {
		return nil, v2LogUnknown, fmt.Errorf("decode v2 log: %w", err)
	}
	if len(entry.Topics) < 2 {
		return nil, v2LogUnknown, fmt.Errorf("v2 log has %d topics, want >= 2", len(entry.Topics))
	}
	var kind v2LogKind
	switch strings.ToLower(entry.Topics[0]) {
	case roundStartedSelector:
		kind = v2LogRoundStarted
	case settledV2Selector:
		kind = v2LogSettled
	default:
		return nil, v2LogUnknown, fmt.Errorf("v2 log topic %q is neither RoundStarted nor Settled", entry.Topics[0])
	}
	roundId, err := parseHexUint(entry.Topics[1])
	if err != nil {
		return nil, v2LogUnknown, fmt.Errorf("decode v2 log round: %w", err)
	}
	return roundId, kind, nil
}

// logBlock returns the log's block number, falling back to latest when the
// log carries none.
func logBlock(lg json.RawMessage, latest string) string {
	var entry struct {
		BlockNumber string `json:"blockNumber"`
	}
	if err := json.Unmarshal(lg, &entry); err != nil || entry.BlockNumber == "" {
		return latest
	}
	return entry.BlockNumber
}

// advanceRound moves tracking to a newer round: the ledger's current round
// follows (which scopes the entitlement allowlist), and the new round's
// cursor restarts at fromBlock so its history is scanned from its start,
// never from genesis and never from the prior round's position.
func (l *Listener) advanceRound(roundId *big.Int, fromBlock string) {
	l.mu.Lock()
	l.trackedRound = new(big.Int).Set(roundId)
	l.roundCursors[roundId.String()] = fromBlock
	l.mu.Unlock()
	l.ledger.SetCurrentRound(roundId)
}

// trackedV2Round returns a copy of the tracked round, or nil before the
// first v2 poll reconciles against currentRoundId.
func (l *Listener) trackedV2Round() *big.Int {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.trackedRound == nil {
		return nil
	}
	return new(big.Int).Set(l.trackedRound)
}

// setRoundCursor advances one round's scan cursor.
func (l *Listener) setRoundCursor(roundId *big.Int, block string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.roundCursors[roundId.String()] = block
}

// pinRoundCursor holds one round's cursor at an unprocessed log's block so
// the next poll retries it instead of skipping ahead.
func (l *Listener) pinRoundCursor(roundId *big.Int, lg json.RawMessage) {
	l.setRoundCursor(roundId, logBlock(lg, l.roundCursorOf(roundId)))
}

// roundCursorOf reads one round's cursor under lock ("latest" before first use).
func (l *Listener) roundCursorOf(roundId *big.Int) string {
	l.mu.Lock()
	defer l.mu.Unlock()
	if cur, ok := l.roundCursors[roundId.String()]; ok && cur != "" {
		return cur
	}
	return "latest"
}

// pinCursor holds the cursor at an unprocessed log's block so the next poll
// retries it instead of skipping ahead.
func (l *Listener) pinCursor(lg json.RawMessage) {
	var entry struct {
		BlockNumber string `json:"blockNumber"`
	}
	if err := json.Unmarshal(lg, &entry); err != nil || entry.BlockNumber == "" {
		return
	}
	l.setLastBlock(entry.BlockNumber)
}

// confirmedLogs keeps only logs at least l.confirmations deep. Logs without a
// parseable block number are dropped: they cannot prove finality.
func (l *Listener) confirmedLogs(ctx context.Context, logs []json.RawMessage, latest string) ([]json.RawMessage, error) {
	_ = ctx
	latestNum, err := parseHexUint(latest)
	if err != nil {
		return nil, fmt.Errorf("decode latest block %q: %w", latest, err)
	}
	var out []json.RawMessage
	for _, lg := range logs {
		var entry struct {
			BlockNumber string `json:"blockNumber"`
		}
		if err := json.Unmarshal(lg, &entry); err != nil || entry.BlockNumber == "" {
			continue
		}
		num, err := parseHexUint(entry.BlockNumber)
		if err != nil {
			continue
		}
		if latestNum.Cmp(num) >= 0 && new(big.Int).Sub(latestNum, num).Uint64()+1 >= l.confirmations {
			out = append(out, lg)
		}
	}
	return out, nil
}

// totalCommitted reads pool.totalCommitted() at block tag via eth_call and
// decodes the uint256 answer.
func (l *Listener) totalCommitted(ctx context.Context, blockTag string) (*big.Int, error) {
	params, err := json.Marshal([]any{
		map[string]string{"to": l.pool, "data": totalCommittedSelector},
		blockTag,
	})
	if err != nil {
		return nil, fmt.Errorf("encode eth_call: %w", err)
	}
	raw, err := l.call(ctx, "eth_call", params)
	if err != nil {
		return nil, err
	}
	var hexStr string
	if err := json.Unmarshal(raw, &hexStr); err != nil || hexStr == "" {
		return nil, fmt.Errorf("decode eth_call totalCommitted: %w", err)
	}
	v, err := parseHexUint(hexStr)
	if err != nil {
		return nil, fmt.Errorf("decode eth_call totalCommitted %q: %w", hexStr, err)
	}
	return v, nil
}

// parseHexUint decodes a 0x-prefixed hex quantity into a big.Int.
func parseHexUint(s string) (*big.Int, error) {
	if len(s) < 3 || s[0] != '0' || (s[1] != 'x' && s[1] != 'X') {
		return nil, fmt.Errorf("not a hex quantity: %q", s)
	}
	v := new(big.Int)
	if _, ok := v.SetString(s[2:], 16); !ok {
		return nil, fmt.Errorf("bad hex quantity: %q", s)
	}
	return v, nil
}

func (l *Listener) lastChecked() string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.lastBlock
}

func (l *Listener) setLastBlock(b string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.lastBlock = b
}

// ReceiptLog is one event log inside a transaction receipt: the emitting
// contract plus the raw topics and data needed to match ERC-20 Transfers.
type ReceiptLog struct {
	Address string
	Topics  []string
	Data    string
}

// Receipt is the subset of an eth_getTransactionReceipt answer the transfer
// proof checks: who paid whom, how much, finality, and success status.
type Receipt struct {
	From        string
	To          string
	Value       *big.Int
	BlockNumber *big.Int
	Status      string
	TxHash      string
	Logs        []ReceiptLog
}

// Client is a minimal read-only JSON-RPC client for payment-proof checks.
type Client struct {
	rpcURL string
	http   *http.Client
}

// NewClient builds a receipt client against rpcURL.
func NewClient(rpcURL string) *Client {
	return &Client{rpcURL: rpcURL, http: &http.Client{Timeout: 15 * time.Second}}
}

func (c *Client) rpcCall(ctx context.Context, method string, params json.RawMessage) (json.RawMessage, error) {
	body, err := json.Marshal(rpcRequest{JSONRPC: "2.0", Method: method, Params: params, ID: 1})
	if err != nil {
		return nil, fmt.Errorf("encode %s: %w", method, err)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.rpcURL, bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("build %s request: %w", method, err)
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, fmt.Errorf("post %s: %w", method, err)
	}
	defer func() {
		_ = resp.Body.Close()
	}()
	out, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return nil, fmt.Errorf("read %s body: %w", method, err)
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("%s http=%d: %w", method, resp.StatusCode, errRPC)
	}
	var decoded rpcResponse
	if err := json.Unmarshal(out, &decoded); err != nil {
		return nil, fmt.Errorf("decode %s: %w", method, err)
	}
	if decoded.Error != nil {
		return nil, fmt.Errorf("%s code=%d %s: %w", method, decoded.Error.Code, decoded.Error.Message, errRPC)
	}
	return decoded.Result, nil
}

// BlockNumber returns the latest chain head as a big.Int.
func (c *Client) BlockNumber(ctx context.Context) (*big.Int, error) {
	raw, err := c.rpcCall(ctx, "eth_blockNumber", json.RawMessage(`[]`))
	if err != nil {
		return nil, err
	}
	var hexStr string
	if err := json.Unmarshal(raw, &hexStr); err != nil || hexStr == "" {
		return nil, fmt.Errorf("decode eth_blockNumber: %w", err)
	}
	return parseHexUint(hexStr)
}

// TransactionReceipt fetches the receipt for txHash; a null result (pending
// or unknown transaction) is ErrNoReceipt.
func (c *Client) TransactionReceipt(ctx context.Context, txHash string) (*Receipt, error) {
	params, err := json.Marshal([]string{txHash})
	if err != nil {
		return nil, fmt.Errorf("encode eth_getTransactionReceipt: %w", err)
	}
	raw, err := c.rpcCall(ctx, "eth_getTransactionReceipt", params)
	if err != nil {
		return nil, err
	}
	if string(raw) == "null" {
		return nil, fmt.Errorf("tx %s: %w", txHash, ErrNoReceipt)
	}
	var r struct {
		From        string `json:"from"`
		To          *string `json:"to"`
		Value       string `json:"value"`
		BlockNumber string `json:"blockNumber"`
		Status      string `json:"status"`
		TxHash      string `json:"transactionHash"`
		Logs []struct {
			Address string   `json:"address"`
			Topics  []string `json:"topics"`
			Data    string   `json:"data"`
		} `json:"logs"`
	}
	if err := json.Unmarshal(raw, &r); err != nil {
		return nil, fmt.Errorf("decode eth_getTransactionReceipt: %w", err)
	}
	to := ""
	if r.To != nil {
		to = *r.To
	}
	val, err := parseHexUint(nonEmptyHex(r.Value))
	if err != nil {
		return nil, fmt.Errorf("decode receipt value: %w", err)
	}
	blk, err := parseHexUint(r.BlockNumber)
	if err != nil {
		return nil, fmt.Errorf("decode receipt blockNumber: %w", err)
	}
	logs := make([]ReceiptLog, 0, len(r.Logs))
	for _, lg := range r.Logs {
		logs = append(logs, ReceiptLog{Address: lg.Address, Topics: lg.Topics, Data: lg.Data})
	}
	return &Receipt{From: r.From, To: to, Value: val, BlockNumber: blk, Status: r.Status, TxHash: r.TxHash, Logs: logs}, nil
}

func nonEmptyHex(s string) string {
	if s == "" {
		return "0x0"
	}
	return s
}

// EthCall performs a read-only eth_call to contract `to` with calldata `data`
// at block tag and decodes the uint256 answer.
func (c *Client) EthCall(ctx context.Context, to, data, blockTag string) (*big.Int, error) {
	params, err := json.Marshal([]any{
		map[string]string{"to": to, "data": data},
		blockTag,
	})
	if err != nil {
		return nil, fmt.Errorf("encode eth_call: %w", err)
	}
	raw, err := c.rpcCall(ctx, "eth_call", params)
	if err != nil {
		return nil, err
	}
	var hexStr string
	if err := json.Unmarshal(raw, &hexStr); err != nil || hexStr == "" {
		return nil, fmt.Errorf("decode eth_call: %w", err)
	}
	v, err := parseHexUint(hexStr)
	if err != nil {
		return nil, fmt.Errorf("decode eth_call %q: %w", hexStr, err)
	}
	return v, nil
}

// PoolViews is the on-chain pool state the API pool gate reads.
type PoolViews struct {
	Settled        bool
	Expired        bool
	TotalCommitted *big.Int
}

// RoundViews is one v2 funding round's on-chain state. It mirrors the SDK
// RoundState shape field-for-field: target, totalCommitted, settled,
// expired, participantCount, roundId, deadline.
type RoundViews struct {
	Target           *big.Int
	TotalCommitted   *big.Int
	Settled          bool
	Expired          bool
	ParticipantCount *big.Int
	RoundId          *big.Int
	Deadline         *big.Int
}

// ReadPoolViews reads settled(), expired(), and totalCommitted() at latest.
// A nonzero uint256 counts as true for the boolean views.
func (c *Client) ReadPoolViews(ctx context.Context, pool string) (*PoolViews, error) {
	settled, err := c.EthCall(ctx, pool, settledSelectorView, "latest")
	if err != nil {
		return nil, fmt.Errorf("settled view: %w", err)
	}
	expired, err := c.EthCall(ctx, pool, expiredSelectorView, "latest")
	if err != nil {
		return nil, fmt.Errorf("expired view: %w", err)
	}
	committed, err := c.EthCall(ctx, pool, totalCommittedSelector, "latest")
	if err != nil {
		return nil, fmt.Errorf("totalCommitted view: %w", err)
	}
	return &PoolViews{Settled: settled.Sign() != 0, Expired: expired.Sign() != 0, TotalCommitted: committed}, nil
}

// CurrentRoundId reads the v2 pool's currentRoundId() at block tag.
func (c *Client) CurrentRoundId(ctx context.Context, pool, blockTag string) (*big.Int, error) {
	v, err := c.EthCall(ctx, pool, currentRoundIdSelector, blockTag)
	if err != nil {
		return nil, fmt.Errorf("currentRoundId view: %w", err)
	}
	return v, nil
}

// ReadRoundViews reads one v2 round's funding progress, terminal flags, and
// deadline: the rounds(roundId) accounting tuple plus the expired(roundId)
// and participantCount(roundId) views. Tuple words are positional
// (0 target, 1 deadline, 3 totalCommitted, 5 settled); a short return is a
// decode error, never a silent zero.
func (c *Client) ReadRoundViews(ctx context.Context, pool string, roundId *big.Int) (*RoundViews, error) {
	if roundId == nil || roundId.Sign() < 0 {
		return nil, fmt.Errorf("round %v: %w", roundId, errInvalidRound)
	}
	roundData, err := encodeUintArg(roundsSelector, roundId)
	if err != nil {
		return nil, fmt.Errorf("rounds call: %w", err)
	}
	raw, err := c.ethCallRaw(ctx, pool, roundData, "latest")
	if err != nil {
		return nil, fmt.Errorf("rounds view: %w", err)
	}
	target, err := decodeWord(raw, 0)
	if err != nil {
		return nil, fmt.Errorf("rounds target: %w", err)
	}
	deadline, err := decodeWord(raw, 1)
	if err != nil {
		return nil, fmt.Errorf("rounds deadline: %w", err)
	}
	committed, err := decodeWord(raw, 3)
	if err != nil {
		return nil, fmt.Errorf("rounds totalCommitted: %w", err)
	}
	settledWord, err := decodeWord(raw, 5)
	if err != nil {
		return nil, fmt.Errorf("rounds settled: %w", err)
	}
	expiredData, err := encodeUintArg(expiredAtSelector, roundId)
	if err != nil {
		return nil, fmt.Errorf("expired call: %w", err)
	}
	expiredRaw, err := c.ethCallRaw(ctx, pool, expiredData, "latest")
	if err != nil {
		return nil, fmt.Errorf("expired view: %w", err)
	}
	expired, err := parseHexUint(expiredRaw)
	if err != nil {
		return nil, fmt.Errorf("decode expired view %q: %w", expiredRaw, err)
	}
	countData, err := encodeUintArg(participantCountAtSelector, roundId)
	if err != nil {
		return nil, fmt.Errorf("participantCount call: %w", err)
	}
	countRaw, err := c.ethCallRaw(ctx, pool, countData, "latest")
	if err != nil {
		return nil, fmt.Errorf("participantCount view: %w", err)
	}
	count, err := parseHexUint(countRaw)
	if err != nil {
		return nil, fmt.Errorf("decode participantCount view %q: %w", countRaw, err)
	}
	return &RoundViews{
		Target:           target,
		TotalCommitted:   committed,
		Settled:          settledWord.Sign() != 0,
		Expired:          expired.Sign() != 0,
		ParticipantCount: count,
		RoundId:          new(big.Int).Set(roundId),
		Deadline:         deadline,
	}, nil
}

// errInvalidRound is returned when a round id is nil or negative.
var errInvalidRound = errors.New("settle: invalid round id")

// errInvalidWallet is returned when a wallet address is not 0x + 40 hex.
var errInvalidWallet = errors.New("settle: invalid wallet address")

// ReadCommitted reads one wallet's stake in a v2 round via the public
// committed(roundId, wallet) getter: nonzero means the wallet funded the
// round. It is the post-settle allocate gate's chain proof of participation
// for wallets with no local pre-settle reservation.
func (c *Client) ReadCommitted(ctx context.Context, pool string, roundId *big.Int, wallet string) (*big.Int, error) {
	data, err := encodeCommittedArg(committedSelector, roundId, wallet)
	if err != nil {
		return nil, err
	}
	raw, err := c.ethCallRaw(ctx, pool, data, "latest")
	if err != nil {
		return nil, fmt.Errorf("committed view: %w", err)
	}
	v, err := parseHexUint(raw)
	if err != nil {
		return nil, fmt.Errorf("decode committed view %q: %w", raw, err)
	}
	return v, nil
}

// encodeCommittedArg builds committed(uint256,address) calldata: selector
// followed by the round id and the wallet address, each as one 32-byte
// left-padded word. The wallet must be 0x-prefixed 20-byte hex; anything
// else is rejected before any RPC call.
func encodeCommittedArg(selector string, id *big.Int, wallet string) (string, error) {
	if id == nil || id.Sign() < 0 {
		return "", fmt.Errorf("round %v: %w", id, errInvalidRound)
	}
	addr := strings.ToLower(strings.TrimSpace(wallet))
	if len(addr) != 42 || !strings.HasPrefix(addr, "0x") {
		return "", fmt.Errorf("wallet %q: %w", wallet, errInvalidWallet)
	}
	for _, ch := range addr[2:] {
		if !(ch >= '0' && ch <= '9' || ch >= 'a' && ch <= 'f') {
			return "", fmt.Errorf("wallet %q: %w", wallet, errInvalidWallet)
		}
	}
	roundHex := id.Text(16)
	if len(roundHex) > 64 {
		return "", fmt.Errorf("round %v overflows uint256: %w", id, errInvalidRound)
	}
	return selector +
		strings.Repeat("0", 64-len(roundHex)) + roundHex +
		strings.Repeat("0", 24) + addr[2:], nil
}

// encodeUintArg builds selector + ABI-encoded uint256 calldata.
func encodeUintArg(selector string, id *big.Int) (string, error) {
	if id == nil || id.Sign() < 0 {
		return "", fmt.Errorf("round %v: %w", id, errInvalidRound)
	}
	h := id.Text(16)
	if len(h) > 64 {
		return "", fmt.Errorf("round %v overflows uint256: %w", id, errInvalidRound)
	}
	return selector + strings.Repeat("0", 64-len(h)) + h, nil
}

// decodeWord extracts 32-byte word i from a 0x-prefixed ABI blob.
func decodeWord(hexStr string, i int) (*big.Int, error) {
	s := strings.TrimPrefix(strings.TrimPrefix(hexStr, "0x"), "0X")
	if len(s) < 64*(i+1) {
		return nil, fmt.Errorf("blob len %d wants word %d", len(s), i)
	}
	v := new(big.Int)
	if _, ok := v.SetString(s[64*i:64*(i+1)], 16); !ok {
		return nil, fmt.Errorf("bad word %d in %q", i, hexStr)
	}
	return v, nil
}

// ethCallRaw performs a read-only eth_call and returns the raw 0x answer.
func (c *Client) ethCallRaw(ctx context.Context, to, data, blockTag string) (string, error) {
	params, err := json.Marshal([]any{
		map[string]string{"to": to, "data": data},
		blockTag,
	})
	if err != nil {
		return "", fmt.Errorf("encode eth_call: %w", err)
	}
	raw, err := c.rpcCall(ctx, "eth_call", params)
	if err != nil {
		return "", err
	}
	var hexStr string
	if err := json.Unmarshal(raw, &hexStr); err != nil || hexStr == "" {
		return "", fmt.Errorf("decode eth_call: %w", err)
	}
	return hexStr, nil
}

// ErrNoReceipt is returned when eth_getTransactionReceipt answers null.
var ErrNoReceipt = errors.New("settle: no receipt (tx pending or unknown)")

type rpcRequest struct {
	JSONRPC string          `json:"jsonrpc"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params"`
	ID      int             `json:"id"`
}

type rpcErrObj struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

type rpcResponse struct {
	Result json.RawMessage `json:"result"`
	Error  *rpcErrObj      `json:"error"`
}

func (l *Listener) call(ctx context.Context, method string, params json.RawMessage) (json.RawMessage, error) {
	body, err := json.Marshal(rpcRequest{JSONRPC: "2.0", Method: method, Params: params, ID: 1})
	if err != nil {
		return nil, fmt.Errorf("encode %s: %w", method, err)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, l.rpcURL, bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("build %s request: %w", method, err)
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := l.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("post %s: %w", method, err)
	}
	defer func() {
		_ = resp.Body.Close()
	}()
	out, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return nil, fmt.Errorf("read %s body: %w", method, err)
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("%s http=%d: %w", method, resp.StatusCode, errRPC)
	}
	var decoded rpcResponse
	if err := json.Unmarshal(out, &decoded); err != nil {
		return nil, fmt.Errorf("decode %s: %w", method, err)
	}
	if decoded.Error != nil {
		return nil, fmt.Errorf("%s code=%d %s: %w", method, decoded.Error.Code, decoded.Error.Message, errRPC)
	}
	return decoded.Result, nil
}

func (l *Listener) blockNumber(ctx context.Context) (string, error) {
	raw, err := l.call(ctx, "eth_blockNumber", json.RawMessage(`[]`))
	if err != nil {
		return "", err
	}
	var block string
	if err := json.Unmarshal(raw, &block); err != nil || block == "" {
		return "", fmt.Errorf("decode eth_blockNumber: %w", err)
	}
	return block, nil
}

type logFilter struct {
	Address   string     `json:"address"`
	Topics    [][]string `json:"topics"`
	FromBlock string     `json:"fromBlock"`
	ToBlock   string     `json:"toBlock"`
}

func (l *Listener) getLogs(ctx context.Context, toBlock string) ([]json.RawMessage, error) {
	filter := logFilter{
		Address:   l.pool,
		Topics:    [][]string{{settledSelector}},
		FromBlock: l.lastChecked(),
		ToBlock:   toBlock,
	}
	params, err := json.Marshal([]logFilter{filter})
	if err != nil {
		return nil, fmt.Errorf("encode filter: %w", err)
	}
	raw, err := l.call(ctx, "eth_getLogs", params)
	if err != nil {
		return nil, err
	}
	var logs []json.RawMessage
	if err := json.Unmarshal(raw, &logs); err != nil {
		return nil, fmt.Errorf("decode eth_getLogs: %w", err)
	}
	return logs, nil
}

// getV2Logs queries the v2 pool for RoundStarted and Settled(roundId,total)
// logs in [roundCursor, toBlock]. One filter with both topics keeps the scan
// to a single RPC call; parseV2Log separates the kinds afterwards.
func (l *Listener) getV2Logs(ctx context.Context, roundId *big.Int, toBlock string) ([]json.RawMessage, error) {
	filter := logFilter{
		Address:   l.v2pool,
		Topics:    [][]string{{roundStartedSelector, settledV2Selector}},
		FromBlock: l.roundCursorOf(roundId),
		ToBlock:   toBlock,
	}
	params, err := json.Marshal([]logFilter{filter})
	if err != nil {
		return nil, fmt.Errorf("encode filter: %w", err)
	}
	raw, err := l.call(ctx, "eth_getLogs", params)
	if err != nil {
		return nil, err
	}
	var logs []json.RawMessage
	if err := json.Unmarshal(raw, &logs); err != nil {
		return nil, fmt.Errorf("decode eth_getLogs: %w", err)
	}
	return logs, nil
}

// Share is one wallet's equal-split default slice.
type Share struct {
	CPU   float64
	MemMB int64
}

// EqualSplit divides pool totals evenly over n participants, flooring MB and
// rounding CPU down to 6 decimals so the sum never exceeds the totals.
func EqualSplit(totalCPU float64, totalMB int64, n int) ([]Share, error) {
	if n <= 0 {
		return nil, fmt.Errorf("participants=%d: %w", n, errParticipants)
	}
	if totalCPU <= 0 || totalMB <= 0 {
		return nil, fmt.Errorf("totals cpu=%v mb=%d: %w", totalCPU, totalMB, errParticipants)
	}
	out := make([]Share, n)
	perMB := totalMB / int64(n)
	perCPU := math.Floor(totalCPU/float64(n)*1e6) / 1e6
	for i := range out {
		out[i] = Share{CPU: perCPU, MemMB: perMB}
	}
	return out, nil
}

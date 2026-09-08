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

// Listener polls eth_getLogs for POOL_ADDRESS on a time.Ticker. The filter pins
// topics[0] to the Settled selector, so only the terminal event matches.
// Before flipping the ledger it verifies on-chain funding via eth_call
// totalCommitted() >= the configured target: a Settled log alone never flips.
type Listener struct {
	rpcURL   string
	pool     string
	interval time.Duration
	ledger   *store.Store
	logger   *slog.Logger
	client   *http.Client

	targetAtomic  *big.Int
	confirmations uint64

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

// Check performs one poll round: it fetches the latest block, queries logs
// from the last checked block, and flips the ledger on the first
// sufficiently-confirmed match whose on-chain commitment covers the target.
// The cursor never advances past unprocessed logs: on the first
// unmatching or unverifiable log the cursor pins to that log's block so the
// round is retried, and only a fully processed round advances to latest.
// Independently of logs, every poll re-evaluates the funding gate from chain
// state (totalCommitted eth_call), so a top-up that lands after the cursor
// with no new event still flips. It reports whether this call transitioned.
func (l *Listener) Check(ctx context.Context) (bool, error) {
	latest, err := l.blockNumber(ctx)
	if err != nil {
		return false, err
	}
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

// Receipt is the subset of an eth_getTransactionReceipt answer the transfer
// proof checks: who paid whom, how much, finality, and success status.
type Receipt struct {
	From        string
	To          string
	Value       *big.Int
	BlockNumber *big.Int
	Status      string
	TxHash      string
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
		From        string  `json:"from"`
		To          *string `json:"to"`
		Value       string  `json:"value"`
		BlockNumber string  `json:"blockNumber"`
		Status      string  `json:"status"`
		TxHash      string  `json:"transactionHash"`
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
	return &Receipt{From: r.From, To: to, Value: val, BlockNumber: blk, Status: r.Status, TxHash: r.TxHash}, nil
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

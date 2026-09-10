// Package store holds the in-memory entitlement ledger and usage metering.
// All state is mutex-guarded; there is no global state, wire via NewStore.
package store

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"errors"
	"fmt"
	"math"
	"math/big"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/Jashk120/Coalition/orchestrator/internal/domain"
)

var (
	// ErrUnknownWallet is returned for wallets with no recorded entitlement.
	ErrUnknownWallet = errors.New("store: unknown wallet")
	// ErrQuotaExceeded is returned when a wallet's usage exceeds entitlement.
	ErrQuotaExceeded = errors.New("store: quota exceeded")
	// ErrInsufficientQuota is returned when a transfer exceeds the sender's remainder.
	ErrInsufficientQuota = errors.New("store: insufficient remaining quota")
	// ErrTokenInvalid is returned when a bearer token is missing or unknown (HTTP 401).
	ErrTokenInvalid = errors.New("store: invalid token")
	// ErrTokenRevoked is returned when the wallet's token was revoked by dropout (HTTP 403).
	ErrTokenRevoked = errors.New("store: token revoked")
	// ErrTokenExpired is returned when the wallet's token passed window end (HTTP 403).
	ErrTokenExpired = errors.New("store: token expired")
	// ErrPoolExhausted is returned when an admit would oversubscribe pool
	// totals or breach the distinct-wallet cap (HTTP 409 pool_exhausted).
	ErrPoolExhausted = errors.New("store: pool exhausted")
	// ErrDuplicatePayment is returned when a transfer reuses an already-spent
	// payment hash (HTTP 409 duplicate_payment).
	ErrDuplicatePayment = errors.New("store: payment hash already spent")
)

// microPerCU scales fractional cores to integers: 1 CU = 1e6 micro-CU. The
// admit and transfer paths compare micro-CU integers only, so pool-total
// accounting is exact and deterministic across runs and goroutines.
const microPerCU = 1e6

// cpuMicro converts cores to micro-CU with round-half-away; microToFloat is
// its inverse. Both are deterministic: the same micro value always yields the
// same float, so float storage never leaks into comparisons.
func cpuMicro(cpu float64) int64 { return int64(math.Round(cpu * microPerCU)) }

// MicroCU converts cores to micro-CU for admit-path accounting. Callers
// convert request floats once, at the boundary, and pass integers down.
func MicroCU(cpu float64) int64 { return cpuMicro(cpu) }

func microToFloat(micro int64) float64 { return float64(micro) / microPerCU }

// record is the per-wallet ledger entry. roundId pins the entitlement to the
// funding round that admitted it (nil = admitted before round tracking
// began); Authenticate enforces the pin once a round is observed, so prior
// settled rounds confer no access and expired-unfilled rounds confer none.
type record struct {
	entitlement domain.Entitlement
	usage       domain.Usage
	containerID string
	allocatedAt time.Time
	tokenHash   [32]byte
	hasToken    bool
	revoked     bool
	expiresAt   time.Time
	inflight    []inflightExec
	pending     bool
	prevEnt     domain.Entitlement
	prevExists  bool
	prevRound   *big.Int
	roundId     *big.Int
}

// inflightExec is one registered-but-unbilled execution: its elapsed wall
// time times the wallet slice is the spend the reaper polices.
type inflightExec struct {
	start time.Time
	cpu   float64
	memMB float64
}

// Store is the mutex-guarded in-memory ledger. settled/settledAt track the
// legacy v1 pool; settledRounds/currentRound track the v2 round-scoped pool.
// The two coexist: a v1 settle never flips a round and vice versa.
type Store struct {
	mu        sync.RWMutex
	windowHrs float64
	wallets   map[string]*record
	settled   bool
	settledAt time.Time
	spent     map[string]bool
	now       func() time.Time

	currentRound  *big.Int
	settledRounds map[string]time.Time
}

// NewStore builds an empty ledger for a window of windowHours hours.
func NewStore(windowHours int64) *Store {
	return &Store{windowHrs: float64(windowHours), wallets: make(map[string]*record), spent: make(map[string]bool), settledRounds: make(map[string]time.Time), now: time.Now}
}

// windowDuration is the compute window as a time.Duration.
func (s *Store) windowDuration() time.Duration {
	return time.Duration(s.windowHrs * float64(time.Hour))
}

// SetEntitlement records (or replaces, for idempotent re-allocate) a wallet's slice.
func (s *Store) SetEntitlement(w domain.WalletAddress, e domain.Entitlement) {
	s.mu.Lock()
	defer s.mu.Unlock()
	r, ok := s.wallets[w.String()]
	if !ok {
		r = &record{}
		s.wallets[w.String()] = r
	}
	r.entitlement = e
	if r.allocatedAt.IsZero() {
		r.allocatedAt = s.now()
	}
}

// Entitlement returns the recorded slice for a wallet.
func (s *Store) Entitlement(w domain.WalletAddress) (domain.Entitlement, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	r, ok := s.wallets[w.String()]
	if !ok {
		return domain.Entitlement{}, fmt.Errorf("wallet %s: %w", w.String(), ErrUnknownWallet)
	}
	return r.entitlement, nil
}

// HasWallet reports whether a wallet has any ledger entry at all.
func (s *Store) HasWallet(w domain.WalletAddress) bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	_, ok := s.wallets[w.String()]
	return ok
}

// Totals sums every recorded entitlement: the oversubscription guard compares
// these against pool totals before admitting a new slice.
func (s *Store) Totals() (cpu float64, memMB int64) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	for _, r := range s.wallets {
		cpu += r.entitlement.CPU
		memMB += r.entitlement.MemMB
	}
	return cpu, memMB
}

// mintTokenLocked mints a fresh opaque bearer token for a record already
// under write lock, storing only its sha256. Both /allocate (IssueToken) and
// transfer-created recipients call this one helper, so the two paths can
// never drift in format or expiry semantics.
func (s *Store) mintTokenLocked(r *record) (string, error) {
	var raw [32]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return "", fmt.Errorf("mint token: %w", err)
	}
	token := hex.EncodeToString(raw[:])
	r.tokenHash = sha256.Sum256([]byte(token))
	r.hasToken = true
	r.revoked = false
	r.expiresAt = time.Time{}
	if r.allocatedAt.IsZero() {
		r.allocatedAt = s.now()
	}
	if r.roundId == nil {
		s.stampRoundLocked(r)
	}
	return token, nil
}

// stampRoundLocked pins r to the currently observed round (nil when no
// round was ever observed). Callers hold the write lock.
func (s *Store) stampRoundLocked(r *record) {
	if s.currentRound == nil {
		r.roundId = nil
		return
	}
	r.roundId = new(big.Int).Set(s.currentRound)
}

// IssueToken mints a fresh opaque bearer token for a wallet and returns the
// plaintext once. Re-allocate rotates the token. Expiry is computed, not
// stored (see Authenticate): settledAt + window once settled, else
// allocatedAt + window.
func (s *Store) IssueToken(w domain.WalletAddress) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	r, ok := s.wallets[w.String()]
	if !ok {
		r = &record{}
		s.wallets[w.String()] = r
	}
	return s.mintTokenLocked(r)
}

// Authenticate checks a presented bearer token for a wallet: unknown wallets
// and unknown tokens are 401 (ErrTokenInvalid); revoked or expired tokens
// with a known wallet entry are 403 (ErrTokenRevoked / ErrTokenExpired).
// Expiry epoch: once settled, validity runs to settledAt + window (the window
// starts at settlement, so allocations made pre-settle stay usable through
// the compute window); pre-settle it runs to allocatedAt + window. Round
// entitlements anchor to their own round's settle instant instead. An
// explicit expiresAt override (test hook) always wins.
//
// Round allowlist: once any round is observed, the wallet's stamped roundId
// must equal the current round, else 403. Prior settled rounds confer no
// access, expired-unfilled rounds confer none, and expiry of the current
// round alone never revokes /run continuity for same-round wallets.
func (s *Store) Authenticate(w domain.WalletAddress, bearer string) error {
	if bearer == "" {
		return fmt.Errorf("wallet %s missing token: %w", w.String(), ErrTokenInvalid)
	}
	sum := sha256.Sum256([]byte(bearer))
	s.mu.RLock()
	defer s.mu.RUnlock()
	r, ok := s.wallets[w.String()]
	if !ok || !r.hasToken {
		return fmt.Errorf("wallet %s: %w", w.String(), ErrTokenInvalid)
	}
	if subtle.ConstantTimeCompare(sum[:], r.tokenHash[:]) != 1 {
		return fmt.Errorf("wallet %s: %w", w.String(), ErrTokenInvalid)
	}
	if r.revoked {
		return fmt.Errorf("wallet %s: %w", w.String(), ErrTokenRevoked)
	}
	if s.currentRound != nil && (r.roundId == nil || r.roundId.Cmp(s.currentRound) != 0) {
		return fmt.Errorf("wallet %s not in current round %s: %w", w.String(), s.currentRound, ErrTokenExpired)
	}
	expiry := r.expiresAt
	if expiry.IsZero() {
		base := r.allocatedAt
		if r.roundId != nil {
			if ts, ok := s.settledRounds[r.roundId.String()]; ok && !ts.IsZero() {
				base = ts
			}
		} else if s.settled && !s.settledAt.IsZero() {
			base = s.settledAt
		}
		expiry = base.Add(s.windowDuration())
	}
	if !s.now().Before(expiry) {
		return fmt.Errorf("wallet %s: %w", w.String(), ErrTokenExpired)
	}
	return nil
}

// Revoke marks a wallet's token unusable (dropout): future auth gets 403,
// never 401, so clients can distinguish "log in again" from "gone".
func (s *Store) Revoke(w domain.WalletAddress) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if r, ok := s.wallets[w.String()]; ok {
		r.revoked = true
	}
}

// SetTokenExpiry is a test hook forcing a wallet's token expiry.
func (s *Store) SetTokenExpiry(w domain.WalletAddress, t time.Time) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if r, ok := s.wallets[w.String()]; ok {
		r.expiresAt = t
	}
}

// SetContainer binds a container ID to a wallet.
func (s *Store) SetContainer(w domain.WalletAddress, id string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	r, ok := s.wallets[w.String()]
	if !ok {
		r = &record{}
		s.wallets[w.String()] = r
	}
	r.containerID = id
}

// Container returns the container ID bound to a wallet.
func (s *Store) Container(w domain.WalletAddress) (string, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	r, ok := s.wallets[w.String()]
	if !ok || r.containerID == "" {
		return "", fmt.Errorf("wallet %s: %w", w.String(), ErrUnknownWallet)
	}
	return r.containerID, nil
}

// AddUsage accumulates metered consumption for a wallet.
func (s *Store) AddUsage(w domain.WalletAddress, cuSeconds, mbHours float64) error {
	if math.IsNaN(cuSeconds) || math.IsInf(cuSeconds, 0) ||
		math.IsNaN(mbHours) || math.IsInf(mbHours, 0) ||
		cuSeconds < 0 || mbHours < 0 {
		return fmt.Errorf("cuSeconds=%v mbHours=%v: %w", cuSeconds, mbHours, domain.ErrInvalidQuota)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	r, ok := s.wallets[w.String()]
	if !ok {
		return fmt.Errorf("wallet %s: %w", w.String(), ErrUnknownWallet)
	}
	r.usage.CUSeconds += cuSeconds
	r.usage.MBHours += mbHours
	return nil
}

// Usage returns cumulative consumption for a wallet.
func (s *Store) Usage(w domain.WalletAddress) (domain.Usage, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	r, ok := s.wallets[w.String()]
	if !ok {
		return domain.Usage{}, fmt.Errorf("wallet %s: %w", w.String(), ErrUnknownWallet)
	}
	return r.usage, nil
}

// Inflight estimates unbilled spend of in-flight executions at now. Live
// dashboards add it to Usage so bars climb while work runs instead of
// jumping only at EndExec billing.
func (s *Store) Inflight(w domain.WalletAddress) (cuSeconds, mbHours float64, err error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	r, ok := s.wallets[w.String()]
	if !ok {
		return 0, 0, fmt.Errorf("wallet %s: %w", w.String(), ErrUnknownWallet)
	}
	cuSeconds, mbHours = s.inflightSpendLocked(r, s.now())
	return cuSeconds, mbHours, nil
}

// Budgets converts an entitlement into absolute budgets for the window.
func (s *Store) Budgets(e domain.Entitlement) (cpuSeconds, mbHours float64) {
	return e.CPU * s.windowHrs * 3600, float64(e.MemMB) * s.windowHrs
}

// budgetsLocked is Budgets for a record already under lock.
func (s *Store) budgetsLocked(r *record) (cpuSeconds, mbHours float64) {
	return r.entitlement.CPU * s.windowHrs * 3600, float64(r.entitlement.MemMB) * s.windowHrs
}

// inflightSpendLocked estimates unbilled spend of in-flight executions at now.
func (s *Store) inflightSpendLocked(r *record, now time.Time) (cuSeconds, mbHours float64) {
	for _, f := range r.inflight {
		el := now.Sub(f.start).Seconds()
		if el < 0 {
			el = 0
		}
		cuSeconds += el * f.cpu
		mbHours += el * f.memMB / 3600
	}
	return cuSeconds, mbHours
}

// Exceeded reports whether usage strictly exceeds either budget dimension.
// Exact fit passes: only consumption beyond the paid slice is a violation.
func (s *Store) Exceeded(w domain.WalletAddress) (bool, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	r, ok := s.wallets[w.String()]
	if !ok {
		return false, fmt.Errorf("wallet %s: %w", w.String(), ErrUnknownWallet)
	}
	cpuBudget, memBudget := s.Budgets(r.entitlement)
	return r.usage.CUSeconds > cpuBudget || r.usage.MBHours > memBudget, nil
}

// BeginExec registers an in-flight execution under the same lock that checks
// the budget, closing the check-then-bill TOCTOU: concurrent /run calls that
// would jointly overspend are serialized here, and the loser sees
// ErrQuotaExceeded before any container work starts. Zero-slice wallets are
// refused outright: a wallet with no paid capacity in either dimension can
// never accrue legal usage, so admitting an exec would only manufacture debt.
func (s *Store) BeginExec(w domain.WalletAddress) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	r, ok := s.wallets[w.String()]
	if !ok {
		return fmt.Errorf("wallet %s: %w", w.String(), ErrUnknownWallet)
	}
	if r.entitlement.CPU <= 0 || r.entitlement.MemMB <= 0 {
		return fmt.Errorf("wallet %s holds a zero slice: %w", w.String(), ErrQuotaExceeded)
	}
	cpuBudget, memBudget := s.budgetsLocked(r)
	now := s.now()
	pendingCU, pendingMB := s.inflightSpendLocked(r, now)
	if r.usage.CUSeconds+pendingCU > cpuBudget || r.usage.MBHours+pendingMB > memBudget {
		return fmt.Errorf("wallet %s: %w", w.String(), ErrQuotaExceeded)
	}
	r.inflight = append(r.inflight, inflightExec{start: now, cpu: r.entitlement.CPU, memMB: float64(r.entitlement.MemMB)})
	return nil
}

// EndExec unregisters one in-flight execution and bills actuals atomically.
// NaN/Inf actuals are rejected before they can corrupt the ledger.
func (s *Store) EndExec(w domain.WalletAddress, cuSeconds, mbHours float64) error {
	if math.IsNaN(cuSeconds) || math.IsInf(cuSeconds, 0) ||
		math.IsNaN(mbHours) || math.IsInf(mbHours, 0) ||
		cuSeconds < 0 || mbHours < 0 {
		return fmt.Errorf("cuSeconds=%v mbHours=%v: %w", cuSeconds, mbHours, domain.ErrInvalidQuota)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	r, ok := s.wallets[w.String()]
	if !ok {
		return fmt.Errorf("wallet %s: %w", w.String(), ErrUnknownWallet)
	}
	if n := len(r.inflight); n > 0 {
		r.inflight = r.inflight[:n-1]
	}
	r.usage.CUSeconds += cuSeconds
	r.usage.MBHours += mbHours
	return nil
}

// ReapTarget is one wallet whose billed usage plus in-flight estimate exceeds
// budget: its container must be killed.
type ReapTarget struct {
	Wallet      string
	ContainerID string
}

// ReapTargets scans for over-budget wallets with a live container, whether
// the overspend is billed usage (idle sweep: no in-flight needed) or billed
// usage plus in-flight estimate. Pure scan: it kills nothing.
func (s *Store) ReapTargets() []ReapTarget {
	now := s.now()
	s.mu.RLock()
	defer s.mu.RUnlock()
	var out []ReapTarget
	for wallet, r := range s.wallets {
		if r.containerID == "" {
			continue
		}
		cpuBudget, memBudget := s.Budgets(r.entitlement)
		pendingCU, pendingMB := s.inflightSpendLocked(r, now)
		if r.usage.CUSeconds+pendingCU > cpuBudget || r.usage.MBHours+pendingMB > memBudget {
			out = append(out, ReapTarget{Wallet: wallet, ContainerID: r.containerID})
		}
	}
	return out
}

// RemainingBudgets returns floor-clamped remaining CU-seconds and MB-hours.
func (s *Store) RemainingBudgets(w domain.WalletAddress) (cuSeconds, mbHours int64, err error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	r, ok := s.wallets[w.String()]
	if !ok {
		return 0, 0, fmt.Errorf("wallet %s: %w", w.String(), ErrUnknownWallet)
	}
	cpuBudget, memBudget := s.Budgets(r.entitlement)
	return clampFloor(cpuBudget - r.usage.CUSeconds), clampFloor(memBudget - r.usage.MBHours), nil
}

func clampFloor(v float64) int64 {
	if math.IsNaN(v) || math.IsInf(v, -1) || v <= 0 {
		return 0
	}
	if math.IsInf(v, 1) {
		return math.MaxInt64
	}
	return int64(math.Floor(v))
}

// RemainingCapacity returns remaining allocatable capacity in cores and MB,
// derived by spreading cumulative usage evenly over the window.
func (s *Store) RemainingCapacity(w domain.WalletAddress) (cpu float64, memMB int64, err error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	r, ok := s.wallets[w.String()]
	if !ok {
		return 0, 0, fmt.Errorf("wallet %s: %w", w.String(), ErrUnknownWallet)
	}
	cpu = r.entitlement.CPU - r.usage.CUSeconds/(s.windowHrs*3600)
	if cpu < 0 {
		cpu = 0
	}
	memMB = r.entitlement.MemMB - int64(math.Floor(r.usage.MBHours/s.windowHrs))
	if memMB < 0 {
		memMB = 0
	}
	return cpu, memMB, nil
}

// Transfer moves mb megabytes and cu cores of entitlement from one wallet to
// another after validating the sender's remaining capacity. A move that would
// leave the sender at exactly zero in a moved dimension is rejected: a
// zero-slice wallet can never execute (see BeginExec), so draining to zero
// would strand the wallet with an unusable record.
func (s *Store) Transfer(from, to domain.WalletAddress, mb int64, cu float64) error {
	if from.String() == to.String() {
		return fmt.Errorf("self transfer: %w", ErrInsufficientQuota)
	}
	if math.IsNaN(cu) || math.IsInf(cu, 0) || mb < 0 || cu < 0 || (mb == 0 && cu == 0) {
		return fmt.Errorf("mb=%d cu=%v: %w", mb, cu, domain.ErrInvalidQuota)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	src, ok := s.wallets[from.String()]
	if !ok {
		return fmt.Errorf("wallet %s: %w", from.String(), ErrUnknownWallet)
	}
	remCPU := src.entitlement.CPU - src.usage.CUSeconds/(s.windowHrs*3600)
	remMB := src.entitlement.MemMB - int64(math.Floor(src.usage.MBHours/s.windowHrs))
	if float64(mb) > float64(remMB) || cu > remCPU+1e-9 {
		return fmt.Errorf("wallet %s wants mb=%d cu=%v: %w", from.String(), mb, cu, ErrInsufficientQuota)
	}
	if mb > 0 && int64(mb) == remMB || cu > 0 && cu >= remCPU-1e-9 && cu <= remCPU+1e-9 {
		return fmt.Errorf("wallet %s move drains slice to zero: %w", from.String(), ErrInsufficientQuota)
	}
	src.entitlement.MemMB -= mb
	src.entitlement.CPU -= cu
	dst, ok := s.wallets[to.String()]
	if !ok {
		dst = &record{}
		s.wallets[to.String()] = dst
	}
	dst.entitlement.MemMB += mb
	dst.entitlement.CPU += cu
	return nil
}

// TransferPaid moves mb megabytes and cuMicro micro-CU from one wallet to
// another, marks txHash spent, and mints the recipient's token when the
// recipient is new — all inside ONE lock. The spent-hash check and the quota
// move are a single critical section: a verified receipt cannot be replayed
// between check and mark, and a failed move never consumes the hash (every
// error path returns before the mark). It returns the recipient's plaintext
// token when the recipient record was created by this call ("" otherwise),
// so the transfer response can hand it over for immediate use.
func (s *Store) TransferPaid(from, to domain.WalletAddress, mb int64, cuMicro int64, txHash string, maxAgents int64) (toToken string, err error) {
	if from.String() == to.String() {
		return "", fmt.Errorf("self transfer: %w", ErrInsufficientQuota)
	}
	if mb < 0 || cuMicro < 0 || (mb == 0 && cuMicro == 0) {
		return "", fmt.Errorf("mb=%d cuMicro=%d: %w", mb, cuMicro, domain.ErrInvalidQuota)
	}
	tx := strings.ToLower(strings.TrimSpace(txHash))
	if tx == "" {
		return "", fmt.Errorf("empty tx hash: %w", domain.ErrInvalidQuota)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.spent[tx] {
		return "", fmt.Errorf("tx %s already spent: %w", txHash, ErrDuplicatePayment)
	}
	src, ok := s.wallets[from.String()]
	if !ok {
		return "", fmt.Errorf("wallet %s: %w", from.String(), ErrUnknownWallet)
	}
	now := s.now()
	remMicro, remMem := s.remainingLocked(src, now)
	if mb > remMem || cuMicro > remMicro {
		return "", fmt.Errorf("wallet %s wants mb=%d cuMicro=%d: %w", from.String(), mb, cuMicro, ErrInsufficientQuota)
	}
	if mb > 0 && mb == remMem || cuMicro > 0 && cuMicro == remMicro {
		return "", fmt.Errorf("wallet %s move drains slice to zero: %w", from.String(), ErrInsufficientQuota)
	}
	dst, ok := s.wallets[to.String()]
	newRecipient := !ok
	if newRecipient && int64(s.distinctLocked()) >= maxAgents {
		return "", fmt.Errorf("pool caps at %d agents: %w", maxAgents, ErrPoolExhausted)
	}
	if newRecipient {
		dst = &record{}
		s.wallets[to.String()] = dst
	}
	srcMicro := cpuMicroOf(src.entitlement.CPU)
	src.entitlement.MemMB -= mb
	src.entitlement.CPU = microToFloat(srcMicro - cuMicro)
	dst.entitlement.MemMB += mb
	dst.entitlement.CPU = microToFloat(cpuMicroOf(dst.entitlement.CPU) + cuMicro)
	if newRecipient {
		tok, err := s.mintTokenLocked(dst)
		if err != nil {
			return "", err
		}
		toToken = tok
	}
	s.spent[tx] = true
	return toToken, nil
}

// remainingLocked returns the sender's remaining micro-CU and MB including
// in-flight reservations: usage plus unbilled in-flight spend, spread over
// the window, in integers.
func (s *Store) remainingLocked(r *record, now time.Time) (microCU int64, memMB int64) {
	pendingCU, pendingMB := s.inflightSpendLocked(r, now)
	usedMicro := int64(math.Round((r.usage.CUSeconds + pendingCU) * microPerCU / (s.windowHrs * 3600)))
	usedMem := int64(math.Floor((r.usage.MBHours + pendingMB) / s.windowHrs))
	microCU = cpuMicroOf(r.entitlement.CPU) - usedMicro
	if microCU < 0 {
		microCU = 0
	}
	memMB = r.entitlement.MemMB - usedMem
	if memMB < 0 {
		memMB = 0
	}
	return microCU, memMB
}

// CheckTransfer pre-validates a move without mutating anything: unknown
// sender, quota including in-flight reservations, and the zero-drain rule.
// The commit path (TransferPaid) re-checks atomically; this early check keeps
// doomed transfers from reaching the chain read.
func (s *Store) CheckTransfer(from domain.WalletAddress, mb int64, cuMicro int64) error {
	s.mu.RLock()
	defer s.mu.RUnlock()
	src, ok := s.wallets[from.String()]
	if !ok {
		return fmt.Errorf("wallet %s: %w", from.String(), ErrUnknownWallet)
	}
	remMicro, remMem := s.remainingLocked(src, s.now())
	if mb > remMem || cuMicro > remMicro {
		return fmt.Errorf("wallet %s wants mb=%d cuMicro=%d: %w", from.String(), mb, cuMicro, ErrInsufficientQuota)
	}
	if mb > 0 && mb == remMem || cuMicro > 0 && cuMicro == remMicro {
		return fmt.Errorf("wallet %s move drains slice to zero: %w", from.String(), ErrInsufficientQuota)
	}
	return nil
}

// distinctLocked counts positive-entitlement wallets; caller holds the lock.
func (s *Store) distinctLocked() int {
	n := 0
	for _, r := range s.wallets {
		if r.entitlement.CPU > 0 || r.entitlement.MemMB > 0 {
			n++
		}
	}
	return n
}

// AdmitCap carries the pool totals and agent cap an admit is checked against.
// Totals are integers (micro-CU, MB) so comparisons are exact.
type AdmitCap struct {
	TotalCPUMicro int64
	TotalMemMB    int64
	MaxAgents     int64
}

// Reserve performs the whole admit decision and the ledger insert under ONE
// lock: distinct-count, MAX_AGENTS, and integer SUM(entitlements) <= totals
// are checked, then the candidate slice is staged as pending. The caller
// creates the container afterwards and calls ConfirmReserve (or
// RollbackReserve on failure), so a crashed create never double-commits.
// Sums run in wallet-sorted order over micro-CU/MB integers: no float
// epsilon, fully deterministic under concurrency.
func (s *Store) Reserve(w domain.WalletAddress, cpuMicro, memMB int64, cap AdmitCap) (isNew bool, err error) {
	if cpuMicro <= 0 || memMB <= 0 {
		return false, fmt.Errorf("cpuMicro=%d memMB=%d: %w", cpuMicro, memMB, domain.ErrInvalidQuota)
	}
	if cap.TotalCPUMicro <= 0 || cap.TotalMemMB <= 0 || cap.MaxAgents <= 0 {
		return false, fmt.Errorf("cap %+v: %w", cap, domain.ErrInvalidQuota)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	key := w.String()
	_, exists := s.wallets[key]
	isNew = !exists
	var sumMicro, sumMem int64
	keys := make([]string, 0, len(s.wallets)+1)
	for k := range s.wallets {
		keys = append(keys, k)
	}
	if isNew {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	distinct := 0
	for _, k := range keys {
		var micro, mem int64
		if k == key {
			micro, mem = cpuMicro, memMB
		} else {
			r := s.wallets[k]
			micro, mem = cpuMicroOf(r.entitlement.CPU), r.entitlement.MemMB
		}
		sumMicro += micro
		sumMem += mem
		if micro > 0 || mem > 0 {
			distinct++
		}
	}
	if isNew && int64(distinct) > cap.MaxAgents {
		return false, fmt.Errorf("pool caps at %d agents: %w", cap.MaxAgents, ErrPoolExhausted)
	}
	if sumMicro > cap.TotalCPUMicro || sumMem > cap.TotalMemMB {
		return false, fmt.Errorf("slice cpuMicro=%d mem=%d would oversubscribe pool: %w", cpuMicro, memMB, ErrPoolExhausted)
	}
	r, ok := s.wallets[key]
	if !ok {
		r = &record{}
		s.wallets[key] = r
	} else if !r.pending {
		r.prevEnt = r.entitlement
		r.prevExists = true
		r.prevRound = r.roundId
	}
	r.entitlement = domain.Entitlement{CPU: microToFloat(cpuMicro), MemMB: memMB}
	s.stampRoundLocked(r)
	if r.allocatedAt.IsZero() {
		r.allocatedAt = s.now()
	}
	r.pending = true
	return isNew, nil
}

// ConfirmReserve commits a reservation after the container was created: it
// clears the pending flag and binds the container ID. When the reservation
// crossed a funding round (pre-Reserve round differs from the confirm-time
// round, after the allocate-path chain pin), billed usage and inflight are
// zeroed so the re-funded wallet starts the new round with a fresh budget.
// Reset lives here — not in Reserve — so a rolled-back reservation never
// loses burn history.
func (s *Store) ConfirmReserve(w domain.WalletAddress, containerID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	r, ok := s.wallets[w.String()]
	if !ok || !r.pending {
		return fmt.Errorf("wallet %s has no pending reservation: %w", w.String(), ErrUnknownWallet)
	}
	r.pending = false
	if r.prevRound != nil && r.roundId != nil && r.prevRound.Cmp(r.roundId) != 0 {
		r.usage = domain.Usage{}
		r.inflight = nil
	}
	r.prevExists = false
	r.prevRound = nil
	r.containerID = containerID
	return nil
}

// RollbackReserve undoes a reservation whose container create failed: new
// wallets vanish entirely, resizes restore the previous slice (and keep the
// old container binding, which still runs).
func (s *Store) RollbackReserve(w domain.WalletAddress) {
	s.mu.Lock()
	defer s.mu.Unlock()
	r, ok := s.wallets[w.String()]
	if !ok || !r.pending {
		return
	}
	if !r.prevExists {
		delete(s.wallets, w.String())
		return
	}
	r.entitlement = r.prevEnt
	r.roundId = r.prevRound
	r.pending = false
	r.prevExists = false
	r.prevRound = nil
}

// cpuMicroOf converts a stored float slice to micro-CU for exact accounting.
func cpuMicroOf(cpu float64) int64 { return cpuMicro(cpu) }

// Wallets lists every wallet with a recorded entitlement.
func (s *Store) Wallets() []string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]string, 0, len(s.wallets))
	for w := range s.wallets {
		out = append(out, w)
	}
	return out
}

// ContainerBinding is one wallet's container attachment: the ledger side of
// a free-pool kill. ContainerID is "" when the wallet holds entitlement but
// has no container bound (eviction, restart, transfer-created).
type ContainerBinding struct {
	Wallet      string
	ContainerID string
}

// ListContainers snapshots every wallet's container attachment, sorted by
// wallet for determinism. Pure scan under RLock: it kills nothing, revokes
// nothing — the free-pool handler drives kills from this snapshot and then
// calls RemoveWallet per wallet.
func (s *Store) ListContainers() []ContainerBinding {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]ContainerBinding, 0, len(s.wallets))
	for w, r := range s.wallets {
		out = append(out, ContainerBinding{Wallet: w, ContainerID: r.containerID})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Wallet < out[j].Wallet })
	return out
}

// RemoveWallet deletes a wallet's ledger record entirely: entitlement,
// container binding, bearer token, and usage metering. Deletion implies
// revocation — with no record left, Authenticate reports ErrUnknownWallet
// (401), so the old token can never execute again. Returns true when a
// record existed.
//
// Full clear (not usage-preserving) is deliberate: the free-pool operator
// reset exists so judges can re-test the same pool, and pool admission is
// SUM(entitlements) <= totals — keeping entitlement rows would leave the
// pool exhausted and defeat the reset. Usage without entitlement is
// meaningless (Exceeded on an unknown wallet errors), so it goes too.
func (s *Store) RemoveWallet(w domain.WalletAddress) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.wallets[w.String()]; !ok {
		return false
	}
	delete(s.wallets, w.String())
	return true
}

// DistinctWallets counts wallets holding a positive entitlement slice.
func (s *Store) DistinctWallets() int {
	s.mu.RLock()
	defer s.mu.RUnlock()
	n := 0
	for _, r := range s.wallets {
		if r.entitlement.CPU > 0 || r.entitlement.MemMB > 0 {
			n++
		}
	}
	return n
}

// MarkSettled flips the settled flag; the first call wins and records the
// settle instant, which re-anchors token expiry (settledAt + window).
func (s *Store) MarkSettled() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.settled {
		return false
	}
	s.settled = true
	s.settledAt = s.now()
	return true
}

// IsSettled reports whether a Settled event was already processed.
func (s *Store) IsSettled() bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.settled
}

// SettledAt returns the instant the ledger settled, or zero if unsettled.
func (s *Store) SettledAt() time.Time {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.settledAt
}

// SetCurrentRound records the latest observed v2 funding round. Later rounds
// supersede earlier ones: entitlements stamped to a prior round stop
// authenticating (see Authenticate). Nil ids are ignored.
func (s *Store) SetCurrentRound(id *big.Int) {
	if id == nil || id.Sign() < 0 {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.currentRound = new(big.Int).Set(id)
}

// CurrentRound returns a copy of the latest observed round, or nil when no
// round was ever observed (legacy v1 mode: the allowlist stays inactive).
func (s *Store) CurrentRound() *big.Int {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if s.currentRound == nil {
		return nil
	}
	return new(big.Int).Set(s.currentRound)
}

// MarkRoundSettled flips one round's settled flag; the first call per round
// wins and records that round's settle instant, which re-anchors token
// expiry for entitlements stamped to it. Nil ids never flip.
func (s *Store) MarkRoundSettled(id *big.Int) bool {
	if id == nil || id.Sign() < 0 {
		return false
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	key := id.String()
	if _, ok := s.settledRounds[key]; ok {
		return false
	}
	s.settledRounds[key] = s.now()
	return true
}

// IsRoundSettled reports whether the round settled. Nil ids read unsettled.
func (s *Store) IsRoundSettled(id *big.Int) bool {
	if id == nil {
		return false
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	_, ok := s.settledRounds[id.String()]
	return ok
}

// RoundSettledAt returns the instant the round settled, or zero if unsettled.
func (s *Store) RoundSettledAt(id *big.Int) time.Time {
	if id == nil {
		return time.Time{}
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.settledRounds[id.String()]
}

// FundingClosed reports whether new allocations are final: the legacy v1
// pool settled, or the current round settled. An unsettled current round —
// funded or expired-unfilled — leaves this false; the expired-unfilled gate
// lives in the API poolGate, not here.
func (s *Store) FundingClosed() bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if s.settled {
		return true
	}
	if s.currentRound == nil {
		return false
	}
	_, ok := s.settledRounds[s.currentRound.String()]
	return ok
}

// StampRound pins a wallet's record to a funding round (nil clears back to
// the pre-round era). Unknown wallets are ignored. The allocate path uses it
// to pin the chain-resolved current round over the listener-fed stamp when
// the two disagree.
func (s *Store) StampRound(w domain.WalletAddress, id *big.Int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	r, ok := s.wallets[w.String()]
	if !ok {
		return
	}
	if id == nil {
		r.roundId = nil
		return
	}
	r.roundId = new(big.Int).Set(id)
}

// WalletRound returns the round stamped on a wallet's record (nil for the
// pre-round era), or nil with ErrUnknownWallet for unknown wallets.
func (s *Store) WalletRound(w domain.WalletAddress) (*big.Int, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	r, ok := s.wallets[w.String()]
	if !ok {
		return nil, fmt.Errorf("wallet %s: %w", w.String(), ErrUnknownWallet)
	}
	if r.roundId == nil {
		return nil, nil
	}
	return new(big.Int).Set(r.roundId), nil
}

// SetNowFunc swaps the clock; tests use it to advance time deterministically.
func (s *Store) SetNowFunc(fn func() time.Time) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.now = fn
}

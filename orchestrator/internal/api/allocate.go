package api

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"strings"

	"github.com/Jashk120/Coalition/orchestrator/internal/backend"
	"github.com/Jashk120/Coalition/orchestrator/internal/domain"
	"github.com/Jashk120/Coalition/orchestrator/internal/store"
)

type allocateRequest struct {
	Wallet string  `json:"wallet"`
	CPU    float64 `json:"cpu"`
	Mem    int64   `json:"mem"`
}

type allocateResponse struct {
	Wallet      string `json:"wallet"`
	ContainerID string `json:"containerId"`
	Token       string `json:"token"`
}

func (s *Server) handleAllocate(w http.ResponseWriter, r *http.Request) {
	var req allocateRequest
	if err := decodeJSON(r, &req); err != nil {
		writeJSONError(w, s.logger, badRequest("invalid JSON: "+err.Error()))
		return
	}
	wallet, err := domain.NewWalletAddress(req.Wallet)
	if err != nil {
		writeJSONError(w, s.logger, badRequest(err.Error()))
		return
	}
	ent, err := domain.NewEntitlement(req.CPU, req.Mem)
	if err != nil {
		writeJSONError(w, s.logger, badRequest(err.Error()))
		return
	}
	if !s.checkPoolGate(w, r) {
		return
	}
	// Reconcile the ledger's tracked round against the chain before
	// evaluating FundingClosed: after a rotate the poller can lag the new
	// round, leaving the prior settled round tracked and wrongly closing
	// funding for the fresh open round (every pre-settle allocate 409s
	// until the round itself settles). Advance-only and fail-open.
	s.syncCurrentRound(r.Context())
	// Post-settle gate: settled-round participants may still allocate (the
	// pool already paid the provider, so containers are owed), while wallets
	// with neither a pre-settle reservation nor on-chain stake stay 409
	// pool_settled and cannot mint free quota. See allowPostSettleAllocate.
	if s.ledger.FundingClosed() && !s.allowPostSettleAllocate(r.Context(), wallet) {
		writeJSONError(w, s.logger, poolSettled("pool settled: allocations are final"))
		return
	}
	if err := s.rejectShrink(wallet, ent); err != nil {
		writeJSONError(w, s.logger, err)
		return
	}
	cap := store.AdmitCap{
		TotalCPUMicro: store.MicroCU(s.cfg.CPUTotal),
		TotalMemMB:    s.cfg.MemMB,
		MaxAgents:     s.cfg.MaxAgents,
	}
	if _, err := s.ledger.Reserve(wallet, store.MicroCU(ent.CPU), ent.MemMB, cap); err != nil {
		writeJSONError(w, s.logger, err)
		return
	}
	s.pinAllocateRound(r.Context(), wallet)
	name := "coalition-" + strings.TrimPrefix(wallet.String(), "0x")
	id, err := s.backend.CreateContainer(r.Context(), name, backend.Limits{CPUCores: ent.CPU, MemMB: ent.MemMB})
	if err != nil {
		s.ledger.RollbackReserve(wallet)
		writeJSONError(w, s.logger, fmt.Errorf("create container: %w", err))
		return
	}
	if err := s.ledger.ConfirmReserve(wallet, id); err != nil {
		s.ledger.RollbackReserve(wallet)
		writeJSONError(w, s.logger, fmt.Errorf("confirm reservation: %w", err))
		return
	}
	token, err := s.ledger.IssueToken(wallet)
	if err != nil {
		writeJSONError(w, s.logger, fmt.Errorf("issue token: %w", err))
		return
	}
	s.logger.Info("allocate",
		slog.String("wallet", wallet.String()),
		slog.Float64("cpu", ent.CPU),
		slog.Int64("memMB", ent.MemMB),
		slog.String("container", id))
	writeJSON(w, http.StatusCreated, allocateResponse{Wallet: wallet.String(), ContainerID: id, Token: token})
}

// syncCurrentRound advances the ledger's tracked v2 round when the chain is
// ahead (rotate opened N+1 while the settle poller lagged), so FundingClosed
// is evaluated against the live round instead of the prior settled one.
// Advance-only: it never marks anything settled, and any read failure keeps
// the old round (fail-open — a down node must not brick allocation).
func (s *Server) syncCurrentRound(ctx context.Context) {
	if s.cfg.PoolV2Address == "" {
		return
	}
	rr, ok := s.verifier.(roundReader)
	if !ok {
		return
	}
	id, err := rr.CurrentRoundId(ctx, s.cfg.PoolV2Address, "latest")
	if err != nil || id == nil {
		return
	}
	if cur := s.ledger.CurrentRound(); cur == nil || cur.Cmp(id) < 0 {
		s.ledger.SetCurrentRound(id)
	}
}

// allowPostSettleAllocate decides whether a wallet may allocate after the
// ledger's funding gate closed. Two proofs, checked in order:
//
//  1. Local pre-settle reservation: the wallet already holds a ledger entry
//     (allocate, re-allocate/top-up, or transfer-created recipient). No chain
//     read is needed, so a down node never blocks owed containers.
//  2. Chain proof of participation: committed(settledRound, wallet) > 0 at
//     the v2 pool. This path is fail-CLOSED: an unset pool address, a
//     verifier without the round surface, or any node error denies with
//     false (the caller maps it to 409 pool_settled), so an unreachable node
//     can never mint free post-settle quota. This is deliberately stricter
//     than poolGate's fail-open: that gate guards liveness of metering,
//     this one guards minting of quota.
//
// Token expiry on the grant path anchors at settledAt + WINDOW_HOURS: the
// round's settle instant (ledger's settledRounds entry, recorded here when
// the listener has not seen it yet) is the validity base (see
// Store.Authenticate), so pre-settle allocations stay usable through the
// compute window and WINDOW_HOURS=1 demos still expire one hour after
// settle.
func (s *Server) allowPostSettleAllocate(ctx context.Context, wallet domain.WalletAddress) bool {
	if s.ledger.HasWallet(wallet) {
		return true
	}
	return s.verifySettledParticipation(ctx, wallet)
}

// verifySettledParticipation proves a reservation-less wallet funded the
// settled v2 round: it resolves the chain's current round, requires the
// round's own settled view (the ledger flip alone never grants), records
// the round's settle instant for token expiry, then requires nonzero stake.
// Every failure denies.
func (s *Server) verifySettledParticipation(ctx context.Context, wallet domain.WalletAddress) bool {
	if s.cfg.PoolV2Address == "" {
		s.logger.Warn("post-settle allocate denied: POOL_V2_ADDRESS empty, no chain to prove against")
		return false
	}
	cr, ok := s.verifier.(settledParticipationReader)
	if !ok {
		s.logger.Warn("post-settle allocate denied: verifier has no participation surface")
		return false
	}
	roundId, err := cr.CurrentRoundId(ctx, s.cfg.PoolV2Address, "latest")
	if err != nil {
		s.logger.Warn("post-settle allocate denied fail-closed: node unreachable",
			slog.String("pool", s.cfg.PoolV2Address),
			slog.Any("err", err))
		return false
	}
	views, err := cr.ReadRoundViews(ctx, s.cfg.PoolV2Address, roundId)
	if err != nil {
		s.logger.Warn("post-settle allocate denied fail-closed: round views unreadable",
			slog.String("pool", s.cfg.PoolV2Address),
			slog.String("round", roundId.String()),
			slog.Any("err", err))
		return false
	}
	if !views.Settled {
		s.logger.Warn("post-settle allocate denied: chain round not settled",
			slog.String("pool", s.cfg.PoolV2Address),
			slog.String("round", roundId.String()))
		return false
	}
	stake, err := cr.ReadCommitted(ctx, s.cfg.PoolV2Address, roundId, wallet.String())
	if err != nil {
		s.logger.Warn("post-settle allocate denied fail-closed: stake unreadable",
			slog.String("pool", s.cfg.PoolV2Address),
			slog.String("round", roundId.String()),
			slog.Any("err", err))
		return false
	}
	if stake == nil || stake.Sign() <= 0 {
		return false
	}
	// First observation wins, mirroring the listener: it anchors token
	// expiry at this round's settle instant + window.
	s.ledger.MarkRoundSettled(roundId)
	return true
}

// pinAllocateRound pins the wallet's entitlement to the chain-resolved v2
// current round when round tracking is configured. The ledger's
// listener-fed stamp may lag a freshly opened round; the chain read wins so
// a new round's first allocations are not orphaned onto the prior round.
// Fail-open: an unreachable node (or a verifier without round views) keeps
// the existing stamp, never fails the allocate.
func (s *Server) pinAllocateRound(ctx context.Context, wallet domain.WalletAddress) {
	if s.cfg.PoolV2Address == "" {
		return
	}
	rr, ok := s.verifier.(roundReader)
	if !ok {
		return
	}
	roundId, err := rr.CurrentRoundId(ctx, s.cfg.PoolV2Address, "latest")
	if err != nil {
		s.logger.Warn("allocate round stamp fail-open: node unreachable",
			slog.String("pool", s.cfg.PoolV2Address),
			slog.Any("err", err))
		return
	}
	s.ledger.StampRound(wallet, roundId)
}

// rejectShrink refuses a re-allocate that would drop entitlement below
// already-burned usage: applying it would manufacture an instantly
// over-budget wallet with no new spend. Grow-or-hold only.
func (s *Server) rejectShrink(wallet domain.WalletAddress, ent domain.Entitlement) error {
	usage, err := s.ledger.Usage(wallet)
	if err != nil {
		return nil
	}
	windowSec := float64(s.cfg.WindowHours) * 3600
	if usage.CUSeconds > ent.CPU*windowSec || usage.MBHours > float64(ent.MemMB)*float64(s.cfg.WindowHours) {
		return insufficientQuota(fmt.Sprintf(
			"wallet %s resize below burned usage would go instantly over budget", wallet.String()))
	}
	return nil
}

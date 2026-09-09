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
	if s.ledger.FundingClosed() {
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

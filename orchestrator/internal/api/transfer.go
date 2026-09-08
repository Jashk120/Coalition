package api

import (
	"fmt"
	"math"
	"net/http"

	"github.com/Jashk120/Coalition/orchestrator/internal/domain"
	"github.com/Jashk120/Coalition/orchestrator/internal/store"
)

type transferRequest struct {
	From   string  `json:"from"`
	To     string  `json:"to"`
	MB     int64   `json:"mb"`
	CU     float64 `json:"cu"`
	TxHash string  `json:"txHash"`
}

type quotaSlice struct {
	Wallet      string  `json:"wallet"`
	CPU         float64 `json:"cpu"`
	MemMB       int64   `json:"memMB"`
	RemainingCU float64 `json:"remainingCU"`
	RemainingMB int64   `json:"remainingMB"`
}

type transferResponse struct {
	From    quotaSlice `json:"from"`
	To      quotaSlice `json:"to"`
	ToToken string     `json:"toToken,omitempty"`
}

func (s *Server) handleTransfer(w http.ResponseWriter, r *http.Request) {
	var req transferRequest
	if err := decodeJSON(r, &req); err != nil {
		writeJSONError(w, s.logger, badRequest("invalid JSON: "+err.Error()))
		return
	}
	from, err := domain.NewWalletAddress(req.From)
	if err != nil {
		writeJSONError(w, s.logger, badRequest(err.Error()))
		return
	}
	to, err := domain.NewWalletAddress(req.To)
	if err != nil {
		writeJSONError(w, s.logger, badRequest(err.Error()))
		return
	}
	if !s.authenticateWallet(w, from, r) {
		return
	}
	if math.IsNaN(req.CU) || math.IsInf(req.CU, 0) || req.MB < 0 || req.CU < 0 || (req.MB == 0 && req.CU == 0) {
		writeJSONError(w, s.logger, badRequest(fmt.Sprintf("mb=%d cu=%v: amounts must be non-negative with at least one dimension moved", req.MB, req.CU)))
		return
	}
	if !validTxHash(req.TxHash) {
		writeJSONError(w, s.logger, badRequest("txHash must be a 0x-prefixed 32-byte hex transaction hash"))
		return
	}
	if !s.checkPoolGate(w, r) {
		return
	}
	cuMicro := store.MicroCU(req.CU)
	if err := s.ledger.CheckTransfer(from, req.MB, cuMicro); err != nil {
		writeJSONError(w, s.logger, fmt.Errorf("transfer quota: %w", err))
		return
	}
	cost, err := transferCost(s.cfg.TargetAtomic, s.cfg.MemMB, s.cfg.CPUTotal, req.CU, req.MB)
	if err != nil {
		writeJSONError(w, s.logger, badRequest(err.Error()))
		return
	}
	if err := verifyTransferReceipt(r.Context(), s.verifier, s.cfg.Confirmations, req.TxHash, to, from, cost); err != nil {
		writeJSONError(w, s.logger, err)
		return
	}
	// Racer note: the pre-check above and this commit are separated by the
	// receipt read, so a concurrent spender can win between them and this
	// call fails after the buyer already paid. That payment is inherently
	// unrecoverable with direct transfers — the chain has no escrow to
	// refund it. x402 receipts (facilitator-held, settle-on-delivery) are
	// the follow-up that closes this hole.
	toToken, err := s.ledger.TransferPaid(from, to, req.MB, cuMicro, req.TxHash, s.cfg.MaxAgents)
	if err != nil {
		writeJSONError(w, s.logger, fmt.Errorf("transfer quota: %w", err))
		return
	}
	fromSlice, err := s.slice(from)
	if err != nil {
		writeJSONError(w, s.logger, err)
		return
	}
	toSlice, err := s.slice(to)
	if err != nil {
		writeJSONError(w, s.logger, err)
		return
	}
	writeJSON(w, http.StatusOK, transferResponse{From: fromSlice, To: toSlice, ToToken: toToken})
}

func (s *Server) slice(wallet domain.WalletAddress) (quotaSlice, error) {
	ent, err := s.ledger.Entitlement(wallet)
	if err != nil {
		return quotaSlice{}, err
	}
	remCPU, remMB, err := s.ledger.RemainingCapacity(wallet)
	if err != nil {
		return quotaSlice{}, err
	}
	return quotaSlice{
		Wallet:      wallet.String(),
		CPU:         ent.CPU,
		MemMB:       ent.MemMB,
		RemainingCU: remCPU,
		RemainingMB: remMB,
	}, nil
}

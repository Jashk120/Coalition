package api

import (
	"crypto/sha256"
	"crypto/subtle"
	"fmt"
	"math"
	"math/big"
	"net/http"
	"sort"
	"strings"

	"github.com/Jashk120/Coalition/orchestrator/internal/domain"
	"github.com/Jashk120/Coalition/orchestrator/internal/store"
)

// Multi-leg resale trust boundary.
//
// The per-leg x402 Gateway middleware (app/app/api/resale/quota/route.ts via
// createGatewayMiddleware require(price) -> next()) already verifies AND
// settles each leg inline: next() means paid, and req.payment.transaction is
// the Gateway settle transaction the app forwards as settlementId.
//
// Go must never settle and must never re-verify against a custom facilitator
// endpoint: no real facilitator exposes POST {base}/verify, so such a call is
// a guaranteed fail-closed AFTER inline settle (paid-without-delivery), and a
// Go-side settle would double-charge legs the middleware already settled.
// Instead the operator-attested settlementId plus the existing
// CheckSettlementsUnused spend-once guard plus the TransferMultiPaid atomic
// commit is the proof — the same trust boundary as /allocate minting quota on
// the app key alone.
//
// Quota commit is atomic; funds settle per-leg inline and can strand on
// later-leg failure — see manifest. A failed TransferMultiPaid moves no quota
// and consumes no settlement ids, but USDC for already-paid legs is already
// settled and is reconcilable only via the app-side paid-legs manifest.

// checkAppKey enforces the operator tier inside handlers that multiplex rails
// (the router-level requireAppKey cannot split single vs multi-leg). It
// mirrors requireAppKey semantics: 401 missing, 403 wrong.
func (s *Server) checkAppKey(w http.ResponseWriter, r *http.Request) bool {
	if s.appAuthOpen {
		return true
	}
	presented := r.Header.Get(appKeyHeader)
	if presented == "" {
		writeJSONError(w, s.logger, unauthorized("operator app key required"))
		return false
	}
	sum := sha256.Sum256([]byte(presented))
	if subtle.ConstantTimeCompare(sum[:], s.appKeyHash[:]) != 1 {
		writeJSONError(w, s.logger, forbidden("operator app key rejected"))
		return false
	}
	return true
}

type fillPlanRequest struct {
	Wallet string  `json:"wallet"`
	CU     float64 `json:"cu"`
	Mem    int64   `json:"mem"`
}

type fillPlanLeg struct {
	Wallet       string `json:"wallet"`
	MB           int64  `json:"mb"`
	CUMicro      int64  `json:"cuMicro"`
	AmountAtomic string `json:"amountAtomic"`
}

type fillPlanResponse struct {
	Sellers     []fillPlanLeg `json:"sellers"`
	TotalAtomic string        `json:"totalAtomic"`
}

func (s *Server) handleFillPlan(w http.ResponseWriter, r *http.Request) {
	var req fillPlanRequest
	if err := decodeJSON(r, &req); err != nil {
		writeJSONError(w, s.logger, badRequest("invalid JSON: "+err.Error()))
		return
	}
	buyer, err := domain.NewWalletAddress(req.Wallet)
	if err != nil {
		writeJSONError(w, s.logger, badRequest(err.Error()))
		return
	}
	if math.IsNaN(req.CU) || math.IsInf(req.CU, 0) || req.Mem < 0 || req.CU < 0 || (req.Mem == 0 && req.CU == 0) {
		writeJSONError(w, s.logger, badRequest(fmt.Sprintf("mem=%d cu=%v: amounts must be non-negative with at least one dimension wanted", req.Mem, req.CU)))
		return
	}
	if !s.checkPoolGate(w, r) {
		return
	}
	needMB := req.Mem
	needMicro := store.MicroCU(req.CU)
	spares := s.ledger.Spares(buyer)
	sort.Slice(spares, func(i, j int) bool {
		if spares[i].RemMBHours != spares[j].RemMBHours {
			return spares[i].RemMBHours > spares[j].RemMBHours
		}
		return spares[i].Wallet < spares[j].Wallet
	})
	sellers := []fillPlanLeg{}
	total := big.NewInt(0)
	for _, sp := range spares {
		if needMB <= 0 && needMicro <= 0 {
			break
		}
		maxMB := sp.RemMem - 1
		if maxMB < 0 {
			maxMB = 0
		}
		maxCU := sp.RemMicro - 1
		if maxCU < 0 {
			maxCU = 0
		}
		takeMB := needMB
		if takeMB > maxMB {
			takeMB = maxMB
		}
		takeCU := needMicro
		if takeCU > maxCU {
			takeCU = maxCU
		}
		if takeMB <= 0 && takeCU <= 0 {
			continue
		}
		cost, err := transferCost(s.cfg.TargetAtomic, s.cfg.MemMB, s.cfg.CPUTotal, float64(takeCU)/1e6, takeMB)
		if err != nil {
			writeJSONError(w, s.logger, badRequest(err.Error()))
			return
		}
		seller, err := domain.NewWalletAddress(sp.Wallet)
		if err != nil {
			continue
		}
		sellers = append(sellers, fillPlanLeg{
			Wallet:       seller.String(),
			MB:           takeMB,
			CUMicro:      takeCU,
			AmountAtomic: cost.String(),
		})
		total.Add(total, cost)
		needMB -= takeMB
		needMicro -= takeCU
	}
	if needMB > 0 || needMicro > 0 {
		writeJSONError(w, s.logger, insufficientSpare(fmt.Sprintf("want mem=%d cuMicro=%d exceeds total spare", req.Mem, store.MicroCU(req.CU))))
		return
	}
	writeJSON(w, http.StatusOK, fillPlanResponse{Sellers: sellers, TotalAtomic: total.String()})
}

type transferLeg struct {
	Seller string  `json:"seller"`
	MB     int64   `json:"mb"`
	CU     float64 `json:"cu"`
}

type transferPayment struct {
	Seller       string `json:"seller"`
	AmountAtomic string `json:"amountAtomic"`
	SettlementID string `json:"settlementId"`
}

type multiTransferResponse struct {
	Sellers []quotaSlice `json:"sellers"`
	To      quotaSlice   `json:"to"`
	ToToken string       `json:"toToken,omitempty"`
}

func (s *Server) handleTransferMulti(w http.ResponseWriter, r *http.Request, req transferRequest) {
	if strings.TrimSpace(req.TxHash) != "" {
		writeJSONError(w, s.logger, badRequest("exactly one rail required: txHash or legs+payments, not both"))
		return
	}
	if !s.checkAppKey(w, r) {
		return
	}
	buyer, err := domain.NewWalletAddress(req.To)
	if err != nil {
		writeJSONError(w, s.logger, badRequest(err.Error()))
		return
	}
	if len(req.Legs) == 0 || len(req.Legs) != len(req.Payments) {
		writeJSONError(w, s.logger, badRequest(fmt.Sprintf("legs=%d payments=%d: counts must match and be non-empty", len(req.Legs), len(req.Payments))))
		return
	}
	if int64(len(req.Legs)) > s.cfg.MaxAgents {
		writeJSONError(w, s.logger, badRequest(fmt.Sprintf("legs=%d exceeds cap %d", len(req.Legs), s.cfg.MaxAgents)))
		return
	}
	sellers := make([]domain.WalletAddress, len(req.Legs))
	amounts := make([]*big.Int, len(req.Legs))
	for i, leg := range req.Legs {
		seller, err := domain.NewWalletAddress(leg.Seller)
		if err != nil {
			writeJSONError(w, s.logger, badRequest(fmt.Sprintf("legs[%d]: %v", i, err)))
			return
		}
		if math.IsNaN(leg.CU) || math.IsInf(leg.CU, 0) || leg.MB < 0 || leg.CU < 0 || (leg.MB == 0 && leg.CU == 0) {
			writeJSONError(w, s.logger, badRequest(fmt.Sprintf("legs[%d] mb=%d cu=%v: amounts must be non-negative with at least one dimension moved", i, leg.MB, leg.CU)))
			return
		}
		pay := req.Payments[i]
		paySeller, err := domain.NewWalletAddress(pay.Seller)
		if err != nil {
			writeJSONError(w, s.logger, badRequest(fmt.Sprintf("payments[%d]: %v", i, err)))
			return
		}
		if paySeller.String() != seller.String() {
			writeJSONError(w, s.logger, badRequest(fmt.Sprintf("legs[%d].seller %s != payments[%d].seller %s", i, seller.String(), i, paySeller.String())))
			return
		}
		amount, ok := new(big.Int).SetString(strings.TrimSpace(pay.AmountAtomic), 10)
		if !ok || amount.Sign() < 0 {
			writeJSONError(w, s.logger, badRequest(fmt.Sprintf("payments[%d].amountAtomic %q is not a uint decimal string", i, pay.AmountAtomic)))
			return
		}
		if strings.TrimSpace(pay.SettlementID) == "" {
			writeJSONError(w, s.logger, badRequest(fmt.Sprintf("payments[%d].settlementId is required", i)))
			return
		}
		cost, err := transferCost(s.cfg.TargetAtomic, s.cfg.MemMB, s.cfg.CPUTotal, leg.CU, leg.MB)
		if err != nil {
			writeJSONError(w, s.logger, badRequest(fmt.Sprintf("legs[%d]: %v", i, err)))
			return
		}
		if amount.Cmp(cost) < 0 {
			writeJSONError(w, s.logger, paymentRequired(fmt.Sprintf("legs[%d] amount %s below quoted cost %s", i, amount, cost)))
			return
		}
		sellers[i] = seller
		amounts[i] = amount
	}
	if !s.checkPoolGate(w, r) {
		return
	}
	ids := make([]string, len(req.Payments))
	for i, pay := range req.Payments {
		ids[i] = pay.SettlementID
	}
	if err := s.ledger.CheckSettlementsUnused(ids); err != nil {
		writeJSONError(w, s.logger, err)
		return
	}
	// No facilitator verify here by design (see trust boundary above): the
	// operator-attested settlementId + spend-once + atomic commit is the
	// proof. Quota commit is atomic; funds settle per-leg inline and can
	// strand on later-leg failure — see manifest.
	mlegs := make([]store.MultiLeg, len(req.Legs))
	for i, leg := range req.Legs {
		mlegs[i] = store.MultiLeg{Seller: sellers[i], MB: leg.MB, CUMicro: store.MicroCU(leg.CU)}
	}
	toToken, err := s.ledger.TransferMultiPaid(buyer, mlegs, ids, s.cfg.MaxAgents)
	if err != nil {
		writeJSONError(w, s.logger, fmt.Errorf("transfer quota: %w", err))
		return
	}
	seen := make(map[string]bool, len(sellers))
	out := []quotaSlice{}
	for _, seller := range sellers {
		if seen[seller.String()] {
			continue
		}
		seen[seller.String()] = true
		sl, err := s.slice(seller)
		if err != nil {
			writeJSONError(w, s.logger, err)
			return
		}
		out = append(out, sl)
	}
	toSlice, err := s.slice(buyer)
	if err != nil {
		writeJSONError(w, s.logger, err)
		return
	}
	writeJSON(w, http.StatusOK, multiTransferResponse{Sellers: out, To: toSlice, ToToken: toToken})
}

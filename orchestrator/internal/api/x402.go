package api

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"math"
	"math/big"
	"net/http"
	"sort"
	"strconv"
	"strings"

	"github.com/Jashk120/Coalition/orchestrator/internal/domain"
	"github.com/Jashk120/Coalition/orchestrator/internal/money"
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

type fillPlanOutput struct {
	Account      string `json:"account"`
	AmountAtomic string `json:"amountAtomic"`
}

type fillPlanResponse struct {
	Outputs         []fillPlanOutput `json:"outputs"`
	TotalAtomic     string           `json:"totalAtomic"`
	Nonce           string           `json:"nonce"`
	RoundId         string           `json:"roundId"`
	HeadroomMB      int64            `json:"headroomMB"`
	HeadroomCUMicro int64            `json:"headroomCUMicro"`
}

func chainUnreadable(msg string) *APIError {
	return &APIError{Status: http.StatusBadGateway, Code: "chain_unreadable", Message: msg}
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
	needMicro := store.MicroCU(req.CU)
	freeMicro, freeMem := s.ledger.Headroom(store.MicroCU(s.cfg.CPUTotal), s.cfg.MemMB)
	if req.Mem > freeMem || needMicro > freeMicro {
		writeJSONError(w, s.logger, insufficientSpare(fmt.Sprintf("want mem=%d cuMicro=%d exceeds total spare", req.Mem, needMicro)))
		return
	}
	s.syncCurrentRound(r.Context())
	roundId := s.ledger.CurrentRound()
	if roundId == nil {
		s.logger.Warn("fill-plan denied fail-closed: no tracked funding round")
		writeJSONError(w, s.logger, chainUnreadable("fill-plan denied: no tracked funding round"))
		return
	}
	cr, ok := s.verifier.(settledParticipationReader)
	if !ok {
		s.logger.Warn("fill-plan denied fail-closed: verifier has no commitment surface")
		writeJSONError(w, s.logger, chainUnreadable("fill-plan denied: locked amounts unreadable"))
		return
	}
	rateMB, err := money.RatePerMB(s.cfg.TargetAtomic, s.cfg.MemMB)
	if err != nil {
		writeJSONError(w, s.logger, fmt.Errorf("rate per MB: %w", err))
		return
	}
	rateCU, err := money.RatePerCU(s.cfg.TargetAtomic, s.cfg.CPUTotal)
	if err != nil {
		writeJSONError(w, s.logger, fmt.Errorf("rate per CU: %w", err))
		return
	}
	wallets := s.ledger.Wallets()
	sort.Strings(wallets)
	locked := make(map[string]*big.Int, len(wallets))
	used := make(map[string]*big.Int, len(wallets))
	agents := make([]string, 0, len(wallets))
	for _, wstr := range wallets {
		if wstr == buyer.String() {
			continue
		}
		stake, err := cr.ReadCommitted(r.Context(), s.cfg.PoolV2Address, roundId, wstr)
		if err != nil {
			s.logger.Warn("fill-plan denied fail-closed: stake unreadable",
				slog.String("wallet", wstr),
				slog.String("round", roundId.String()),
				slog.Any("err", err))
			writeJSONError(w, s.logger, chainUnreadable("fill-plan denied: locked amounts unreadable"))
			return
		}
		if stake == nil {
			stake = big.NewInt(0)
		}
		locked[wstr] = stake
		addr, err := domain.NewWalletAddress(wstr)
		if err != nil {
			writeJSONError(w, s.logger, fmt.Errorf("ledger wallet %q: %w", wstr, err))
			return
		}
		usage, err := s.ledger.Usage(addr)
		if err != nil {
			writeJSONError(w, s.logger, fmt.Errorf("ledger usage %q: %w", wstr, err))
			return
		}
		ent, err := s.ledger.Entitlement(addr)
		if err != nil {
			writeJSONError(w, s.logger, fmt.Errorf("ledger entitlement %q: %w", wstr, err))
			return
		}
		cost, err := imputedCost(usage, rateMB, rateCU, s.cfg.WindowHours)
		if err != nil {
			writeJSONError(w, s.logger, badRequest(err.Error()))
			return
		}
		used[wstr] = new(big.Int).Add(sliceValue(ent, rateMB, rateCU), cost)
		agents = append(agents, wstr)
	}
	shares, err := store.PayoutShares(locked, used)
	if err != nil {
		if errors.Is(err, store.ErrNoPayoutSkew) {
			writeJSONError(w, s.logger, insufficientSpare(fmt.Sprintf("want mem=%d cuMicro=%d: no skewed agents to pay", req.Mem, needMicro)))
			return
		}
		writeJSONError(w, s.logger, fmt.Errorf("payout shares: %w", err))
		return
	}
	total, err := transferCost(s.cfg.TargetAtomic, s.cfg.MemMB, s.cfg.CPUTotal, req.CU, req.Mem)
	if err != nil {
		writeJSONError(w, s.logger, badRequest(err.Error()))
		return
	}
	amounts := make(map[string]*big.Int, len(agents))
	paid := make([]string, 0, len(agents))
	sum := big.NewInt(0)
	for _, a := range agents {
		amt := new(big.Int).Quo(new(big.Int).Mul(total, shares[a].Num()), shares[a].Denom())
		amounts[a] = amt
		sum.Add(sum, amt)
		if shares[a].Sign() > 0 {
			paid = append(paid, a)
		}
	}
	for i := 0; new(big.Int).Sub(total, sum).Sign() > 0; i++ {
		amounts[paid[i%len(paid)]].Add(amounts[paid[i%len(paid)]], big.NewInt(1))
		sum.Add(sum, big.NewInt(1))
	}
	var raw [32]byte
	if _, err := rand.Read(raw[:]); err != nil {
		writeJSONError(w, s.logger, fmt.Errorf("mint plan nonce: %w", err))
		return
	}
	outputs := make([]fillPlanOutput, 0, len(agents))
	for _, a := range agents {
		if amounts[a].Sign() <= 0 {
			continue
		}
		outputs = append(outputs, fillPlanOutput{Account: a, AmountAtomic: amounts[a].String()})
	}
	writeJSON(w, http.StatusOK, fillPlanResponse{
		Outputs:         outputs,
		TotalAtomic:     total.String(),
		Nonce:           hex.EncodeToString(raw[:]),
		RoundId:         roundId.String(),
		HeadroomMB:      freeMem,
		HeadroomCUMicro: freeMicro,
	})
}

// sliceValue prices a granted slice at cost basis with bigint math only:
// floor(cpuMicro*rateCU/1e6 + memMB*rateMB). Payout skew subtracts this from
// the lock together with burned usage, so equal locks on unequal slices
// split correctly: the wallet overpaying per unit of compute keeps the
// larger unrecouped share. Integer micro-CU throughout, no float.
func sliceValue(ent domain.Entitlement, rateMB, rateCU *big.Int) *big.Int {
	cu := new(big.Int).Quo(
		new(big.Int).Mul(big.NewInt(store.MicroCU(ent.CPU)), rateCU),
		big.NewInt(1_000_000),
	)
	return new(big.Int).Add(cu, new(big.Int).Mul(big.NewInt(ent.MemMB), rateMB))
}

// imputedCost prices burned usage at cost basis with bigint math only:
// floor(usedCUSeconds*rateCU/(windowHrs*3600) + usedMBHours*rateMB/windowHrs).
// Usage counters are cumulative over the window while the rates price one
// window of the slice, so each leg is time-spread exactly like
// remainingLocked — without the spread a single hour of burn would impute
// ~3600x its value and zero every payout skew. Both usage dimensions are
// floats, so each rides big.Rat exactly like the transferCost cu leg.
func imputedCost(usage domain.Usage, rateMB, rateCU *big.Int, windowHrs int64) (*big.Int, error) {
	cuRat, ok := new(big.Rat).SetString(strconv.FormatFloat(usage.CUSeconds, 'g', -1, 64))
	if !ok {
		return nil, fmt.Errorf("cuSeconds=%v: %w", usage.CUSeconds, domain.ErrInvalidQuota)
	}
	mbRat, ok := new(big.Rat).SetString(strconv.FormatFloat(usage.MBHours, 'g', -1, 64))
	if !ok {
		return nil, fmt.Errorf("mbHours=%v: %w", usage.MBHours, domain.ErrInvalidQuota)
	}
	spread := new(big.Rat).SetInt64(windowHrs)
	legs := new(big.Rat).Add(
		new(big.Rat).Quo(new(big.Rat).Mul(new(big.Rat).SetInt(rateCU), cuRat), new(big.Rat).Mul(spread, big.NewRat(3600, 1))),
		new(big.Rat).Quo(new(big.Rat).Mul(new(big.Rat).SetInt(rateMB), mbRat), spread),
	)
	return new(big.Int).Quo(legs.Num(), legs.Denom()), nil
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

const commitMintMulticall = "0xcA11bde05977b3631167028862bE2a173976CA11"
const commitMintUSDC = "0x3600000000000000000000000000000000000000"
const commitMintTransferSig = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"

type commitMintOutput struct {
	Account      string `json:"account"`
	AmountAtomic string `json:"amountAtomic"`
}

type commitMintRequest struct {
	To               string             `json:"to"`
	MB               int64              `json:"mb"`
	CUMicro          int64              `json:"cuMicro"`
	SettlementTxHash string             `json:"settlementTxHash"`
	Nonce            string             `json:"nonce"`
	RoundId          string             `json:"roundId"`
	Outputs          []commitMintOutput `json:"outputs"`
}

type commitMintResponse struct {
	To      quotaSlice `json:"to"`
	ToToken string     `json:"toToken,omitempty"`
}

func validHex64(s string) bool {
	if len(s) != 64 {
		return false
	}
	for _, c := range s {
		if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f' || c >= 'A' && c <= 'F') {
			return false
		}
	}
	return true
}

func padTopic(addr string) string {
	hexed := strings.ToLower(strings.TrimPrefix(strings.TrimSpace(addr), "0x"))
	return "0x" + strings.Repeat("0", 64-len(hexed)) + hexed
}

func parseTopicUint(data string) (*big.Int, bool) {
	s := strings.TrimSpace(data)
	if len(s) < 3 || s[0] != '0' || (s[1] != 'x' && s[1] != 'X') {
		return nil, false
	}
	v, ok := new(big.Int).SetString(s[2:], 16)
	if !ok || v.Sign() < 0 {
		return nil, false
	}
	return v, true
}

func (s *Server) handleCommitMint(w http.ResponseWriter, r *http.Request) {
	if !s.checkAppKey(w, r) {
		return
	}
	var req commitMintRequest
	if err := decodeJSON(r, &req); err != nil {
		writeJSONError(w, s.logger, badRequest("invalid JSON: "+err.Error()))
		return
	}
	buyer, err := domain.NewWalletAddress(req.To)
	if err != nil {
		writeJSONError(w, s.logger, badRequest(err.Error()))
		return
	}
	if req.MB < 0 || req.CUMicro < 0 || (req.MB == 0 && req.CUMicro == 0) {
		writeJSONError(w, s.logger, badRequest(fmt.Sprintf("mb=%d cuMicro=%d: amounts must be non-negative with at least one dimension minted", req.MB, req.CUMicro)))
		return
	}
	if len(req.Outputs) == 0 || int64(len(req.Outputs)) > s.cfg.MaxAgents {
		writeJSONError(w, s.logger, badRequest(fmt.Sprintf("outputs=%d: must be non-empty within cap %d", len(req.Outputs), s.cfg.MaxAgents)))
		return
	}
	accts := make([]string, len(req.Outputs))
	amounts := make([]*big.Int, len(req.Outputs))
	sum := big.NewInt(0)
	for i, o := range req.Outputs {
		acct, err := domain.NewWalletAddress(o.Account)
		if err != nil {
			writeJSONError(w, s.logger, badRequest(fmt.Sprintf("outputs[%d]: %v", i, err)))
			return
		}
		if acct.String() == buyer.String() {
			writeJSONError(w, s.logger, badRequest(fmt.Sprintf("outputs[%d] pays the buyer itself", i)))
			return
		}
		if i > 0 && accts[i-1] >= acct.String() {
			writeJSONError(w, s.logger, badRequest("outputs must be wallet-asc unique"))
			return
		}
		amt, ok := new(big.Int).SetString(strings.TrimSpace(o.AmountAtomic), 10)
		if !ok || amt.Sign() <= 0 {
			writeJSONError(w, s.logger, badRequest(fmt.Sprintf("outputs[%d].amountAtomic %q is not a positive uint decimal string", i, o.AmountAtomic)))
			return
		}
		accts[i] = acct.String()
		amounts[i] = amt
		sum.Add(sum, amt)
	}
	if !validTxHash(req.SettlementTxHash) {
		writeJSONError(w, s.logger, badRequest("settlementTxHash must be a 0x-prefixed 32-byte hex transaction hash"))
		return
	}
	if !validHex64(strings.TrimSpace(req.Nonce)) {
		writeJSONError(w, s.logger, badRequest("nonce must be 32 bytes hex"))
		return
	}
	if strings.TrimSpace(req.RoundId) == "" {
		writeJSONError(w, s.logger, badRequest("roundId is required"))
		return
	}
	total, err := transferCost(s.cfg.TargetAtomic, s.cfg.MemMB, s.cfg.CPUTotal, float64(req.CUMicro)/1e6, req.MB)
	if err != nil {
		writeJSONError(w, s.logger, badRequest(err.Error()))
		return
	}
	if sum.Cmp(total) != 0 {
		writeJSONError(w, s.logger, paymentRequired(fmt.Sprintf("outputs sum %s != quoted cost %s", sum, total)))
		return
	}
	s.syncCurrentRound(r.Context())
	if cur := s.ledger.CurrentRound(); cur == nil {
		s.logger.Warn("commit-mint denied fail-closed: no tracked funding round")
		writeJSONError(w, s.logger, chainUnreadable("commit-mint denied: no tracked funding round"))
		return
	} else if cur.String() != strings.TrimSpace(req.RoundId) {
		writeJSONError(w, s.logger, badRequest(fmt.Sprintf("roundId %q != current round %s: refresh the fill plan", req.RoundId, cur)))
		return
	}
	if !s.checkPoolGate(w, r) {
		return
	}
	if err := s.verifySettlementAggregate(r.Context(), req.SettlementTxHash, buyer, accts, amounts); err != nil {
		writeJSONError(w, s.logger, err)
		return
	}
	toToken, err := s.ledger.MintFromHeadroom(buyer, req.MB, req.CUMicro, []string{req.SettlementTxHash}, s.cfg.MaxAgents, store.MicroCU(s.cfg.CPUTotal), s.cfg.MemMB)
	if err != nil {
		writeJSONError(w, s.logger, fmt.Errorf("commit mint: %w", err))
		return
	}
	toSlice, err := s.slice(buyer)
	if err != nil {
		writeJSONError(w, s.logger, err)
		return
	}
	writeJSON(w, http.StatusOK, commitMintResponse{To: toSlice, ToToken: toToken})
}

func (s *Server) verifySettlementAggregate(ctx context.Context, txHash string, buyer domain.WalletAddress, accts []string, amounts []*big.Int) error {
	receipt, err := s.verifier.TransactionReceipt(ctx, txHash)
	if err != nil {
		return paymentRequired(fmt.Sprintf("receipt for %s unavailable: %v", txHash, err))
	}
	if receipt.Status != "0x1" && receipt.Status != "1" {
		return paymentRequired(fmt.Sprintf("tx %s status %q is not success", txHash, receipt.Status))
	}
	if !strings.EqualFold(receipt.From, buyer.String()) {
		return paymentRequired(fmt.Sprintf("tx %s from %s, want buyer %s", txHash, receipt.From, buyer.String()))
	}
	if !strings.EqualFold(receipt.To, commitMintMulticall) {
		return paymentRequired(fmt.Sprintf("tx %s to %s, want Multicall3 %s", txHash, receipt.To, commitMintMulticall))
	}
	head, err := s.verifier.BlockNumber(ctx)
	if err != nil {
		return paymentRequired(fmt.Sprintf("head unavailable for %s: %v", txHash, err))
	}
	depth := new(big.Int).Sub(head, receipt.BlockNumber)
	if depth.Sign() < 0 {
		return paymentRequired(fmt.Sprintf("tx %s not yet mined", txHash))
	}
	depth.Add(depth, big.NewInt(1))
	if depth.Cmp(big.NewInt(s.cfg.Confirmations)) < 0 {
		return paymentRequired(fmt.Sprintf("tx %s has %s confirmations, want %d", txHash, depth, s.cfg.Confirmations))
	}
	wantFrom := padTopic(buyer.String())
	seen := 0
	for _, lg := range receipt.Logs {
		if !strings.EqualFold(strings.TrimSpace(lg.Address), commitMintUSDC) {
			continue
		}
		if len(lg.Topics) != 3 || !strings.EqualFold(lg.Topics[0], commitMintTransferSig) {
			continue
		}
		if !strings.EqualFold(lg.Topics[1], wantFrom) {
			continue
		}
		if seen >= len(accts) {
			return paymentRequired(fmt.Sprintf("tx %s carries more buyer USDC Transfers than %d outputs", txHash, len(accts)))
		}
		if !strings.EqualFold(lg.Topics[2], padTopic(accts[seen])) {
			return paymentRequired(fmt.Sprintf("tx %s Transfer %d to %s, want %s", txHash, seen, lg.Topics[2], accts[seen]))
		}
		got, ok := parseTopicUint(lg.Data)
		if !ok || got.Cmp(amounts[seen]) != 0 {
			return paymentRequired(fmt.Sprintf("tx %s Transfer %d value mismatch, want %s", txHash, seen, amounts[seen]))
		}
		seen++
	}
	if seen != len(accts) {
		return paymentRequired(fmt.Sprintf("tx %s carries %d buyer USDC Transfers, want %d outputs", txHash, seen, len(accts)))
	}
	return nil
}

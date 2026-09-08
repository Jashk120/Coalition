package api

import (
	"context"
	"fmt"
	"math/big"
	"net/http"
	"strconv"
	"strings"

	"github.com/Jashk120/Coalition/orchestrator/internal/domain"
	"github.com/Jashk120/Coalition/orchestrator/internal/money"
	"github.com/Jashk120/Coalition/orchestrator/internal/settle"
)

// receiptVerifier is the read-only RPC surface transfer proofs and the pool
// gate need. The production implementation is *settle.Client; tests inject
// a fake.
type receiptVerifier interface {
	BlockNumber(ctx context.Context) (*big.Int, error)
	TransactionReceipt(ctx context.Context, txHash string) (*settle.Receipt, error)
	ReadPoolViews(ctx context.Context, pool string) (*settle.PoolViews, error)
}

// bearerToken extracts the opaque token from Authorization: Bearer <token>.
// Empty string means missing (callers map it to 401 via Authenticate).
func bearerToken(r *http.Request) string {
	h := r.Header.Get("Authorization")
	if h == "" {
		return ""
	}
	const prefix = "Bearer "
	if len(h) < len(prefix) || !strings.EqualFold(h[:len(prefix)], prefix) {
		return ""
	}
	return strings.TrimSpace(h[len(prefix):])
}

// authenticateWallet enforces token auth for a wallet and writes the 401/403
// on failure. True means the caller may proceed.
func (s *Server) authenticateWallet(w http.ResponseWriter, wallet domain.WalletAddress, r *http.Request) bool {
	if err := s.ledger.Authenticate(wallet, bearerToken(r)); err != nil {
		writeJSONError(w, s.logger, err)
		return false
	}
	return true
}

// validTxHash reports whether s is a 0x-prefixed 32-byte hex transaction hash.
func validTxHash(s string) bool {
	s = strings.TrimSpace(s)
	if len(s) != 66 || !strings.HasPrefix(s, "0x") {
		return false
	}
	for _, c := range s[2:] {
		if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f' || c >= 'A' && c <= 'F') {
			return false
		}
	}
	return true
}

// transferCost computes the quoted atomic cost of an mb/cu slice at cost
// basis: mb*rateMB + floor(cu*rateCU). The cu leg uses big.Rat so fractional
// cores never touch float64 money math.
func transferCost(targetAtomic *big.Int, totalMB int64, totalCU, cu float64, mb int64) (*big.Int, error) {
	rateMB, err := money.RatePerMB(targetAtomic, totalMB)
	if err != nil {
		return nil, err
	}
	rateCU, err := money.RatePerCU(targetAtomic, totalCU)
	if err != nil {
		return nil, err
	}
	cost := new(big.Int).Mul(rateMB, big.NewInt(mb))
	cuRat, ok := new(big.Rat).SetString(strconv.FormatFloat(cu, 'g', -1, 64))
	if !ok {
		return nil, fmt.Errorf("cu=%v: %w", cu, domain.ErrInvalidQuota)
	}
	cuLeg := new(big.Rat).Mul(new(big.Rat).SetInt(rateCU), cuRat)
	cuCost := new(big.Int).Quo(cuLeg.Num(), cuLeg.Denom())
	return new(big.Int).Add(cost, cuCost), nil
}

// verifyTransferReceipt checks a direct-payment proof read-only: the buyer's
// transaction to the seller's payTo must carry at least the quoted cost, be
// successful (status 0x1), and be confirmations deep. Failures are 402
// payment_required: the quota move is valid but unpaid. It never submits
// anything: no keys, no signing.
func verifyTransferReceipt(ctx context.Context, v receiptVerifier, confirmations int64, txHash string, buyer, sellerPayTo domain.WalletAddress, minCost *big.Int) error {
	receipt, err := v.TransactionReceipt(ctx, txHash)
	if err != nil {
		return paymentRequired(fmt.Sprintf("receipt for %s unavailable: %v", txHash, err))
	}
	if receipt.Status != "0x1" && receipt.Status != "1" {
		return paymentRequired(fmt.Sprintf("tx %s status %q is not success", txHash, receipt.Status))
	}
	if !strings.EqualFold(receipt.From, buyer.String()) {
		return paymentRequired(fmt.Sprintf("tx %s from %s, want buyer %s", txHash, receipt.From, buyer.String()))
	}
	if !strings.EqualFold(receipt.To, sellerPayTo.String()) {
		return paymentRequired(fmt.Sprintf("tx %s to %s, want seller %s", txHash, receipt.To, sellerPayTo.String()))
	}
	if receipt.Value.Cmp(minCost) < 0 {
		return paymentRequired(fmt.Sprintf("tx %s value %s below quoted cost %s", txHash, receipt.Value, minCost))
	}
	head, err := v.BlockNumber(ctx)
	if err != nil {
		return paymentRequired(fmt.Sprintf("head unavailable for %s: %v", txHash, err))
	}
	depth := new(big.Int).Sub(head, receipt.BlockNumber)
	if depth.Sign() < 0 {
		return paymentRequired(fmt.Sprintf("tx %s not yet mined", txHash))
	}
	depth.Add(depth, big.NewInt(1))
	if depth.Cmp(big.NewInt(confirmations)) < 0 {
		return paymentRequired(fmt.Sprintf("tx %s has %s confirmations, want %d", txHash, depth, confirmations))
	}
	return nil
}

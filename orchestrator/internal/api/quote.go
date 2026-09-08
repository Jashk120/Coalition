package api

import (
	"fmt"
	"math"
	"net/http"
	"strconv"

	"github.com/Jashk120/Coalition/orchestrator/internal/domain"
	"github.com/Jashk120/Coalition/orchestrator/internal/money"
)

// microCU scales fractional cores to integers: 1 CU = 1e6 micro-CU, matching
// the 6-decimal CPU rounding the pool uses elsewhere. The SDK parses
// availableCU as a uint decimal string, so fractional cores can never cross
// as a bare float.
const microCU = 1e6

// quoteResponse mirrors the SDK ComputeQuote wire shape: every bigint crosses
// as a decimal string because JSON cannot carry bigint. availableMB and
// availableCU keep slice-unit semantics (remaining entitlement: MB and
// micro-CU); availableMBHours and availableCUSeconds carry the matching
// time-spread budgets.
type quoteResponse struct {
	Seller             string `json:"seller"`
	PayTo              string `json:"payTo"`
	RatePerMBAtomic    string `json:"ratePerMBAtomic"`
	RatePerCUAtomic    string `json:"ratePerCUAtomic"`
	AvailableMB        string `json:"availableMB"`
	AvailableCU        string `json:"availableCU"`
	AvailableMBHours   string `json:"availableMBHours"`
	AvailableCUSeconds string `json:"availableCUSeconds"`
	TermsURI           string `json:"termsURI,omitempty"`
}

func (s *Server) handleQuote(w http.ResponseWriter, r *http.Request) {
	raw := r.URL.Query().Get("seller")
	if raw == "" {
		writeJSONError(w, s.logger, badRequest("missing ?seller=0x... query"))
		return
	}
	seller, err := domain.NewWalletAddress(raw)
	if err != nil {
		writeJSONError(w, s.logger, badRequest(err.Error()))
		return
	}
	if !s.checkPoolGate(w, r) {
		return
	}
	if _, err := s.ledger.Entitlement(seller); err != nil {
		writeJSONError(w, s.logger, notFound("unknown wallet "+seller.String()))
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
	remCPU, remMB, err := s.ledger.RemainingCapacity(seller)
	if err != nil {
		writeJSONError(w, s.logger, notFound("unknown wallet "+seller.String()))
		return
	}
	remCUSeconds, remMBHours, err := s.ledger.RemainingBudgets(seller)
	if err != nil {
		writeJSONError(w, s.logger, notFound("unknown wallet "+seller.String()))
		return
	}
	writeJSON(w, http.StatusOK, quoteResponse{
		Seller:             seller.String(),
		PayTo:              seller.String(),
		RatePerMBAtomic:    rateMB.String(),
		RatePerCUAtomic:    rateCU.String(),
		AvailableMB:        strconv.FormatInt(remMB, 10),
		AvailableCU:        strconv.FormatInt(int64(math.Floor(remCPU*microCU)), 10),
		AvailableMBHours:   strconv.FormatInt(remMBHours, 10),
		AvailableCUSeconds: strconv.FormatInt(remCUSeconds, 10),
		TermsURI:           s.termsURL(r),
	})
}

// termsURL derives the public /terms.json URL. PUBLIC_BASE_URL wins when
// set (single deployment origin, no header trust involved); otherwise it
// falls back to the request-derived host, honoring proxy headers only when
// TRUST_PROXY=1 (untrusted clients would otherwise poison the signed termsURI).
func (s *Server) termsURL(r *http.Request) string {
	if s.cfg.PublicBaseURL != "" {
		return s.cfg.PublicBaseURL + "/terms.json"
	}
	return termsURL(r, s.cfg.TrustProxy)
}

func termsURL(r *http.Request, trustProxy bool) string {
	scheme := "http"
	if r.TLS != nil {
		scheme = "https"
	}
	host := r.Host
	if trustProxy {
		if proto := r.Header.Get("X-Forwarded-Proto"); proto != "" {
			scheme = proto
		}
		if fwd := r.Header.Get("X-Forwarded-Host"); fwd != "" {
			host = fwd
		}
	}
	return scheme + "://" + host + "/terms.json"
}

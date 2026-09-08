package api

import (
	"fmt"
	"net/http"

	"github.com/Jashk120/Coalition/orchestrator/internal/money"
)

type termsResource struct {
	Type     string `json:"type"`
	CPU      string `json:"cpu"`
	Memory   string `json:"memory"`
	Provider string `json:"provider"`
}

type termsFunding struct {
	TargetUSDC   string `json:"targetUSDC"`
	TargetAtomic string `json:"targetAtomic"`
	Rule         string `json:"rule"`
}

type termsAllocation struct {
	Basis       string `json:"basis"`
	Window      string `json:"window"`
	Metering    string `json:"metering"`
	WindowHours int64  `json:"windowHours"`
}

type termsForfeiture struct {
	Rule       string `json:"rule"`
	Reputation string `json:"reputation"`
}

type termsResale struct {
	Permitted bool   `json:"permitted"`
	Pricing   string `json:"pricing"`
	Rails     string `json:"rails"`
	Effect    string `json:"effect"`
}

type termsSettlement struct {
	Chain  string `json:"chain"`
	Asset  string `json:"asset"`
	Method string `json:"method"`
}

type termsDoc struct {
	Name       string          `json:"name"`
	Version    string          `json:"version"`
	Self       string          `json:"self"`
	Resource   termsResource   `json:"resource"`
	Funding    termsFunding    `json:"funding"`
	Allocation termsAllocation `json:"allocation"`
	Forfeiture termsForfeiture `json:"forfeiture"`
	Resale     termsResale     `json:"resale"`
	Settlement termsSettlement `json:"settlement"`
}

// handleTerms builds the pool terms document live from Config on every call.
// Nothing is read from disk: this endpoint's URL is the pool's immutable
// resourceURI, so its shape must stay stable while values track the env.
// The self field carries the canonical document URL: PUBLIC_BASE_URL when
// configured, else the request-derived URL under the TRUST_PROXY policy.
func (s *Server) handleTerms(w http.ResponseWriter, r *http.Request) {
	cfg := s.cfg
	rateMB, err := money.RatePerMB(cfg.TargetAtomic, cfg.MemMB)
	if err != nil {
		writeJSONError(w, s.logger, err)
		return
	}
	doc := termsDoc{
		Name:    cfg.ResourceName + " — Shared VPS Window",
		Version: "1.0.0",
		Self:    s.termsURL(r),
		Resource: termsResource{
			Type:     "VPS",
			CPU:      fmt.Sprintf("%g CU", cfg.CPUTotal),
			Memory:   fmt.Sprintf("%d MB", cfg.MemMB),
			Provider: cfg.ProviderAddress.String(),
		},
		Funding: termsFunding{
			TargetUSDC:   cfg.TargetUSDC,
			TargetAtomic: cfg.TargetAtomic.String(),
			Rule:         "Atomic settle to provider at threshold; over-commit capped at target",
		},
		Allocation: termsAllocation{
			Basis:       "pro-rata on commitment",
			Window:      fmt.Sprintf("%dh of compute from settlement", cfg.WindowHours),
			Metering:    "CU-seconds and MB-hours tracked per wallet; overruns throttled/killed; bearer tokens valid to settlement+window once settled, else allocation+window",
			WindowHours: cfg.WindowHours,
		},
		Forfeiture: termsForfeiture{
			Rule:       "Dropout stake stays locked, counts toward target, redistributed pro-rata (settle: remainder splits the resource; refund: remainder splits the tokens)",
			Reputation: "Dropout recorded as -1 feedback, completion as +1, tag2 pool",
		},
		Resale: termsResale{
			Permitted: true,
			Pricing:   fmt.Sprintf("cost basis only (%s USDC/MB); no auction pricing", money.FormatAtomic(rateMB)),
			Rails:     "x402 via Gateway batching preferred, direct USDC transfer as fallback",
			Effect:    "Quota shifts seller to buyer on confirmed payment; evolution toward 1:1 price-to-use",
		},
		Settlement: termsSettlement{
			Chain:  "Arc testnet (eip155:5042002)",
			Asset:  "USDC (6-decimal ERC-20 view)",
			Method: "atomic transfer to provider; anyone may call once filled",
		},
	}
	writeJSON(w, http.StatusOK, doc)
}

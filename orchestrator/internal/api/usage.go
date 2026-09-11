package api

import (
	"net/http"
	"sort"

	"github.com/Jashk120/Coalition/orchestrator/internal/domain"
)

// agentUsage is one ledger row for settlement visibility: the wallet's paid
// slice (cpu/memMB), what it burned (cuSeconds/mbHours), the window budgets
// those burn against, and what is left. Budgets cross as floats (they are
// time-spread products, not integers); remaining crosses as floored int64,
// matching RemainingBudgets and the quote leg semantics.
type agentUsage struct {
	Wallet              string  `json:"wallet"`
	CPU                 float64 `json:"cpu"`
	MemMB               int64   `json:"memMB"`
	CUSeconds           float64 `json:"cuSeconds"`
	MBHours             float64 `json:"mbHours"`
	InFlightCUSeconds   float64 `json:"inFlightCUSeconds"`
	InFlightMBHours     float64 `json:"inFlightMBHours"`
	BudgetCUSeconds     float64 `json:"budgetCUSeconds"`
	BudgetMBHours       float64 `json:"budgetMBHours"`
	RemainingCUSeconds  int64   `json:"remainingCUSeconds"`
	RemainingMBHours    int64   `json:"remainingMBHours"`
	PercentUsedCU       float64 `json:"percentUsedCU"`
	PercentUsedMB       float64 `json:"percentUsedMB"`
	HasContainer        bool    `json:"hasContainer"`
	Settled             bool    `json:"settled"`
}

// usageResponse is the GET /usage wire shape. Agents is never nil: an empty
// ledger encodes as [] rather than null so dashboard polling needs no
// null-guard on the hot path.
type usageResponse struct {
	Agents      []agentUsage `json:"agents"`
	Settled     bool         `json:"settled"`
	WindowHours float64      `json:"windowHours"`
}

// handleUsage lists per-agent compute usage for settlement visibility: who is
// actually burning compute versus sitting on entitlement. Agents are exposed
// ONLY once funding closes (settled): joining the pool grants no visibility,
// the settled round does. Before that the list is empty (never null) with
// settled=false, so dashboard polling renders zero rows.
//
// Public like /quote (no app key, no bearer): dashboard polling must work
// before anyone holds credentials and after funding closes. Deliberately NOT
// behind the pool gate: /quote prices funding so expiry closes it, but /usage
// is a read of local metering — expiry must never hide who spent what.
func (s *Server) handleUsage(w http.ResponseWriter, _ *http.Request) {
	// FundingClosed covers both eras: legacy v1 settle and the current v2
	// round settle. Per-row Settled mirrors this ledger-wide flag: usage rows
	// are only final once funding closes, and round-scoped nuance lives in
	// the settle listener, not in this dashboard list.
	settled := s.ledger.FundingClosed()
	if !settled {
		writeJSON(w, http.StatusOK, usageResponse{
			Agents:      []agentUsage{},
			Settled:     false,
			WindowHours: float64(s.cfg.WindowHours),
		})
		return
	}

	// ListContainers snapshots wallet->container bindings sorted by wallet;
	// Wallets is sorted separately since the two scans run under different
	// locks and cannot share one ordering.
	hasContainer := make(map[string]bool)
	for _, b := range s.ledger.ListContainers() {
		hasContainer[b.Wallet] = b.ContainerID != ""
	}

	wallets := s.ledger.Wallets()
	sort.Strings(wallets)

	agents := make([]agentUsage, 0, len(wallets))
	for _, raw := range wallets {
		addr, err := domain.NewWalletAddress(raw)
		if err != nil {
			// Ledger keys are canonical addresses written via WalletAddress;
			// a key that no longer parses means local corruption, not a
			// client error — skip the row rather than fail the whole list.
			continue
		}
		ent, err := s.ledger.Entitlement(addr)
		if err != nil {
			continue
		}
		used, err := s.ledger.Usage(addr)
		if err != nil {
			continue
		}
		flightCU, flightMB, err := s.ledger.Inflight(addr)
		if err != nil {
			continue
		}
		remCU, remMB, err := s.ledger.RemainingBudgets(addr)
		if err != nil {
			continue
		}
		budgetCU, budgetMB := s.ledger.Budgets(ent)
		agents = append(agents, agentUsage{
			Wallet:             addr.String(),
			CPU:                ent.CPU,
			MemMB:              ent.MemMB,
			CUSeconds:          used.CUSeconds,
			MBHours:            used.MBHours,
			InFlightCUSeconds:  flightCU,
			InFlightMBHours:    flightMB,
			BudgetCUSeconds:    budgetCU,
			BudgetMBHours:      budgetMB,
			RemainingCUSeconds: remCU,
			RemainingMBHours:   remMB,
			PercentUsedCU:      usagePercent(used.CUSeconds, budgetCU),
			PercentUsedMB:      usagePercent(used.MBHours, budgetMB),
			HasContainer:       hasContainer[addr.String()],
			Settled:            settled,
		})
	}
	writeJSON(w, http.StatusOK, usageResponse{
		Agents:      agents,
		Settled:     settled,
		WindowHours: float64(s.cfg.WindowHours),
	})
}

// usagePercent is used/budget as a 0-100 percentage. Zero (or negative)
// budgets yield 0, never NaN: division by zero must not poison the dashboard.
// Over-budget burn clamps at 100 — the row flags exhaustion, not debt size.
func usagePercent(used, budget float64) float64 {
	if budget <= 0 {
		return 0
	}
	p := used / budget * 100
	if p < 0 {
		return 0
	}
	if p > 100 {
		return 100
	}
	return p
}

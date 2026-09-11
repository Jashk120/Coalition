package api

import (
	"fmt"
	"math"
	"net/http"
	"strconv"

	"github.com/Jashk120/Coalition/orchestrator/internal/domain"
	"github.com/Jashk120/Coalition/orchestrator/internal/money"
	"github.com/Jashk120/Coalition/orchestrator/internal/store"
)

// capacityTotals is the pool-global configured ceiling from Config.
type capacityTotals struct {
	CPU         float64 `json:"cpu"`
	MemMB       int64   `json:"memMB"`
	MaxAgents   int64   `json:"maxAgents"`
	WindowHours int64   `json:"windowHours"`
}

// capacityHeadroom is the pool-global unreserved spare: totals minus the sum
// of every recorded entitlement, floored at zero (see Store.Headroom).
type capacityHeadroom struct {
	HeadroomMB      int64 `json:"headroomMB"`
	HeadroomCUMicro int64 `json:"headroomCUMicro"`
}

// capacityRates is the cost-basis resale rate pair, shared with /quote.
type capacityRates struct {
	RatePerMBAtomic string `json:"ratePerMBAtomic"`
	RatePerCUAtomic string `json:"ratePerCUAtomic"`
}

// capacitySeller is one wallet's remaining resale supply: the slice-unit
// remainder (MB, micro-CU floored like /quote) plus the time-spread budgets.
type capacitySeller struct {
	Wallet             string `json:"wallet"`
	AvailableMB        string `json:"availableMB"`
	AvailableCU        string `json:"availableCU"`
	RemainingMBHours   string `json:"remainingMBHours"`
	RemainingCUSeconds string `json:"remainingCUSeconds"`
}

// capacityResponse is the GET /capacity wire shape. Sellers is never nil: an
// empty ledger encodes as [] rather than null.
type capacityResponse struct {
	Totals   capacityTotals   `json:"totals"`
	Headroom capacityHeadroom `json:"headroom"`
	Rates    capacityRates    `json:"rates"`
	Sellers  []capacitySeller `json:"sellers"`
	Settled  bool             `json:"settled"`
	RoundID  string           `json:"roundId"`
}

// handleCapacity reports pool-global remaining capacity for external buyers:
// configured totals, unreserved headroom, cost-basis rates, and per-wallet
// remaining supply with the tracked round and settled flag.
//
// Public like /usage (no app key, no bearer): buyers are external agents
// without credentials, so price discovery must work before anyone holds
// them. Deliberately NOT behind checkPoolGate: like /usage (not /quote),
// spare capacity stays visible after expiry; the settled boolean lets buyers
// reason about finality themselves. Read-only: every ledger call takes the
// store's RLock and none mutates entitlement, usage, spent, or round state.
func (s *Server) handleCapacity(w http.ResponseWriter, _ *http.Request) {
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
	freeMicro, freeMem := s.ledger.Headroom(store.MicroCU(s.cfg.CPUTotal), s.cfg.MemMB)

	// ListContainers snapshots wallet bindings sorted by wallet, so sellers
	// are deterministic without a second sort.
	sellers := []capacitySeller{}
	for _, b := range s.ledger.ListContainers() {
		addr, err := domain.NewWalletAddress(b.Wallet)
		if err != nil {
			// Ledger keys are canonical addresses written via
			// WalletAddress; a key that no longer parses means local
			// corruption, not a client error — skip the row rather than
			// fail the whole list.
			continue
		}
		remCPU, remMB, err := s.ledger.RemainingCapacity(addr)
		if err != nil {
			continue
		}
		remCUSeconds, remMBHours, err := s.ledger.RemainingBudgets(addr)
		if err != nil {
			continue
		}
		sellers = append(sellers, capacitySeller{
			Wallet:             addr.String(),
			AvailableMB:        strconv.FormatInt(remMB, 10),
			AvailableCU:        strconv.FormatInt(int64(math.Floor(remCPU*microCU)), 10),
			RemainingMBHours:   strconv.FormatInt(remMBHours, 10),
			RemainingCUSeconds: strconv.FormatInt(remCUSeconds, 10),
		})
	}

	roundID := "0"
	if cur := s.ledger.CurrentRound(); cur != nil {
		roundID = cur.String()
	}
	writeJSON(w, http.StatusOK, capacityResponse{
		Totals: capacityTotals{
			CPU:         s.cfg.CPUTotal,
			MemMB:       s.cfg.MemMB,
			MaxAgents:   s.cfg.MaxAgents,
			WindowHours: s.cfg.WindowHours,
		},
		Headroom: capacityHeadroom{
			HeadroomMB:      freeMem,
			HeadroomCUMicro: freeMicro,
		},
		Rates: capacityRates{
			RatePerMBAtomic: rateMB.String(),
			RatePerCUAtomic: rateCU.String(),
		},
		Sellers: sellers,
		Settled: s.ledger.FundingClosed(),
		RoundID: roundID,
	})
}

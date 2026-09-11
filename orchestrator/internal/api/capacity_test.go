package api

import (
	"encoding/json"
	"math/big"
	"net/http"
	"testing"
)

type capacityOut struct {
	Totals struct {
		CPU         float64 `json:"cpu"`
		MemMB       int64   `json:"memMB"`
		MaxAgents   int64   `json:"maxAgents"`
		WindowHours int64   `json:"windowHours"`
	} `json:"totals"`
	Headroom struct {
		HeadroomMB      int64 `json:"headroomMB"`
		HeadroomCUMicro int64 `json:"headroomCUMicro"`
	} `json:"headroom"`
	Rates struct {
		RatePerMBAtomic string `json:"ratePerMBAtomic"`
		RatePerCUAtomic string `json:"ratePerCUAtomic"`
	} `json:"rates"`
	Sellers []struct {
		Wallet             string `json:"wallet"`
		AvailableMB        string `json:"availableMB"`
		AvailableCU        string `json:"availableCU"`
		RemainingMBHours   string `json:"remainingMBHours"`
		RemainingCUSeconds string `json:"remainingCUSeconds"`
	} `json:"sellers"`
	Settled bool   `json:"settled"`
	RoundID string `json:"roundId"`
}

func getCapacity(t *testing.T, f fixture) (int, capacityOut) {
	t.Helper()
	rec := doRequest(f, http.MethodGet, "/capacity", "")
	var out capacityOut
	if rec.Code == http.StatusOK {
		if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
			t.Fatalf("decode capacity: %v", err)
		}
	}
	return rec.Code, out
}

// Test_Capacity_empty_ledger: no wallets means full headroom, an empty
// (non-null) seller list, and unsettled — no auth headers attached.
func Test_Capacity_empty_ledger(t *testing.T) {
	f := newFixture()
	code, out := getCapacity(t, f)
	if code != http.StatusOK {
		t.Fatalf("status=%d", code)
	}
	if out.Sellers == nil {
		t.Fatal("sellers must encode as [], never null")
	}
	if len(out.Sellers) != 0 {
		t.Fatalf("sellers=%d, want 0", len(out.Sellers))
	}
	if out.Headroom.HeadroomMB != 4096 || out.Headroom.HeadroomCUMicro != 1000000 {
		t.Fatalf("headroom = %dMB %dCUMicro, want 4096MB 1000000CUMicro",
			out.Headroom.HeadroomMB, out.Headroom.HeadroomCUMicro)
	}
	if out.Totals.CPU != 1 || out.Totals.MemMB != 4096 ||
		out.Totals.MaxAgents != 5 || out.Totals.WindowHours != 72 {
		t.Fatalf("totals = %+v, want cpu=1 memMB=4096 maxAgents=5 windowHours=72", out.Totals)
	}
	if out.Rates.RatePerMBAtomic != "1220" || out.Rates.RatePerCUAtomic != "5000000" {
		t.Fatalf("rates = %+v, want 1220/5000000", out.Rates)
	}
	if out.Settled {
		t.Fatal("settled must be false on a fresh ledger")
	}
	if out.RoundID != "0" {
		t.Fatalf("roundId = %q, want 0 with no tracked round", out.RoundID)
	}
}

// Test_Capacity_one_seller_headroom: one 0.2/800 slice leaves headroom at
// totals minus entitlement (800000 micro-CU, 3296MB) and the seller row
// carries the /quote-style slice remainder plus time-spread budgets.
func Test_Capacity_one_seller_headroom(t *testing.T) {
	f := newFixture()
	allocate(t, f, testWalletA, 0.2, 800)

	code, out := getCapacity(t, f)
	if code != http.StatusOK {
		t.Fatalf("status=%d", code)
	}
	if out.Headroom.HeadroomMB != 3296 || out.Headroom.HeadroomCUMicro != 800000 {
		t.Fatalf("headroom = %dMB %dCUMicro, want 3296MB 800000CUMicro",
			out.Headroom.HeadroomMB, out.Headroom.HeadroomCUMicro)
	}
	if len(out.Sellers) != 1 {
		t.Fatalf("sellers=%d, want 1", len(out.Sellers))
	}
	s := out.Sellers[0]
	if s.Wallet != testWalletA {
		t.Fatalf("wallet=%s, want %s", s.Wallet, testWalletA)
	}
	if s.AvailableMB != "800" {
		t.Fatalf("availableMB = %q, want 800", s.AvailableMB)
	}
	if s.AvailableCU != "200000" {
		t.Fatalf("availableCU = %q, want 200000 micro-CU", s.AvailableCU)
	}
	if s.RemainingMBHours != "57600" {
		t.Fatalf("remainingMBHours = %q, want 57600", s.RemainingMBHours)
	}
	if s.RemainingCUSeconds != "51840" {
		t.Fatalf("remainingCUSeconds = %q, want 51840", s.RemainingCUSeconds)
	}
	if out.Settled {
		t.Fatal("settled must be false before any settle")
	}
}

// Test_Capacity_burn_shrinks_seller_not_headroom: metered burn shrinks the
// seller's remaining supply (usage spread over the window) while pool
// headroom — totals minus entitlements — stays put.
func Test_Capacity_burn_shrinks_seller_not_headroom(t *testing.T) {
	f := newFixture()
	allocate(t, f, testWalletA, 0.2, 800)
	if err := f.led.AddUsage(mustWallet(t, testWalletA), 5184, 5760); err != nil {
		t.Fatalf("AddUsage: %v", err)
	}

	code, out := getCapacity(t, f)
	if code != http.StatusOK {
		t.Fatalf("status=%d", code)
	}
	if out.Headroom.HeadroomMB != 3296 || out.Headroom.HeadroomCUMicro != 800000 {
		t.Fatalf("headroom = %dMB %dCUMicro, want 3296MB 800000CUMicro (burn must not move headroom)",
			out.Headroom.HeadroomMB, out.Headroom.HeadroomCUMicro)
	}
	if len(out.Sellers) != 1 {
		t.Fatalf("sellers=%d, want 1", len(out.Sellers))
	}
	s := out.Sellers[0]
	if s.AvailableMB != "720" {
		t.Fatalf("availableMB = %q, want 720 (800 - floor(5760/72))", s.AvailableMB)
	}
	if s.AvailableCU != "180000" {
		t.Fatalf("availableCU = %q, want 180000 (floor(0.18*1e6))", s.AvailableCU)
	}
	if s.RemainingMBHours != "51840" {
		t.Fatalf("remainingMBHours = %q, want 51840", s.RemainingMBHours)
	}
	if s.RemainingCUSeconds != "46656" {
		t.Fatalf("remainingCUSeconds = %q, want 46656", s.RemainingCUSeconds)
	}
}

// Test_Capacity_settled_round: settling the tracked round flips settled and
// exposes the round id, and the list stays visible (no pool gate).
func Test_Capacity_settled_round(t *testing.T) {
	f := newFixture()
	allocate(t, f, testWalletA, 0.2, 800)
	f.led.SetCurrentRound(big.NewInt(7))
	f.led.MarkRoundSettled(big.NewInt(7))

	code, out := getCapacity(t, f)
	if code != http.StatusOK {
		t.Fatalf("status=%d", code)
	}
	if !out.Settled {
		t.Fatal("settled must be true once the tracked round settles")
	}
	if out.RoundID != "7" {
		t.Fatalf("roundId = %q, want 7", out.RoundID)
	}
	if len(out.Sellers) != 1 {
		t.Fatalf("sellers=%d, want 1 (settled must not hide spare)", len(out.Sellers))
	}
}

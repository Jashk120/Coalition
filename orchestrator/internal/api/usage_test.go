package api

import (
	"encoding/json"
	"net/http"
	"testing"
)

// Test_Usage_empty_ledger: no wallets means an empty (non-null) agent list
// and unsettled, so dashboard polling renders zero rows instead of crashing
// on a null payload.
func Test_Usage_empty_ledger(t *testing.T) {
	f := newFixture()
	rec := doRequest(f, http.MethodGet, "/usage", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	var out struct {
		Agents []struct {
			Wallet string `json:"wallet"`
		} `json:"agents"`
		Settled     bool    `json:"settled"`
		WindowHours float64 `json:"windowHours"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if out.Agents == nil {
		t.Fatal("agents must encode as [], never null")
	}
	if len(out.Agents) != 0 {
		t.Fatalf("agents=%d, want 0", len(out.Agents))
	}
	if out.Settled {
		t.Fatal("settled must be false on a fresh ledger")
	}
	if out.WindowHours != 72 {
		t.Fatalf("windowHours=%v, want 72", out.WindowHours)
	}
}

// Test_Usage_one_wallet_with_usage: allocate burns a slice, AddUsage meters
// spend, and /usage reports budgets (cpu*window*3600, mem*window), floored
// remaining, and 10% used on each leg — with no auth headers attached.
func Test_Usage_one_wallet_with_usage(t *testing.T) {
	f := newFixture()
	allocate(t, f, testWalletA, 0.2, 800)
	if err := f.led.AddUsage(mustWallet(t, testWalletA), 5184, 5760); err != nil {
		t.Fatalf("AddUsage: %v", err)
	}

	rec := doRequest(f, http.MethodGet, "/usage", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	var out struct {
		Agents []struct {
			Wallet             string  `json:"wallet"`
			CPU                float64 `json:"cpu"`
			MemMB              int64   `json:"memMB"`
			CUSeconds          float64 `json:"cuSeconds"`
			MBHours            float64 `json:"mbHours"`
			BudgetCUSeconds    float64 `json:"budgetCUSeconds"`
			BudgetMBHours      float64 `json:"budgetMBHours"`
			RemainingCUSeconds int64   `json:"remainingCUSeconds"`
			RemainingMBHours   int64   `json:"remainingMBHours"`
			PercentUsedCU      float64 `json:"percentUsedCU"`
			PercentUsedMB      float64 `json:"percentUsedMB"`
			HasContainer       bool    `json:"hasContainer"`
			Settled            bool    `json:"settled"`
		} `json:"agents"`
		Settled     bool    `json:"settled"`
		WindowHours float64 `json:"windowHours"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(out.Agents) != 1 {
		t.Fatalf("agents=%d, want 1: %s", len(out.Agents), rec.Body.String())
	}
	a := out.Agents[0]
	if a.Wallet != testWalletA {
		t.Fatalf("wallet=%s, want %s", a.Wallet, testWalletA)
	}
	if a.CPU != 0.2 || a.MemMB != 800 {
		t.Fatalf("slice cpu=%v mem=%d, want 0.2/800", a.CPU, a.MemMB)
	}
	if a.CUSeconds != 5184 || a.MBHours != 5760 {
		t.Fatalf("used cu=%v mb=%v, want 5184/5760", a.CUSeconds, a.MBHours)
	}
	// Budgets: 0.2*72*3600 = 51840 CU-seconds, 800*72 = 57600 MB-hours.
	if a.BudgetCUSeconds != 51840 || a.BudgetMBHours != 57600 {
		t.Fatalf("budgets cu=%v mb=%v, want 51840/57600", a.BudgetCUSeconds, a.BudgetMBHours)
	}
	if a.RemainingCUSeconds != 46656 || a.RemainingMBHours != 51840 {
		t.Fatalf("remaining cu=%d mb=%d, want 46656/51840", a.RemainingCUSeconds, a.RemainingMBHours)
	}
	if a.PercentUsedCU != 10 || a.PercentUsedMB != 10 {
		t.Fatalf("percents cu=%v mb=%v, want 10/10", a.PercentUsedCU, a.PercentUsedMB)
	}
	if !a.HasContainer {
		t.Fatal("allocate-bound wallet must report hasContainer=true")
	}
	if a.Settled || out.Settled {
		t.Fatal("settled must be false before any settle")
	}

	// Settling the ledger flips both the top-level and per-row flags, so the
	// dashboard can badge rows as final without a second request.
	f.led.MarkSettled()
	rec = doRequest(f, http.MethodGet, "/usage", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	var settled struct {
		Agents []struct {
			Settled bool `json:"settled"`
		} `json:"agents"`
		Settled bool `json:"settled"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &settled); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if !settled.Settled || len(settled.Agents) != 1 || !settled.Agents[0].Settled {
		t.Fatalf("settled flags not flipped: %+v", settled)
	}
}

package store

import (
	"errors"
	"fmt"
	"math"
	"math/big"
	"testing"
	"time"

	"github.com/Jashk120/Coalition/orchestrator/internal/domain"
)

const (
	testWalletA = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266"
	testWalletB = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8"
)

func mustWallet(t *testing.T, s string) domain.WalletAddress {
	t.Helper()
	w, err := domain.NewWalletAddress(s)
	if err != nil {
		t.Fatalf("wallet %q: %v", s, err)
	}
	return w
}

func mustEntitlement(t *testing.T, cpu float64, mem int64) domain.Entitlement {
	t.Helper()
	e, err := domain.NewEntitlement(cpu, mem)
	if err != nil {
		t.Fatalf("entitlement: %v", err)
	}
	return e
}

func Test_Entitlement_roundtrip(t *testing.T) {
	s := NewStore(72)
	w := mustWallet(t, testWalletA)
	if _, err := s.Entitlement(w); !errors.Is(err, ErrUnknownWallet) {
		t.Fatalf("unknown wallet should wrap ErrUnknownWallet, got %v", err)
	}
	s.SetEntitlement(w, mustEntitlement(t, 0.2, 800))
	got, err := s.Entitlement(w)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if got.CPU != 0.2 || got.MemMB != 800 {
		t.Fatalf("got %+v", got)
	}
	s.SetEntitlement(w, mustEntitlement(t, 0.5, 1000))
	got, err = s.Entitlement(w)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if got.CPU != 0.5 || got.MemMB != 1000 {
		t.Fatalf("re-allocate should update, got %+v", got)
	}
}

func Test_Container_binding(t *testing.T) {
	s := NewStore(72)
	w := mustWallet(t, testWalletA)
	if _, err := s.Container(w); !errors.Is(err, ErrUnknownWallet) {
		t.Fatalf("unbound should wrap ErrUnknownWallet, got %v", err)
	}
	s.SetContainer(w, "ctr-1")
	id, err := s.Container(w)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if id != "ctr-1" {
		t.Fatalf("got %q", id)
	}
}

func Test_Exceeded_metering(t *testing.T) {
	tests := []struct {
		name         string
		cpu          float64
		mem          int64
		useCPU       float64
		useMem       float64
		wantExceeded bool
	}{
		{"zero usage", 0.2, 800, 0, 0, false},
		{"exact fit", 0.2, 800, 0.2 * 72 * 3600, 800 * 72, false},
		{"over by one cu-second", 0.2, 800, 0.2*72*3600 + 1, 0, true},
		{"over by one mb-hour", 0.2, 800, 0, 800*72 + 1, true},
		{"far over", 0.2, 800, 1e9, 1e9, true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			s := NewStore(72)
			w := mustWallet(t, testWalletA)
			s.SetEntitlement(w, mustEntitlement(t, tt.cpu, tt.mem))
			if err := s.AddUsage(w, tt.useCPU, tt.useMem); err != nil {
				t.Fatalf("add usage: %v", err)
			}
			got, err := s.Exceeded(w)
			if err != nil {
				t.Fatalf("exceeded: %v", err)
			}
			if got != tt.wantExceeded {
				t.Fatalf("Exceeded = %v, want %v", got, tt.wantExceeded)
			}
		})
	}
}

func Test_AddUsage_unknown_wallet(t *testing.T) {
	s := NewStore(72)
	if err := s.AddUsage(mustWallet(t, testWalletA), 1, 1); !errors.Is(err, ErrUnknownWallet) {
		t.Fatalf("expected ErrUnknownWallet, got %v", err)
	}
	if err := s.AddUsage(mustWallet(t, testWalletA), -1, 0); err == nil {
		t.Fatal("negative usage must error")
	}
}

func Test_RemainingBudgets(t *testing.T) {
	s := NewStore(72)
	w := mustWallet(t, testWalletA)
	s.SetEntitlement(w, mustEntitlement(t, 0.2, 800))
	cu, mb, err := s.RemainingBudgets(w)
	if err != nil {
		t.Fatalf("remaining: %v", err)
	}
	if cu != int64(0.2*72*3600) || mb != 800*72 {
		t.Fatalf("got cu=%d mb=%d", cu, mb)
	}
	if _, _, err := s.RemainingBudgets(mustWallet(t, testWalletB)); !errors.Is(err, ErrUnknownWallet) {
		t.Fatalf("expected ErrUnknownWallet, got %v", err)
	}
}

func Test_Transfer(t *testing.T) {
	from := mustWallet(t, testWalletA)
	to := mustWallet(t, testWalletB)
	t.Run("happy path", func(t *testing.T) {
		s := NewStore(72)
		s.SetEntitlement(from, mustEntitlement(t, 0.2, 800))
		if err := s.Transfer(from, to, 400, 0.1); err != nil {
			t.Fatalf("transfer: %v", err)
		}
		f, _ := s.Entitlement(from)
		g, _ := s.Entitlement(to)
		if f.MemMB != 400 || g.MemMB != 400 {
			t.Fatalf("mem split wrong: %+v %+v", f, g)
		}
		if diff := f.CPU - 0.1; diff < -1e-9 || diff > 1e-9 {
			t.Fatalf("from cpu wrong: %+v", f)
		}
	})
	t.Run("insufficient", func(t *testing.T) {
		s := NewStore(72)
		s.SetEntitlement(from, mustEntitlement(t, 0.2, 800))
		if err := s.Transfer(from, to, 801, 0); !errors.Is(err, ErrInsufficientQuota) {
			t.Fatalf("expected ErrInsufficientQuota, got %v", err)
		}
		if err := s.Transfer(from, to, 0, 0.3); !errors.Is(err, ErrInsufficientQuota) {
			t.Fatalf("expected ErrInsufficientQuota, got %v", err)
		}
	})
	t.Run("self and empty", func(t *testing.T) {
		s := NewStore(72)
		s.SetEntitlement(from, mustEntitlement(t, 0.2, 800))
		if err := s.Transfer(from, from, 1, 0); err == nil {
			t.Fatal("self transfer must error")
		}
		if err := s.Transfer(from, to, 0, 0); err == nil {
			t.Fatal("empty transfer must error")
		}
	})
	t.Run("unknown sender", func(t *testing.T) {
		s := NewStore(72)
		if err := s.Transfer(from, to, 1, 0); !errors.Is(err, ErrUnknownWallet) {
			t.Fatalf("expected ErrUnknownWallet, got %v", err)
		}
	})
	t.Run("usage reduces availability", func(t *testing.T) {
		s := NewStore(72)
		s.SetEntitlement(from, mustEntitlement(t, 0.2, 800))
		if err := s.AddUsage(from, 0.2*72*3600, 800*72); err != nil {
			t.Fatalf("add usage: %v", err)
		}
		if err := s.Transfer(from, to, 1, 0); !errors.Is(err, ErrInsufficientQuota) {
			t.Fatalf("fully used sender should fail, got %v", err)
		}
	})
}

func Test_Settled_flag(t *testing.T) {
	s := NewStore(72)
	if s.IsSettled() {
		t.Fatal("fresh store must be unsettled")
	}
	if !s.MarkSettled() {
		t.Fatal("first mark should win")
	}
	if !s.IsSettled() {
		t.Fatal("should be settled")
	}
	if s.MarkSettled() {
		t.Fatal("second mark must not win")
	}
}

func Test_Token_lifecycle(t *testing.T) {
	s := NewStore(72)
	w := mustWallet(t, testWalletA)
	if err := s.Authenticate(w, "anything"); !errors.Is(err, ErrTokenInvalid) {
		t.Fatalf("pre-issue auth should be ErrTokenInvalid, got %v", err)
	}
	first, err := s.IssueToken(w)
	if err != nil {
		t.Fatalf("issue: %v", err)
	}
	if first == "" {
		t.Fatal("empty token")
	}
	if err := s.Authenticate(w, ""); !errors.Is(err, ErrTokenInvalid) {
		t.Fatalf("empty bearer should be ErrTokenInvalid, got %v", err)
	}
	if err := s.Authenticate(w, "wrong"); !errors.Is(err, ErrTokenInvalid) {
		t.Fatalf("wrong token should be ErrTokenInvalid, got %v", err)
	}
	if err := s.Authenticate(w, first); err != nil {
		t.Fatalf("good token: %v", err)
	}
	second, err := s.IssueToken(w)
	if err != nil {
		t.Fatalf("re-issue: %v", err)
	}
	if second == first {
		t.Fatal("rotation must mint a fresh token")
	}
	if err := s.Authenticate(w, first); !errors.Is(err, ErrTokenInvalid) {
		t.Fatalf("rotated-out token should be ErrTokenInvalid, got %v", err)
	}
	s.Revoke(w)
	if err := s.Authenticate(w, second); !errors.Is(err, ErrTokenRevoked) {
		t.Fatalf("revoked token should be ErrTokenRevoked, got %v", err)
	}
}

func Test_Token_expiry(t *testing.T) {
	s := NewStore(72)
	w := mustWallet(t, testWalletA)
	tok, err := s.IssueToken(w)
	if err != nil {
		t.Fatalf("issue: %v", err)
	}
	s.SetTokenExpiry(w, time.Now().Add(-time.Minute))
	if err := s.Authenticate(w, tok); !errors.Is(err, ErrTokenExpired) {
		t.Fatalf("expired token should be ErrTokenExpired, got %v", err)
	}
}

func Test_Totals_and_distinct(t *testing.T) {
	s := NewStore(72)
	a, b := mustWallet(t, testWalletA), mustWallet(t, testWalletB)
	s.SetEntitlement(a, mustEntitlement(t, 0.2, 800))
	s.SetEntitlement(b, mustEntitlement(t, 0.3, 1000))
	cpu, mem := s.Totals()
	if diff := cpu - 0.5; diff < -1e-9 || diff > 1e-9 || mem != 1800 {
		t.Fatalf("totals = %v/%d, want 0.5/1800", cpu, mem)
	}
	if n := s.DistinctWallets(); n != 2 {
		t.Fatalf("distinct = %d, want 2", n)
	}
	if s.HasWallet(mustWallet(t, "0x1111111111111111111111111111111111111111")) {
		t.Fatal("unknown wallet must not be present")
	}
}

func Test_Reserve_pattern_serializes_overuse(t *testing.T) {
	s := NewStore(72)
	w := mustWallet(t, testWalletA)
	s.SetEntitlement(w, mustEntitlement(t, 0.2, 800))
	if err := s.BeginExec(w); err != nil {
		t.Fatalf("begin: %v", err)
	}
	if err := s.EndExec(w, 5, 5); err != nil {
		t.Fatalf("end: %v", err)
	}
	u, err := s.Usage(w)
	if err != nil {
		t.Fatalf("usage: %v", err)
	}
	if u.CUSeconds != 5 || u.MBHours != 5 {
		t.Fatalf("usage = %+v", u)
	}
	if err := s.BeginExec(mustWallet(t, "0x1111111111111111111111111111111111111111")); !errors.Is(err, ErrUnknownWallet) {
		t.Fatalf("unknown wallet begin should be ErrUnknownWallet, got %v", err)
	}
	if err := s.EndExec(w, math.NaN(), 0); !errors.Is(err, domain.ErrInvalidQuota) {
		t.Fatalf("NaN end should be ErrInvalidQuota, got %v", err)
	}
}

func Test_BeginExec_blocks_when_over_budget(t *testing.T) {
	s := NewStore(72)
	w := mustWallet(t, testWalletA)
	s.SetEntitlement(w, mustEntitlement(t, 0.2, 800))
	if err := s.AddUsage(w, 0.2*72*3600+1, 0); err != nil {
		t.Fatalf("usage: %v", err)
	}
	if err := s.BeginExec(w); !errors.Is(err, ErrQuotaExceeded) {
		t.Fatalf("over-budget begin should be ErrQuotaExceeded, got %v", err)
	}
}

func Test_AddUsage_rejects_nonfinite(t *testing.T) {
	s := NewStore(72)
	w := mustWallet(t, testWalletA)
	s.SetEntitlement(w, mustEntitlement(t, 0.2, 800))
	for _, v := range []float64{math.NaN(), math.Inf(1), math.Inf(-1)} {
		if err := s.AddUsage(w, v, 0); !errors.Is(err, domain.ErrInvalidQuota) {
			t.Fatalf("AddUsage(%v) should be ErrInvalidQuota, got %v", v, err)
		}
	}
}

func Test_Transfer_rejects_nonfinite_cu(t *testing.T) {
	s := NewStore(72)
	a, b := mustWallet(t, testWalletA), mustWallet(t, testWalletB)
	s.SetEntitlement(a, mustEntitlement(t, 0.2, 800))
	for _, v := range []float64{math.NaN(), math.Inf(1), math.Inf(-1)} {
		if err := s.Transfer(a, b, 0, v); !errors.Is(err, domain.ErrInvalidQuota) {
			t.Fatalf("Transfer(cu=%v) should be ErrInvalidQuota, got %v", v, err)
		}
	}
}

func Test_TransferPaid_spent_registry(t *testing.T) {
	s := NewStore(72)
	a, b := mustWallet(t, testWalletA), mustWallet(t, testWalletB)
	s.SetEntitlement(a, mustEntitlement(t, 0.2, 800))
	if _, err := s.TransferPaid(a, b, 100, 50000, "0xabc", 5); err != nil {
		t.Fatalf("first paid move: %v", err)
	}
	if _, err := s.TransferPaid(a, b, 10, 5000, "0xabc", 5); !errors.Is(err, ErrDuplicatePayment) {
		t.Fatalf("replay should be ErrDuplicatePayment, got %v", err)
	}
	if _, err := s.TransferPaid(a, b, 99999, 0, "0xdef", 5); !errors.Is(err, ErrInsufficientQuota) {
		t.Fatalf("oversized should be ErrInsufficientQuota, got %v", err)
	}
	if _, err := s.TransferPaid(a, b, 10, 5000, "0xdef", 5); err != nil {
		t.Fatalf("failed move must not consume the hash: %v", err)
	}
}

func Test_Transfer_zero_drain(t *testing.T) {
	s := NewStore(72)
	a, b := mustWallet(t, testWalletA), mustWallet(t, testWalletB)
	s.SetEntitlement(a, mustEntitlement(t, 0.2, 800))
	if err := s.Transfer(a, b, 800, 0.01); !errors.Is(err, ErrInsufficientQuota) {
		t.Fatalf("mem drain should be ErrInsufficientQuota, got %v", err)
	}
	if err := s.Transfer(a, b, 10, 0.2); !errors.Is(err, ErrInsufficientQuota) {
		t.Fatalf("cpu drain should be ErrInsufficientQuota, got %v", err)
	}
	if _, err := s.TransferPaid(a, b, 800, 10000, "0xdrain", 5); !errors.Is(err, ErrInsufficientQuota) {
		t.Fatalf("paid mem drain should be ErrInsufficientQuota, got %v", err)
	}
}

func Test_BeginExec_zero_slice_blocked(t *testing.T) {
	s := NewStore(72)
	w := mustWallet(t, testWalletA)
	s.SetEntitlement(w, domain.Entitlement{})
	if err := s.BeginExec(w); !errors.Is(err, ErrQuotaExceeded) {
		t.Fatalf("zero-slice BeginExec should be ErrQuotaExceeded, got %v", err)
	}
}

func Test_Reserve_confirm_rollback(t *testing.T) {
	cap := AdmitCap{TotalCPUMicro: 1000000, TotalMemMB: 4096, MaxAgents: 5}
	s := NewStore(72)
	a := mustWallet(t, testWalletA)
	isNew, err := s.Reserve(a, 200000, 800, cap)
	if err != nil {
		t.Fatalf("reserve: %v", err)
	}
	if !isNew {
		t.Fatal("first reserve must report new")
	}
	if err := s.ConfirmReserve(a, "ctr-1"); err != nil {
		t.Fatalf("confirm: %v", err)
	}
	isNew, err = s.Reserve(a, 500000, 1000, cap)
	if err != nil {
		t.Fatalf("re-reserve: %v", err)
	}
	if isNew {
		t.Fatal("re-reserve must report existing")
	}
	s.RollbackReserve(a)
	got, err := s.Entitlement(a)
	if err != nil {
		t.Fatalf("entitlement: %v", err)
	}
	if got.CPU != 0.2 || got.MemMB != 800 {
		t.Fatalf("rollback must restore previous slice, got %+v", got)
	}
	if cid, err := s.Container(a); err != nil || cid != "ctr-1" {
		t.Fatalf("resize rollback must keep the old container binding, got %q/%v", cid, err)
	}

	b := mustWallet(t, testWalletB)
	if _, err := s.Reserve(b, 100000, 100, cap); err != nil {
		t.Fatalf("reserve: %v", err)
	}
	s.RollbackReserve(b)
	if s.HasWallet(b) {
		t.Fatal("rolled-back new wallet must vanish")
	}
}

func Test_Reserve_boundary_exact(t *testing.T) {
	cap := AdmitCap{TotalCPUMicro: 1000000, TotalMemMB: 4096, MaxAgents: 5}
	wallets := []string{
		"0x1111111111111111111111111111111111111111",
		"0x2222222222222222222222222222222222222222",
		"0x3333333333333333333333333333333333333333",
		"0x4444444444444444444444444444444444444444",
		"0x5555555555555555555555555555555555555555",
	}
	s := NewStore(72)
	for _, addr := range wallets {
		if _, err := s.Reserve(mustWallet(t, addr), 200000, 819, cap); err != nil {
			t.Fatalf("reserve %s: %v", addr, err)
		}
	}
	cpu, mem := s.Totals()
	if cpuMicro(cpu) != 1000000 || mem != 4095 {
		t.Fatalf("totals = %v/%d, want exactly 1000000 micro / 4095", cpu, mem)
	}
	if _, err := s.Reserve(mustWallet(t, testWalletA), 1, 1, cap); !errors.Is(err, ErrPoolExhausted) {
		t.Fatalf("over-cap micro-slice should be ErrPoolExhausted, got %v", err)
	}
}

func Test_Reserve_concurrent_never_exceeds(t *testing.T) {
	cap := AdmitCap{TotalCPUMicro: 1000000, TotalMemMB: 4096, MaxAgents: 100}
	s := NewStore(72)
	const n = 8
	errs := make(chan error, n)
	for i := 0; i < n; i++ {
		go func(i int) {
			w, err := domain.NewWalletAddress(fmt.Sprintf("0x%040x", i+1))
			if err != nil {
				errs <- err
				return
			}
			_, err = s.Reserve(w, 200000, 819, cap)
			errs <- err
		}(i)
	}
	succeeded := 0
	for i := 0; i < n; i++ {
		if err := <-errs; err == nil {
			succeeded++
		} else if !errors.Is(err, ErrPoolExhausted) {
			t.Fatalf("unexpected error: %v", err)
		}
	}
	if succeeded != 5 {
		t.Fatalf("succeeded = %d, want exactly 5 fitting slices", succeeded)
	}
	cpu, mem := s.Totals()
	if cpuMicro(cpu) > 1000000 || mem > 4096 {
		t.Fatalf("totals exceeded cap: %v/%d", cpu, mem)
	}
}

func Test_TransferPaid_recipient_cap(t *testing.T) {
	s := NewStore(72)
	addrs := []string{
		testWalletA, testWalletB,
		"0x1111111111111111111111111111111111111111",
		"0x2222222222222222222222222222222222222222",
		"0x3333333333333333333333333333333333333333",
	}
	for _, addr := range addrs {
		s.SetEntitlement(mustWallet(t, addr), mustEntitlement(t, 0.2, 800))
	}
	a := mustWallet(t, testWalletA)
	newcomer := mustWallet(t, "0x4444444444444444444444444444444444444444")
	if _, err := s.TransferPaid(a, newcomer, 10, 10000, "0xcap", 5); !errors.Is(err, ErrPoolExhausted) {
		t.Fatalf("6th agent via transfer should be ErrPoolExhausted, got %v", err)
	}
}

func Test_Token_expiry_epoch_settlement(t *testing.T) {
	s := NewStore(1)
	cur := time.Now()
	s.SetNowFunc(func() time.Time { return cur })
	w := mustWallet(t, testWalletA)
	tok, err := s.IssueToken(w)
	if err != nil {
		t.Fatalf("issue: %v", err)
	}
	cur = cur.Add(2 * time.Hour)
	if err := s.Authenticate(w, tok); !errors.Is(err, ErrTokenExpired) {
		t.Fatalf("past alloc+window should be ErrTokenExpired, got %v", err)
	}
	s.MarkSettled()
	cur = cur.Add(30 * time.Minute)
	if err := s.Authenticate(w, tok); err != nil {
		t.Fatalf("settle re-anchors expiry to settledAt+window: %v", err)
	}
	cur = cur.Add(31 * time.Minute)
	if err := s.Authenticate(w, tok); !errors.Is(err, ErrTokenExpired) {
		t.Fatalf("past settledAt+window should be ErrTokenExpired, got %v", err)
	}
	if s.SettledAt().IsZero() {
		t.Fatal("SettledAt must be recorded")
	}
}

func Test_Round_settle_is_per_round(t *testing.T) {
	s := NewStore(72)
	one := big.NewInt(1)
	two := big.NewInt(2)
	if s.IsRoundSettled(one) {
		t.Fatal("round 1 starts unsettled")
	}
	if !s.MarkRoundSettled(one) {
		t.Fatal("first MarkRoundSettled(1) must win")
	}
	if s.MarkRoundSettled(one) {
		t.Fatal("second MarkRoundSettled(1) must lose")
	}
	if !s.IsRoundSettled(one) {
		t.Fatal("round 1 must read settled")
	}
	if s.IsRoundSettled(two) {
		t.Fatal("settling round 1 must not settle round 2")
	}
	if s.IsRoundSettled(nil) {
		t.Fatal("nil round reads unsettled")
	}
	if s.MarkRoundSettled(nil) {
		t.Fatal("nil round never flips")
	}
	if s.RoundSettledAt(two).IsZero() == false {
		t.Fatal("unsettled round has no settle instant")
	}
	if s.RoundSettledAt(one).IsZero() {
		t.Fatal("settled round must record its instant")
	}
	if s.IsSettled() {
		t.Fatal("round settle must not flip the legacy v1 flag")
	}
}

func Test_Round_allowlist_prior_rounds_confer_no_access(t *testing.T) {
	s := NewStore(72)
	a := mustWallet(t, testWalletA)
	b := mustWallet(t, testWalletB)
	s.SetCurrentRound(big.NewInt(1))
	tokA, err := s.IssueToken(a)
	if err != nil {
		t.Fatalf("issue: %v", err)
	}
	if err := s.Authenticate(a, tokA); err != nil {
		t.Fatalf("same-round auth: %v", err)
	}
	s.SetCurrentRound(big.NewInt(2))
	if err := s.Authenticate(a, tokA); !errors.Is(err, ErrTokenExpired) {
		t.Fatalf("prior-round wallet must be 403 after advance, got %v", err)
	}
	tokB, err := s.IssueToken(b)
	if err != nil {
		t.Fatalf("issue: %v", err)
	}
	if err := s.Authenticate(b, tokB); err != nil {
		t.Fatalf("current-round auth: %v", err)
	}
	if err := s.Authenticate(a, tokB); !errors.Is(err, ErrTokenInvalid) {
		t.Fatalf("cross-wallet token must be 401, got %v", err)
	}
}

func Test_Round_reserve_stamps_and_rollback_restores(t *testing.T) {
	s := NewStore(72)
	s.SetCurrentRound(big.NewInt(3))
	w := mustWallet(t, testWalletA)
	cap := AdmitCap{TotalCPUMicro: MicroCU(1), TotalMemMB: 4096, MaxAgents: 5}
	if _, err := s.Reserve(w, MicroCU(0.2), 800, cap); err != nil {
		t.Fatalf("reserve: %v", err)
	}
	got, err := s.WalletRound(w)
	if err != nil || got == nil || got.Cmp(big.NewInt(3)) != 0 {
		t.Fatalf("WalletRound = %v, %v; want 3", got, err)
	}
	if err := s.ConfirmReserve(w, "c1"); err != nil {
		t.Fatalf("confirm: %v", err)
	}
	s.SetCurrentRound(big.NewInt(4))
	if _, err := s.Reserve(w, MicroCU(0.5), 1000, cap); err != nil {
		t.Fatalf("re-reserve: %v", err)
	}
	s.RollbackReserve(w)
	got, err = s.WalletRound(w)
	if err != nil || got == nil || got.Cmp(big.NewInt(3)) != 0 {
		t.Fatalf("rollback must restore round 3, got %v, %v", got, err)
	}
}

func Test_Round_expiry_anchors_to_round_settle(t *testing.T) {
	s := NewStore(1)
	cur := time.Now()
	s.SetNowFunc(func() time.Time { return cur })
	s.SetCurrentRound(big.NewInt(7))
	w := mustWallet(t, testWalletA)
	tok, err := s.IssueToken(w)
	if err != nil {
		t.Fatalf("issue: %v", err)
	}
	cur = cur.Add(2 * time.Hour)
	if err := s.Authenticate(w, tok); !errors.Is(err, ErrTokenExpired) {
		t.Fatalf("past alloc+window should expire, got %v", err)
	}
	s.MarkRoundSettled(big.NewInt(7))
	cur = cur.Add(30 * time.Minute)
	if err := s.Authenticate(w, tok); err != nil {
		t.Fatalf("round settle re-anchors expiry to round settledAt+window: %v", err)
	}
	s.MarkRoundSettled(big.NewInt(8))
	cur = cur.Add(31 * time.Minute)
	if err := s.Authenticate(w, tok); !errors.Is(err, ErrTokenExpired) {
		t.Fatalf("past round settledAt+window should expire, got %v", err)
	}
}

func Test_FundingClosed_tracks_current_round(t *testing.T) {
	s := NewStore(72)
	if s.FundingClosed() {
		t.Fatal("fresh ledger funds open")
	}
	s.MarkSettled()
	if !s.FundingClosed() {
		t.Fatal("legacy settle closes funding")
	}
	s2 := NewStore(72)
	s2.SetCurrentRound(big.NewInt(1))
	if s2.FundingClosed() {
		t.Fatal("unsettled current round funds open")
	}
	s2.MarkRoundSettled(big.NewInt(2))
	if s2.FundingClosed() {
		t.Fatal("settling a foreign round must not close the current round")
	}
	s2.MarkRoundSettled(big.NewInt(1))
	if !s2.FundingClosed() {
		t.Fatal("settling the current round closes funding")
	}
	s2.SetCurrentRound(big.NewInt(3))
	if s2.FundingClosed() {
		t.Fatal("advancing to an open round reopens funding")
	}
}

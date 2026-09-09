package api

import (
	"context"
	"testing"
)

// Test_Worker_idles_before_settle: funding still open means the compute
// window has not begun, so a tick burns nothing even with live containers.
func Test_Worker_idles_before_settle(t *testing.T) {
	f := newFixture()
	allocate(t, f, testWalletA, 0.2, 800)
	if got := f.srv.workOnce(context.Background()); got != 0 {
		t.Fatalf("workOnce=%d pre-settle, want 0", got)
	}
}

// Test_Inflight_tracks_open_exec: an unclosed BeginExec shows up as live
// spend, so bars climb mid-burn instead of jumping only at EndExec billing.
func Test_Inflight_tracks_open_exec(t *testing.T) {
	f := newFixture()
	allocate(t, f, testWalletA, 0.2, 800)
	w := mustWallet(t, testWalletA)
	if err := f.led.BeginExec(w); err != nil {
		t.Fatalf("BeginExec: %v", err)
	}
	cu, mb, err := f.led.Inflight(w)
	if err != nil {
		t.Fatalf("Inflight: %v", err)
	}
	if cu <= 0 || mb <= 0 {
		t.Fatalf("inflight cu=%v mb=%v, want both positive mid-exec", cu, mb)
	}
}
// Test_Worker_burns_after_settle: once the ledger flips, one tick burns once
// per live container through the same metered seam as /run.
func Test_Worker_burns_after_settle(t *testing.T) {
	f := newFixture()
	allocate(t, f, testWalletA, 0.2, 800)
	f.led.MarkSettled()
	if got := f.srv.workOnce(context.Background()); got != 1 {
		t.Fatalf("workOnce=%d post-settle, want 1", got)
	}
}

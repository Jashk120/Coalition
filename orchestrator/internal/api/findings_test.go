package api

import (
	"context"
	"encoding/json"
	"errors"
	"math/big"
	"net/http"
	"testing"

	"github.com/Jashk120/Coalition/orchestrator/internal/backend"
	"github.com/Jashk120/Coalition/orchestrator/internal/settle"
)

const (
	testPoolAddr = "0x5555555555555555555555555555555555555555"
	testWalletG  = "0x6666666666666666666666666666666666666666"
	testWalletH  = "0x7777777777777777777777777777777777777777"
	stubTxHash2  = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
)

func codeOf(t *testing.T, recBody []byte) string {
	t.Helper()
	var errBody struct {
		Code string `json:"code"`
	}
	if err := json.Unmarshal(recBody, &errBody); err != nil {
		t.Fatalf("decode error body: %v", err)
	}
	return errBody.Code
}

func Test_Transfer_replay_rejected(t *testing.T) {
	f := newFixture()
	allocate(t, f, testWalletA, 0.2, 800)
	body := `{"from":"` + testWalletA + `","to":"` + testWalletB + `","mb":100,"cu":0.05,"txHash":"` + stubTxHash + `"}`
	if rec := doAuthed(f, http.MethodPost, "/transfer-quota", body, testWalletA); rec.Code != http.StatusOK {
		t.Fatalf("first transfer: status=%d body=%s", rec.Code, rec.Body.String())
	}
	rec := doAuthed(f, http.MethodPost, "/transfer-quota", body, testWalletA)
	if rec.Code != http.StatusConflict {
		t.Fatalf("replay: status=%d body=%s, want 409", rec.Code, rec.Body.String())
	}
	if got := codeOf(t, rec.Body.Bytes()); got != "duplicate_payment" {
		t.Fatalf("code = %q, want duplicate_payment", got)
	}
}

func Test_Transfer_hash_merits_not_spent_state(t *testing.T) {
	f := newFixture()
	allocate(t, f, testWalletA, 0.2, 800)
	stub := f.srv.verifier.(*stubVerifier)
	stub.receipts[stubTxHash2] = &settle.Receipt{
		From:        testWalletB,
		To:          testWalletA,
		Value:       big.NewInt(1),
		BlockNumber: big.NewInt(0x20),
		Status:      "0x1",
		TxHash:      stubTxHash2,
	}
	oversized := `{"from":"` + testWalletA + `","to":"` + testWalletB + `","mb":99999,"cu":0,"txHash":"` + stubTxHash2 + `"}`
	if rec := doAuthed(f, http.MethodPost, "/transfer-quota", oversized, testWalletA); rec.Code != http.StatusConflict {
		t.Fatalf("oversized: status=%d, want 409", rec.Code)
	}
	underpaid := `{"from":"` + testWalletA + `","to":"` + testWalletB + `","mb":100,"cu":0.05,"txHash":"` + stubTxHash2 + `"}`
	rec := doAuthed(f, http.MethodPost, "/transfer-quota", underpaid, testWalletA)
	if rec.Code != http.StatusPaymentRequired {
		t.Fatalf("underpaid with unconsumed hash: status=%d body=%s, want 402", rec.Code, rec.Body.String())
	}
}

func Test_Transfer_recipient_token_chain(t *testing.T) {
	f := newFixture()
	allocate(t, f, testWalletA, 0.2, 800)
	stub := f.srv.verifier.(*stubVerifier)
	r := *stub.receipts[stubTxHash]
	r.From = testWalletG
	r.To = testWalletA
	stub.receipts[stubTxHash] = &r
	body := `{"from":"` + testWalletA + `","to":"` + testWalletG + `","mb":100,"cu":0.05,"txHash":"` + stubTxHash + `"}`
	rec := doAuthed(f, http.MethodPost, "/transfer-quota", body, testWalletA)
	if rec.Code != http.StatusOK {
		t.Fatalf("transfer: status=%d body=%s", rec.Code, rec.Body.String())
	}
	var out struct {
		ToToken string `json:"toToken"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if out.ToToken == "" {
		t.Fatal("transfer to new wallet must return its token")
	}
	f.tok[testWalletG] = out.ToToken
	id := allocate(t, f, testWalletG, 0.05, 100)
	if id == "" {
		t.Fatal("allocate with transfer-issued token must succeed")
	}
	if rec := doAuthed(f, http.MethodPost, "/run",
		`{"wallet":"`+testWalletG+`","cmd":["echo","hi"]}`, testWalletG); rec.Code != http.StatusOK {
		t.Fatalf("run with rotated token: status=%d body=%s", rec.Code, rec.Body.String())
	}
}

func Test_Transfer_zero_drain_rejected(t *testing.T) {
	f := newFixture()
	allocate(t, f, testWalletA, 0.2, 800)
	for _, tc := range []struct {
		name string
		body string
	}{
		{"drain mem", `{"from":"` + testWalletA + `","to":"` + testWalletB + `","mb":800,"cu":0.01,"txHash":"` + stubTxHash + `"}`},
		{"drain cpu", `{"from":"` + testWalletA + `","to":"` + testWalletB + `","mb":10,"cu":0.2,"txHash":"` + stubTxHash + `"}`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			rec := doAuthed(f, http.MethodPost, "/transfer-quota", tc.body, testWalletA)
			if rec.Code != http.StatusConflict {
				t.Fatalf("status=%d body=%s, want 409", rec.Code, rec.Body.String())
			}
			if got := codeOf(t, rec.Body.Bytes()); got != "insufficient_quota" {
				t.Fatalf("code = %q, want insufficient_quota", got)
			}
		})
	}
}

func Test_Transfer_invalid_amounts_no_rpc(t *testing.T) {
	f := newFixture()
	allocate(t, f, testWalletA, 0.2, 800)
	stub := f.srv.verifier.(*stubVerifier)
	for _, tc := range []struct {
		name string
		body string
	}{
		{"negative mb", `{"from":"` + testWalletA + `","to":"` + testWalletB + `","mb":-5,"cu":0.01,"txHash":"` + stubTxHash + `"}`},
		{"negative cu", `{"from":"` + testWalletA + `","to":"` + testWalletB + `","mb":5,"cu":-0.01,"txHash":"` + stubTxHash + `"}`},
		{"zero-zero", `{"from":"` + testWalletA + `","to":"` + testWalletB + `","mb":0,"cu":0,"txHash":"` + stubTxHash + `"}`},
		{"NaN cu", `{"from":"` + testWalletA + `","to":"` + testWalletB + `","mb":5,"cu":NaN,"txHash":"` + stubTxHash + `"}`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			before := stub.calls
			rec := doAuthed(f, http.MethodPost, "/transfer-quota", tc.body, testWalletA)
			if rec.Code != http.StatusBadRequest {
				t.Fatalf("status=%d body=%s, want 400", rec.Code, rec.Body.String())
			}
			if stub.calls != before {
				t.Fatalf("invalid amounts made %d RPC calls, want none", stub.calls-before)
			}
		})
	}
}

func Test_Transfer_recipient_max_agents(t *testing.T) {
	f := newFixture()
	for _, w := range []string{testWalletA, testWalletB, testWalletC, testWalletD, testWalletE} {
		allocate(t, f, w, 0.2, 800)
	}
	stub := f.srv.verifier.(*stubVerifier)
	r := *stub.receipts[stubTxHash]
	r.From = testWalletH
	r.To = testWalletA
	stub.receipts[stubTxHash] = &r
	body := `{"from":"` + testWalletA + `","to":"` + testWalletH + `","mb":10,"cu":0.01,"txHash":"` + stubTxHash + `"}`
	rec := doAuthed(f, http.MethodPost, "/transfer-quota", body, testWalletA)
	if rec.Code != http.StatusConflict {
		t.Fatalf("6th agent via transfer: status=%d body=%s, want 409", rec.Code, rec.Body.String())
	}
	if got := codeOf(t, rec.Body.Bytes()); got != "pool_exhausted" {
		t.Fatalf("code = %q, want pool_exhausted", got)
	}
}

type failBackend struct {
	backend.ContainerBackend
	failCreate bool
}

func (b failBackend) CreateContainer(_ context.Context, _ string, _ backend.Limits) (string, error) {
	if b.failCreate {
		return "", errors.New("daemon exploded")
	}
	return b.ContainerBackend.CreateContainer(context.Background(), "unreachable", backend.Limits{})
}

func Test_Allocate_rollback_on_backend_failure(t *testing.T) {
	f := newFixture()
	f.srv.backend = failBackend{ContainerBackend: f.be, failCreate: true}
	rec := doAppKey(f, http.MethodPost, "/allocate",
		`{"wallet":"`+testWalletA+`","cpu":0.2,"mem":800}`)
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status=%d body=%s, want 500", rec.Code, rec.Body.String())
	}
	if f.led.HasWallet(mustWallet(t, testWalletA)) {
		t.Fatal("failed create must roll back the reservation entirely")
	}

	f2 := newFixture()
	allocate(t, f2, testWalletA, 0.2, 800)
	f2.srv.backend = failBackend{ContainerBackend: f2.be, failCreate: true}
	rec = doAppKey(f2, http.MethodPost, "/allocate",
		`{"wallet":"`+testWalletA+`","cpu":0.5,"mem":1000}`)
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status=%d body=%s, want 500", rec.Code, rec.Body.String())
	}
	ent, err := f2.led.Entitlement(mustWallet(t, testWalletA))
	if err != nil {
		t.Fatalf("entitlement: %v", err)
	}
	if ent.CPU != 0.2 || ent.MemMB != 800 {
		t.Fatalf("failed resize must restore previous slice, got %+v", ent)
	}
}

func Test_Allocate_shrink_below_usage_rejected(t *testing.T) {
	f := newFixture()
	allocate(t, f, testWalletA, 0.2, 800)
	if err := f.led.AddUsage(mustWallet(t, testWalletA), 0.2*72*3600, 0); err != nil {
		t.Fatalf("usage: %v", err)
	}
	rec := doAppKey(f, http.MethodPost, "/allocate",
		`{"wallet":"`+testWalletA+`","cpu":0.1,"mem":400}`)
	if rec.Code != http.StatusConflict {
		t.Fatalf("shrink: status=%d body=%s, want 409", rec.Code, rec.Body.String())
	}
	if got := codeOf(t, rec.Body.Bytes()); got != "insufficient_quota" {
		t.Fatalf("code = %q, want insufficient_quota", got)
	}
}

func Test_Reaper_sweeps_idle_over_budget(t *testing.T) {
	f := newFixture()
	allocate(t, f, testWalletA, 0.2, 800)
	w := mustWallet(t, testWalletA)
	cid, err := f.led.Container(w)
	if err != nil {
		t.Fatalf("container: %v", err)
	}
	if err := f.led.AddUsage(w, 0.2*72*3600+100, 0); err != nil {
		t.Fatalf("usage: %v", err)
	}
	targets := f.led.ReapTargets()
	if len(targets) != 1 || targets[0].ContainerID != cid {
		t.Fatalf("idle over-budget wallet must be a reap target, got %+v", targets)
	}
	f.srv.reapOnce(context.Background())
	if !f.be.Killed(cid) {
		t.Fatal("reaper must kill idle over-budget containers")
	}
	if rec := doAuthed(f, http.MethodPost, "/run",
		`{"wallet":"`+testWalletA+`","cmd":["echo","hi"]}`, testWalletA); rec.Code != http.StatusForbidden {
		t.Fatalf("reaped wallet run: status=%d, want 403", rec.Code)
	}
}

func Test_Pool_closed_gate(t *testing.T) {
	f := newFixture()
	f.srv.cfg.PoolAddress = testPoolAddr
	stub := f.srv.verifier.(*stubVerifier)
	allocate(t, f, testWalletA, 0.2, 800)
	stub.views = &settle.PoolViews{Settled: false, Expired: true, TotalCommitted: big.NewInt(1)}

	rec := doAppKey(f, http.MethodPost, "/allocate",
		`{"wallet":"`+testWalletB+`","cpu":0.1,"mem":100}`)
	if rec.Code != http.StatusConflict || codeOf(t, rec.Body.Bytes()) != "pool_closed" {
		t.Fatalf("allocate on expired pool: status=%d body=%s, want 409 pool_closed", rec.Code, rec.Body.String())
	}
	rec = doRequest(f, http.MethodGet, "/quote?seller="+testWalletA, "")
	if rec.Code != http.StatusConflict || codeOf(t, rec.Body.Bytes()) != "pool_closed" {
		t.Fatalf("quote on expired pool: status=%d body=%s, want 409 pool_closed", rec.Code, rec.Body.String())
	}
	rec = doAuthed(f, http.MethodPost, "/transfer-quota",
		`{"from":"`+testWalletA+`","to":"`+testWalletB+`","mb":10,"cu":0.01,"txHash":"`+stubTxHash+`"}`, testWalletA)
	if rec.Code != http.StatusConflict || codeOf(t, rec.Body.Bytes()) != "pool_closed" {
		t.Fatalf("transfer on expired pool: status=%d body=%s, want 409 pool_closed", rec.Code, rec.Body.String())
	}
	if rec := doAuthed(f, http.MethodPost, "/run",
		`{"wallet":"`+testWalletA+`","cmd":["echo","hi"]}`, testWalletA); rec.Code != http.StatusOK {
		t.Fatalf("run continues on expired pool: status=%d body=%s, want 200", rec.Code, rec.Body.String())
	}
}

func Test_Pool_gate_open_and_fail_open(t *testing.T) {
	t.Run("filled-unsettled serves", func(t *testing.T) {
		f := newFixture()
		f.srv.cfg.PoolAddress = testPoolAddr
		stub := f.srv.verifier.(*stubVerifier)
		stub.views = &settle.PoolViews{Settled: false, Expired: false, TotalCommitted: big.NewInt(10000000)}
		allocate(t, f, testWalletA, 0.2, 800)
		if rec := doRequest(f, http.MethodGet, "/quote?seller="+testWalletA, ""); rec.Code != http.StatusOK {
			t.Fatalf("quote: status=%d", rec.Code)
		}
	})
	t.Run("node-down fails open", func(t *testing.T) {
		f := newFixture()
		f.srv.cfg.PoolAddress = testPoolAddr
		stub := f.srv.verifier.(*stubVerifier)
		stub.err = errors.New("node down")
		defer func() { stub.err = nil }()
		allocate(t, f, testWalletA, 0.2, 800)
		if rec := doRequest(f, http.MethodGet, "/quote?seller="+testWalletA, ""); rec.Code != http.StatusOK {
			t.Fatalf("quote with node down: status=%d, want fail-open 200", rec.Code)
		}
	})
	t.Run("unset pool skips gate", func(t *testing.T) {
		f := newFixture()
		allocate(t, f, testWalletA, 0.2, 800)
		if rec := doRequest(f, http.MethodGet, "/quote?seller="+testWalletA, ""); rec.Code != http.StatusOK {
			t.Fatalf("quote: status=%d", rec.Code)
		}
	})
}

func Test_Public_base_url_terms(t *testing.T) {
	f := newFixture()
	f.srv.cfg.PublicBaseURL = "https://pool.example"
	allocate(t, f, testWalletA, 0.2, 800)
	rec := doRequest(f, http.MethodGet, "/quote?seller="+testWalletA, "")
	if rec.Code != http.StatusOK {
		t.Fatalf("quote: status=%d", rec.Code)
	}
	var q struct {
		TermsURI string `json:"termsURI"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &q); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if q.TermsURI != "https://pool.example/terms.json" {
		t.Fatalf("termsURI = %q", q.TermsURI)
	}
	rec = doRequest(f, http.MethodGet, "/terms.json", "")
	var doc struct {
		Self string `json:"self"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &doc); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if doc.Self != "https://pool.example/terms.json" {
		t.Fatalf("self = %q", doc.Self)
	}
}

func Test_NewServer_rejects_bad_limiter(t *testing.T) {
	f := newFixture()
	for _, tc := range []struct {
		name  string
		rps   float64
		burst int64
	}{
		{"zero rps", 0, 10},
		{"negative rps", -1, 10},
		{"zero burst", 10, 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			cfg := f.srv.cfg
			cfg.RateLimitRPS = tc.rps
			cfg.RateLimitBurst = tc.burst
			if _, err := NewServer(cfg, f.led, f.be, f.srv.logger); err == nil {
				t.Fatal("expected limiter construction error")
			}
		})
	}
}

func Test_Transfer_cost_halved_model(t *testing.T) {
	f := newFixture()
	allocate(t, f, testWalletA, 0.2, 819)
	cost, err := transferCost(f.srv.cfg.TargetAtomic, f.srv.cfg.MemMB, f.srv.cfg.CPUTotal, 0.2, 819)
	if err != nil {
		t.Fatalf("cost: %v", err)
	}
	share := new(big.Int).Quo(f.srv.cfg.TargetAtomic, big.NewInt(5))
	gap := new(big.Int).Sub(share, cost)
	if gap.Sign() < 0 || gap.Cmp(big.NewInt(8192)) > 0 {
		t.Fatalf("equal-slice cost %s vs share %s: gap %s exceeds dust", cost, share, gap)
	}
}

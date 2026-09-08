package api

import (
	"context"
	"encoding/json"
	"math/big"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/Jashk120/Coalition/orchestrator/internal/domain"
	"github.com/Jashk120/Coalition/orchestrator/internal/settle"
)

const (
	testWalletC = "0x1111111111111111111111111111111111111111"
	testWalletD = "0x2222222222222222222222222222222222222222"
	testWalletE = "0x3333333333333333333333333333333333333333"
	testWalletF = "0x4444444444444444444444444444444444444444"
)

func Test_Allocate_token_lifecycle(t *testing.T) {
	f := newFixture()
	id := allocate(t, f, testWalletA, 0.2, 800)
	if id == "" {
		t.Fatal("no container")
	}
	good := f.tok[testWalletA]

	rec := doRequest(f, http.MethodPost, "/allocate",
		`{"wallet":"`+testWalletA+`","cpu":0.2,"mem":800}`)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("allocate without app key: status=%d body=%s, want 401", rec.Code, rec.Body.String())
	}
	rec = doRequestWith(f, http.MethodPost, "/allocate",
		`{"wallet":"`+testWalletA+`","cpu":0.2,"mem":800}`,
		map[string]string{appKeyHeader: "wrong-key-0123456789abcdef"})
	if rec.Code != http.StatusForbidden {
		t.Fatalf("allocate with wrong app key: status=%d, want 403", rec.Code)
	}
	rec = doRequestWith(f, http.MethodPost, "/allocate",
		`{"wallet":"`+testWalletA+`","cpu":0.2,"mem":800}`,
		map[string]string{"Authorization": "Bearer " + good})
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("allocate with agent token but no app key: status=%d, want 401", rec.Code)
	}
	rec = doAppKey(f, http.MethodPost, "/allocate",
		`{"wallet":"`+testWalletA+`","cpu":0.2,"mem":800}`)
	if rec.Code != http.StatusCreated {
		t.Fatalf("re-allocate with app key: status=%d body=%s", rec.Code, rec.Body.String())
	}
	var out struct {
		Token string `json:"token"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if out.Token == "" || out.Token == good {
		t.Fatal("re-allocate must rotate the token")
	}
}

func Test_Run_token_expiry_and_revocation(t *testing.T) {
	f := newFixture()
	allocate(t, f, testWalletA, 0.2, 800)
	w := mustWallet(t, testWalletA)

	f.led.SetTokenExpiry(w, time.Now().Add(-time.Hour))
	rec := doAuthed(f, http.MethodPost, "/run",
		`{"wallet":"`+testWalletA+`","cmd":["echo","hi"]}`, testWalletA)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("expired token: status=%d body=%s, want 403", rec.Code, rec.Body.String())
	}

	allocate(t, f, testWalletB, 0.2, 800)
	f.led.Revoke(mustWallet(t, testWalletB))
	rec = doAuthed(f, http.MethodPost, "/run",
		`{"wallet":"`+testWalletB+`","cmd":["echo","hi"]}`, testWalletB)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("revoked token: status=%d body=%s, want 403", rec.Code, rec.Body.String())
	}
}

func Test_Allocate_oversubscription_and_max_agents(t *testing.T) {
	f := newFixture()
	wallets := []string{testWalletA, testWalletB, testWalletC, testWalletD, testWalletE}
	for _, w := range wallets {
		allocate(t, f, w, 0.2, 819)
	}
	rec := doAppKey(f, http.MethodPost, "/allocate",
		`{"wallet":"`+testWalletF+`","cpu":0.1,"mem":100}`)
	if rec.Code != http.StatusConflict {
		t.Fatalf("6th wallet: status=%d body=%s, want 409", rec.Code, rec.Body.String())
	}
	var errBody struct {
		Code string `json:"code"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &errBody); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if errBody.Code != "pool_exhausted" {
		t.Fatalf("code = %q, want pool_exhausted", errBody.Code)
	}

	rec = doAppKey(f, http.MethodPost, "/allocate",
		`{"wallet":"`+testWalletA+`","cpu":0.2,"mem":820}`)
	if rec.Code != http.StatusCreated {
		t.Fatalf("existing-wallet top-up: status=%d body=%s, want 201", rec.Code, rec.Body.String())
	}
	var top struct {
		Token string `json:"token"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &top); err != nil {
		t.Fatalf("decode: %v", err)
	}
	f.tok[testWalletA] = top.Token

	rec = doAppKey(f, http.MethodPost, "/allocate",
		`{"wallet":"`+testWalletA+`","cpu":0.9,"mem":820}`)
	if rec.Code != http.StatusConflict {
		t.Fatalf("oversubscribing resize: status=%d body=%s, want 409", rec.Code, rec.Body.String())
	}
}

func Test_Allocate_rejected_once_settled(t *testing.T) {
	f := newFixture()
	allocate(t, f, testWalletA, 0.2, 800)
	f.led.MarkSettled()
	rec := doAppKey(f, http.MethodPost, "/allocate",
		`{"wallet":"`+testWalletA+`","cpu":0.2,"mem":800}`)
	if rec.Code != http.StatusConflict {
		t.Fatalf("allocate after settle: status=%d body=%s, want 409", rec.Code, rec.Body.String())
	}
	var errBody struct {
		Code string `json:"code"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &errBody); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if errBody.Code != "pool_settled" {
		t.Fatalf("code = %q, want pool_settled", errBody.Code)
	}
}

func Test_Run_autoprovisions_container(t *testing.T) {
	f := newFixture()
	w := mustWallet(t, testWalletA)
	ent, err := domain.NewEntitlement(0.2, 800)
	if err != nil {
		t.Fatalf("entitlement: %v", err)
	}
	f.led.SetEntitlement(w, ent)
	tok, err := f.led.IssueToken(w)
	if err != nil {
		t.Fatalf("issue token: %v", err)
	}
	f.tok[testWalletA] = tok
	if _, err := f.led.Container(w); err == nil {
		t.Fatal("precondition: wallet must have no container")
	}
	rec := doAuthed(f, http.MethodPost, "/run",
		`{"wallet":"`+testWalletA+`","cmd":["echo","hi"]}`, testWalletA)
	if rec.Code != http.StatusOK {
		t.Fatalf("auto-provision run: status=%d body=%s, want 200", rec.Code, rec.Body.String())
	}
	if _, err := f.led.Container(w); err != nil {
		t.Fatalf("container should be bound after auto-provision: %v", err)
	}
}

func Test_Transfer_creates_unknown_recipient(t *testing.T) {
	f := newFixture()
	allocate(t, f, testWalletA, 0.2, 800)
	stub := f.srv.verifier.(*stubVerifier)
	r := *stub.receipts[stubTxHash]
	r.From = testUnknown
	r.To = testWalletA
	stub.receipts[stubTxHash] = &r
	rec := doAuthed(f, http.MethodPost, "/transfer-quota",
		`{"from":"`+testWalletA+`","to":"`+testUnknown+`","mb":100,"cu":0.05,"txHash":"`+stubTxHash+`"}`, testWalletA)
	if rec.Code != http.StatusOK {
		t.Fatalf("transfer to unknown: status=%d body=%s", rec.Code, rec.Body.String())
	}
	if _, err := f.led.Entitlement(mustWallet(t, testUnknown)); err != nil {
		t.Fatalf("recipient entitlement should exist: %v", err)
	}
}

func Test_Transfer_payment_proofs(t *testing.T) {
	newPaidFixture := func(t *testing.T, mutate func(v *stubVerifier)) fixture {
		t.Helper()
		f := newFixture()
		allocate(t, f, testWalletA, 0.2, 800)
		if mutate != nil {
			mutate(f.srv.verifier.(*stubVerifier))
		}
		return f
	}
	transferBody := func(tx string) string {
		return `{"from":"` + testWalletA + `","to":"` + testWalletB + `","mb":100,"cu":0.05,"txHash":"` + tx + `"}`
	}
	t.Run("unknown tx is 402", func(t *testing.T) {
		f := newPaidFixture(t, nil)
		rec := doAuthed(f, http.MethodPost, "/transfer-quota",
			transferBody("0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"), testWalletA)
		if rec.Code != http.StatusPaymentRequired {
			t.Fatalf("status=%d body=%s, want 402", rec.Code, rec.Body.String())
		}
	})
	t.Run("underpayment is 402", func(t *testing.T) {
		f := newPaidFixture(t, func(v *stubVerifier) {
			r := *v.receipts[stubTxHash]
			r.Value = big.NewInt(1)
			v.receipts[stubTxHash] = &r
		})
		rec := doAuthed(f, http.MethodPost, "/transfer-quota", transferBody(stubTxHash), testWalletA)
		if rec.Code != http.StatusPaymentRequired {
			t.Fatalf("status=%d body=%s, want 402", rec.Code, rec.Body.String())
		}
	})
	t.Run("wrong payer is 402", func(t *testing.T) {
		f := newPaidFixture(t, func(v *stubVerifier) {
			r := *v.receipts[stubTxHash]
			r.From = testWalletC
			v.receipts[stubTxHash] = &r
		})
		rec := doAuthed(f, http.MethodPost, "/transfer-quota", transferBody(stubTxHash), testWalletA)
		if rec.Code != http.StatusPaymentRequired {
			t.Fatalf("status=%d body=%s, want 402", rec.Code, rec.Body.String())
		}
	})
	t.Run("reverted tx is 402", func(t *testing.T) {
		f := newPaidFixture(t, func(v *stubVerifier) {
			r := *v.receipts[stubTxHash]
			r.Status = "0x0"
			v.receipts[stubTxHash] = &r
		})
		rec := doAuthed(f, http.MethodPost, "/transfer-quota", transferBody(stubTxHash), testWalletA)
		if rec.Code != http.StatusPaymentRequired {
			t.Fatalf("status=%d body=%s, want 402", rec.Code, rec.Body.String())
		}
	})
	t.Run("unconfirmed tx is 402", func(t *testing.T) {
		f := newPaidFixture(t, func(v *stubVerifier) {
			v.head = big.NewInt(0x1F)
		})
		rec := doAuthed(f, http.MethodPost, "/transfer-quota", transferBody(stubTxHash), testWalletA)
		if rec.Code != http.StatusPaymentRequired {
			t.Fatalf("status=%d body=%s, want 402", rec.Code, rec.Body.String())
		}
	})
	t.Run("malformed txHash is 400", func(t *testing.T) {
		f := newPaidFixture(t, nil)
		rec := doAuthed(f, http.MethodPost, "/transfer-quota", transferBody("not-a-hash"), testWalletA)
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("status=%d body=%s, want 400", rec.Code, rec.Body.String())
		}
	})
}

func Test_Reaper_kills_and_revokes(t *testing.T) {
	f := newFixture()
	id := allocate(t, f, testWalletA, 0.2, 800)
	w := mustWallet(t, testWalletA)
	if err := f.led.BeginExec(w); err != nil {
		t.Fatalf("begin: %v", err)
	}
	if err := f.led.AddUsage(w, 0.2*72*3600+100, 0); err != nil {
		t.Fatalf("usage: %v", err)
	}
	targets := f.led.ReapTargets()
	if len(targets) != 1 || targets[0].ContainerID != id {
		t.Fatalf("targets = %+v, want the over-budget container", targets)
	}
	f.srv.reapOnce(context.Background())
	if !f.be.Killed(id) {
		t.Fatal("reaper must kill the over-budget container")
	}
	rec := doAuthed(f, http.MethodPost, "/run",
		`{"wallet":"`+testWalletA+`","cmd":["echo","hi"]}`, testWalletA)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("reaped wallet: status=%d body=%s, want 403", rec.Code, rec.Body.String())
	}
}

func Test_Reaper_context_cancel_stops(t *testing.T) {
	f := newFixture()
	id := allocate(t, f, testWalletA, 0.2, 800)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	f.srv.StartReaper(ctx)
	if f.be.Killed(id) {
		t.Fatal("cancelled reaper must not kill anything")
	}
	if got := f.led.ReapTargets(); len(got) != 0 {
		t.Fatalf("nothing over budget, targets = %+v", got)
	}
}

func Test_Rate_limit_and_body_cap(t *testing.T) {
	f := newFixture()
	limiter, err := newIPLimiter(1, 1)
	if err != nil {
		t.Fatalf("limiter: %v", err)
	}
	f.srv.limiter = limiter
	if rec := doRequest(f, http.MethodGet, "/healthz", ""); rec.Code != http.StatusOK {
		t.Fatalf("first request: status=%d", rec.Code)
	}
	if rec := doRequest(f, http.MethodGet, "/healthz", ""); rec.Code != http.StatusTooManyRequests {
		t.Fatalf("second request: status=%d, want 429", rec.Code)
	}

	f2 := newFixture()
	big := `{"wallet":"` + testWalletA + `","cpu":0.2,"mem":800,"pad":"` + strings.Repeat("x", 2<<20) + `"}`
	if rec := doAppKey(f2, http.MethodPost, "/allocate", big); rec.Code != http.StatusBadRequest {
		t.Fatalf("oversize body: status=%d, want 400", rec.Code)
	}
}

func Test_Proxy_headers_ignored_by_default(t *testing.T) {
	f := newFixture()
	allocate(t, f, testWalletA, 0.2, 800)
	rec := doRequestWith(f, http.MethodGet, "/quote?seller="+testWalletA, "",
		map[string]string{"X-Forwarded-Host": "evil.example", "X-Forwarded-Proto": "https"})
	if rec.Code != http.StatusOK {
		t.Fatalf("quote: status=%d", rec.Code)
	}
	var q struct {
		TermsURI string `json:"termsURI"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &q); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if strings.Contains(q.TermsURI, "evil.example") {
		t.Fatalf("untrusted proxy header leaked into termsURI: %q", q.TermsURI)
	}
}

func Test_Settle_client_receipt_missing(t *testing.T) {
	c := settle.NewClient("http://127.0.0.1:1")
	_, err := c.TransactionReceipt(context.Background(), stubTxHash)
	if err == nil {
		t.Fatal("unreachable RPC must error")
	}
}

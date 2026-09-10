package api

import (
	"encoding/json"
	"fmt"
	"math/big"
	"net/http"
	"strings"
	"testing"
)

type fillPlanOut struct {
	Sellers []struct {
		Wallet       string `json:"wallet"`
		MB           int64  `json:"mb"`
		CUMicro      int64  `json:"cuMicro"`
		AmountAtomic string `json:"amountAtomic"`
	} `json:"sellers"`
	TotalAtomic string `json:"totalAtomic"`
}

func postFillPlan(t *testing.T, f fixture, wallet string, cu float64, mem int64) (int, fillPlanOut) {
	t.Helper()
	body := fmt.Sprintf(`{"wallet":%q,"cu":%v,"mem":%d}`, wallet, cu, mem)
	rec := doRequest(f, http.MethodPost, "/fill-plan", body)
	var out fillPlanOut
	if rec.Code == http.StatusOK {
		if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
			t.Fatalf("decode fill-plan: %v", err)
		}
	}
	return rec.Code, out
}

func multilegBody(buyer string, plan fillPlanOut, ids []string) string {
	var sb strings.Builder
	sb.WriteString(`{"to":` + fmt.Sprintf("%q", buyer) + `,"legs":[`)
	for i, leg := range plan.Sellers {
		if i > 0 {
			sb.WriteString(",")
		}
		fmt.Fprintf(&sb, `{"seller":%q,"mb":%d,"cu":%v}`, leg.Wallet, leg.MB, float64(leg.CUMicro)/1e6)
	}
	sb.WriteString(`],"payments":[`)
	for i, leg := range plan.Sellers {
		if i > 0 {
			sb.WriteString(",")
		}
		fmt.Fprintf(&sb, `{"seller":%q,"amountAtomic":%q,"settlementId":%q}`, leg.Wallet, leg.AmountAtomic, ids[i])
	}
	sb.WriteString(`]}`)
	return sb.String()
}

func Test_X402_fill_commit_happy(t *testing.T) {
	f := newFixture()
	allocate(t, f, testWalletA, 0.2, 800)
	allocate(t, f, testWalletB, 0.2, 800)

	code, plan := postFillPlan(t, f, testWalletF, 0.1, 1000)
	if code != http.StatusOK {
		t.Fatalf("fill-plan: status=%d", code)
	}
	if len(plan.Sellers) != 2 {
		t.Fatalf("want 2 legs, got %+v", plan)
	}
	if plan.Sellers[0].Wallet != testWalletA || plan.Sellers[1].Wallet != testWalletB {
		t.Fatalf("legs must be wallet-sorted on tied MB-hours, got %+v", plan.Sellers)
	}
	if plan.TotalAtomic == "" || plan.TotalAtomic == "0" {
		t.Fatalf("totalAtomic = %q", plan.TotalAtomic)
	}
	var sum = big.NewInt(0)
	for _, leg := range plan.Sellers {
		v, ok := new(big.Int).SetString(leg.AmountAtomic, 10)
		if !ok || v.Sign() <= 0 {
			t.Fatalf("leg amountAtomic = %q", leg.AmountAtomic)
		}
		sum.Add(sum, v)
	}
	if sum.String() != plan.TotalAtomic {
		t.Fatalf("totalAtomic = %q, sum of legs = %q", plan.TotalAtomic, sum)
	}

	// No facilitator HTTP exists on this path: operator-attested settlement
	// ids plus spend-once plus the atomic commit are the proof, so the
	// commit must succeed with no outbound verify of any kind.
	body := multilegBody(testWalletF, plan, []string{"settle-aaa", "settle-bbb"})
	rec := doAppKey(f, http.MethodPost, "/transfer-quota", body)
	if rec.Code != http.StatusOK {
		t.Fatalf("multileg commit: status=%d body=%s", rec.Code, rec.Body.String())
	}
	var out struct {
		Sellers []struct {
			Wallet string  `json:"wallet"`
			MemMB  int64   `json:"memMB"`
			CPU    float64 `json:"cpu"`
		} `json:"sellers"`
		To struct {
			Wallet string  `json:"wallet"`
			MemMB  int64   `json:"memMB"`
			CPU    float64 `json:"cpu"`
		} `json:"to"`
		ToToken string `json:"toToken"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if out.To.MemMB != 1000 || out.To.CPU != 0.1 {
		t.Fatalf("buyer slice wrong: %+v", out.To)
	}
	if out.ToToken == "" {
		t.Fatal("new buyer must be minted a token")
	}
	entA, _ := f.led.Entitlement(mustWallet(t, testWalletA))
	if entA.MemMB != 1 || entA.CPU != 0.1 {
		t.Fatalf("seller A after commit: %+v", entA)
	}
	f.tok[testWalletF] = out.ToToken
	if rec := doAuthed(f, http.MethodPost, "/run",
		`{"wallet":"`+testWalletF+`","cmd":["echo","hi"]}`, testWalletF); rec.Code != http.StatusOK {
		t.Fatalf("buyer run with minted token: status=%d body=%s", rec.Code, rec.Body.String())
	}
}

func Test_X402_fill_insufficient_spare(t *testing.T) {
	f := newFixture()
	allocate(t, f, testWalletA, 0.2, 800)
	if code, _ := postFillPlan(t, f, testWalletF, 0.5, 99999); code != http.StatusConflict {
		t.Fatalf("oversized want: status=%d, want 409", code)
	}
	rec := doRequest(f, http.MethodPost, "/fill-plan", fmt.Sprintf(`{"wallet":%q,"cu":0.5,"mem":99999}`, testWalletF))
	if got := codeOf(t, rec.Body.Bytes()); got != "insufficient_spare" {
		t.Fatalf("code = %q, want insufficient_spare", got)
	}
}

func Test_X402_multileg_underpay(t *testing.T) {
	f := newFixture()
	allocate(t, f, testWalletA, 0.2, 800)
	allocate(t, f, testWalletB, 0.2, 800)

	_, plan := postFillPlan(t, f, testWalletF, 0.1, 1000)
	body := multilegBody(testWalletF, plan, []string{"settle-aaa", "settle-bbb"})
	var decoded struct {
		To       string           `json:"to"`
		Legs     []map[string]any `json:"legs"`
		Payments []map[string]any `json:"payments"`
	}
	if err := json.Unmarshal([]byte(body), &decoded); err != nil {
		t.Fatalf("decode: %v", err)
	}
	decoded.Payments[0]["amountAtomic"] = "1"
	raw, _ := json.Marshal(decoded)
	rec := doAppKey(f, http.MethodPost, "/transfer-quota", string(raw))
	if rec.Code != http.StatusPaymentRequired {
		t.Fatalf("underpay: status=%d body=%s, want 402", rec.Code, rec.Body.String())
	}
	if got := codeOf(t, rec.Body.Bytes()); got != "payment_required" {
		t.Fatalf("code = %q", got)
	}
	if f.led.HasWallet(mustWallet(t, testWalletF)) {
		t.Fatal("failed commit must not create buyer")
	}
}

func Test_X402_multileg_duplicate_replay(t *testing.T) {
	f := newFixture()
	allocate(t, f, testWalletA, 0.2, 800)
	allocate(t, f, testWalletB, 0.2, 800)

	_, plan := postFillPlan(t, f, testWalletF, 0.1, 1000)
	body := multilegBody(testWalletF, plan, []string{"settle-aaa", "settle-bbb"})
	if rec := doAppKey(f, http.MethodPost, "/transfer-quota", body); rec.Code != http.StatusOK {
		t.Fatalf("first commit: status=%d body=%s", rec.Code, rec.Body.String())
	}
	rec := doAppKey(f, http.MethodPost, "/transfer-quota", body)
	if rec.Code != http.StatusConflict {
		t.Fatalf("replay: status=%d body=%s, want 409", rec.Code, rec.Body.String())
	}
	if got := codeOf(t, rec.Body.Bytes()); got != "duplicate_payment" {
		t.Fatalf("code = %q, want duplicate_payment", got)
	}
}

func Test_X402_multileg_one_bad_leg_atomic(t *testing.T) {
	f := newFixture()
	allocate(t, f, testWalletA, 0.2, 800)
	allocate(t, f, testWalletB, 0.2, 800)

	_, plan := postFillPlan(t, f, testWalletF, 0.1, 1000)
	raw, _ := json.Marshal(map[string]any{
		"to": testWalletF,
		"legs": []map[string]any{
			{"seller": plan.Sellers[0].Wallet, "mb": plan.Sellers[0].MB, "cu": float64(plan.Sellers[0].CUMicro) / 1e6},
			{"seller": plan.Sellers[1].Wallet, "mb": 7999, "cu": 0},
		},
		"payments": []map[string]any{
			{"seller": plan.Sellers[0].Wallet, "amountAtomic": plan.Sellers[0].AmountAtomic, "settlementId": "settle-aaa"},
			{"seller": plan.Sellers[1].Wallet, "amountAtomic": "999999999999", "settlementId": "settle-bbb"},
		},
	})
	rec := doAppKey(f, http.MethodPost, "/transfer-quota", string(raw))
	if rec.Code != http.StatusConflict {
		t.Fatalf("bad leg: status=%d body=%s, want 409", rec.Code, rec.Body.String())
	}
	entA, err := f.led.Entitlement(mustWallet(t, testWalletA))
	if err != nil {
		t.Fatalf("entitlement A: %v", err)
	}
	if entA.MemMB != 800 || entA.CPU != 0.2 {
		t.Fatalf("seller A changed by failed commit: %+v", entA)
	}
	entB, err := f.led.Entitlement(mustWallet(t, testWalletB))
	if err != nil {
		t.Fatalf("entitlement B: %v", err)
	}
	if entB.MemMB != 800 || entB.CPU != 0.2 {
		t.Fatalf("seller B changed by failed commit: %+v", entB)
	}
	if f.led.HasWallet(mustWallet(t, testWalletF)) {
		t.Fatal("failed commit must not create buyer")
	}
	if err := f.led.CheckSettlementsUnused([]string{"settle-aaa", "settle-bbb"}); err != nil {
		t.Fatalf("failed commit must not consume proofs: %v", err)
	}
}

func Test_X402_multileg_wrong_auth_tier(t *testing.T) {
	f := newFixture()
	allocate(t, f, testWalletA, 0.2, 800)
	allocate(t, f, testWalletB, 0.2, 800)

	_, plan := postFillPlan(t, f, testWalletF, 0.1, 1000)
	body := multilegBody(testWalletF, plan, []string{"settle-aaa", "settle-bbb"})

	rec := doAuthed(f, http.MethodPost, "/transfer-quota", body, testWalletA)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("legs rail with agent bearer: status=%d body=%s, want 401", rec.Code, rec.Body.String())
	}
	rec = doRequestWith(f, http.MethodPost, "/transfer-quota", body, map[string]string{
		appKeyHeader: "wrong-key-0123456789abcdef",
	})
	if rec.Code != http.StatusForbidden {
		t.Fatalf("legs rail with wrong app key: status=%d body=%s, want 403", rec.Code, rec.Body.String())
	}
	rec = doRequestWith(f, http.MethodPost, "/transfer-quota",
		`{"from":"`+testWalletA+`","to":"`+testWalletB+`","mb":10,"cu":0.01,"txHash":"`+stubTxHash+`"}`,
		map[string]string{appKeyHeader: testAppKey})
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("single-leg rail with only app key: status=%d body=%s, want 401", rec.Code, rec.Body.String())
	}
}

func Test_X402_multileg_max_agents(t *testing.T) {
	f := newFixture()
	for _, w := range []string{testWalletA, testWalletB, testWalletC, testWalletD, testWalletE} {
		allocate(t, f, w, 0.2, 800)
	}

	if code, _ := postFillPlan(t, f, testWalletF, 0.01, 10); code != http.StatusOK {
		t.Fatalf("fill-plan for 6th wallet: status=%d, want 200", code)
	}
	_, plan := postFillPlan(t, f, testWalletF, 0.01, 10)
	body := multilegBody(testWalletF, plan, []string{"settle-cap-1", "settle-cap-2"})
	rec := doAppKey(f, http.MethodPost, "/transfer-quota", body)
	if rec.Code != http.StatusConflict {
		t.Fatalf("6th agent via multileg: status=%d body=%s, want 409", rec.Code, rec.Body.String())
	}
	if got := codeOf(t, rec.Body.Bytes()); got != "pool_exhausted" {
		t.Fatalf("code = %q, want pool_exhausted", got)
	}
}

func Test_X402_multileg_operator_attested_no_verify(t *testing.T) {
	f := newFixture()
	allocate(t, f, testWalletA, 0.2, 800)

	_, plan := postFillPlan(t, f, testWalletF, 0.01, 10)
	// Arbitrary operator-attested ids are accepted without any facilitator
	// HTTP: cost check + spend-once + atomic commit are the whole proof.
	body := multilegBody(testWalletF, plan, []string{"opaque-id-no-verify"})
	rec := doAppKey(f, http.MethodPost, "/transfer-quota", body)
	if rec.Code != http.StatusOK {
		t.Fatalf("operator-attested commit: status=%d body=%s, want 200", rec.Code, rec.Body.String())
	}
	// The same ids now spend once: a replay is duplicate_payment even though
	// nothing was ever verified externally.
	rec = doAppKey(f, http.MethodPost, "/transfer-quota", body)
	if rec.Code != http.StatusConflict {
		t.Fatalf("replay: status=%d body=%s, want 409", rec.Code, rec.Body.String())
	}
	if got := codeOf(t, rec.Body.Bytes()); got != "duplicate_payment" {
		t.Fatalf("code = %q, want duplicate_payment", got)
	}
}

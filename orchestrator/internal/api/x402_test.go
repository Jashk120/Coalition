package api

import (
	"encoding/json"
	"fmt"
	"math/big"
	"net/http"
	"strings"
	"testing"

	"github.com/Jashk120/Coalition/orchestrator/internal/domain"
)

type fillPlanOut struct {
	Outputs []struct {
		Account      string `json:"account"`
		AmountAtomic string `json:"amountAtomic"`
	} `json:"outputs"`
	TotalAtomic     string `json:"totalAtomic"`
	Nonce           string `json:"nonce"`
	RoundId         string `json:"roundId"`
	HeadroomMB      int64  `json:"headroomMB"`
	HeadroomCUMicro int64  `json:"headroomCUMicro"`
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

func fillPlanFixture(t *testing.T) fixture {
	t.Helper()
	f := settledV2Fixture(t, 7)
	for _, w := range []string{testWalletA, testWalletB, testWalletC, testWalletD} {
		allocate(t, f, w, 0.2, 800)
	}
	stub := f.srv.verifier.(*stubVerifier)
	stub.committed[testWalletA] = big.NewInt(3000000)
	stub.committed[testWalletB] = big.NewInt(2500000)
	stub.committed[testWalletC] = big.NewInt(2500000)
	stub.committed[testWalletD] = big.NewInt(2500000)
	return f
}

func planAmounts(t *testing.T, plan fillPlanOut) map[string]*big.Int {
	t.Helper()
	got := make(map[string]*big.Int, len(plan.Outputs))
	for _, o := range plan.Outputs {
		v, ok := new(big.Int).SetString(o.AmountAtomic, 10)
		if !ok || v.Sign() < 0 {
			t.Fatalf("account %s amountAtomic = %q, want uint decimal string", o.Account, o.AmountAtomic)
		}
		if _, dup := got[o.Account]; dup {
			t.Fatalf("duplicate output account %s", o.Account)
		}
		got[o.Account] = v
	}
	return got
}

func Test_X402_fill_plan_happy(t *testing.T) {
	f := fillPlanFixture(t)

	code, plan := postFillPlan(t, f, testWalletF, 0.05, 100)
	if code != http.StatusOK {
		t.Fatalf("fill-plan: status=%d", code)
	}
	if len(plan.Outputs) != 4 {
		t.Fatalf("want 4 outputs, got %+v", plan.Outputs)
	}
	for i := 1; i < len(plan.Outputs); i++ {
		if plan.Outputs[i-1].Account >= plan.Outputs[i].Account {
			t.Fatalf("outputs must be wallet-asc, got %+v", plan.Outputs)
		}
	}
	for _, o := range plan.Outputs {
		if o.Account == testWalletF {
			t.Fatalf("buyer must be excluded, got %+v", plan.Outputs)
		}
	}
	if plan.TotalAtomic != "372000" {
		t.Fatalf("totalAtomic = %q, want 372000 (100*1220 + floor(0.05*5000000))", plan.TotalAtomic)
	}
	got := planAmounts(t, plan)
	sum := big.NewInt(0)
	for _, v := range got {
		sum.Add(sum, v)
	}
	if sum.String() != plan.TotalAtomic {
		t.Fatalf("outputs sum = %q, totalAtomic = %q", sum, plan.TotalAtomic)
	}
	if got[testWalletA].Cmp(got[testWalletB]) <= 0 ||
		got[testWalletA].Cmp(got[testWalletC]) <= 0 ||
		got[testWalletA].Cmp(got[testWalletD]) <= 0 {
		t.Fatalf("most-skewed agent A must get most, got %+v", plan.Outputs)
	}
	if plan.RoundId != "7" {
		t.Fatalf("roundId = %q, want 7", plan.RoundId)
	}
	if plan.HeadroomMB != 896 || plan.HeadroomCUMicro != 200000 {
		t.Fatalf("headroom = %dMB %dCUMicro, want 896MB 200000CUMicro", plan.HeadroomMB, plan.HeadroomCUMicro)
	}
	if len(plan.Nonce) != 64 {
		t.Fatalf("nonce = %q, want 32 bytes hex", plan.Nonce)
	}
	if _, ok := new(big.Int).SetString(plan.Nonce, 16); !ok {
		t.Fatalf("nonce = %q, want hex", plan.Nonce)
	}
}

func Test_X402_fill_plan_small_slice_gets_more(t *testing.T) {
	f := settledV2Fixture(t, 7)
	allocate(t, f, testWalletA, 0.25, 1000)
	allocate(t, f, testWalletB, 0.1, 400)
	stub := f.srv.verifier.(*stubVerifier)
	stub.committed[testWalletA] = big.NewInt(2500000)
	stub.committed[testWalletB] = big.NewInt(2500000)

	code, plan := postFillPlan(t, f, testWalletF, 0.05, 100)
	if code != http.StatusOK {
		t.Fatalf("fill-plan: status=%d", code)
	}
	if len(plan.Outputs) != 2 {
		t.Fatalf("want 2 outputs, got %+v", plan.Outputs)
	}
	got := planAmounts(t, plan)
	if got[testWalletB].Cmp(got[testWalletA]) <= 0 {
		t.Fatalf("equal locks on unequal slices: small-slice B must beat A, got %+v", plan.Outputs)
	}
}

func Test_X402_fill_plan_dust_exact(t *testing.T) {
	f := fillPlanFixture(t)
	stub := f.srv.verifier.(*stubVerifier)
	stub.committed[testWalletA] = big.NewInt(3000000)

	code, plan := postFillPlan(t, f, testWalletF, 0.05, 101)
	if code != http.StatusOK {
		t.Fatalf("fill-plan: status=%d", code)
	}
	if plan.TotalAtomic != "373220" {
		t.Fatalf("totalAtomic = %q, want 373220", plan.TotalAtomic)
	}
	got := planAmounts(t, plan)
	sum := big.NewInt(0)
	for _, v := range got {
		sum.Add(sum, v)
	}
	if sum.String() != plan.TotalAtomic {
		t.Fatalf("outputs sum = %q, totalAtomic = %q: must match exactly", sum, plan.TotalAtomic)
	}
	if got[testWalletC].String() != "75335" {
		t.Fatalf("first wallet-asc output C = %q, want 75335 (floor 75334 + 1 dust unit)", got[testWalletC])
	}
	if got[testWalletD].String() != "75334" || got[testWalletB].String() != "75334" {
		t.Fatalf("dust must go wallet-asc first, got %+v", plan.Outputs)
	}
}

func Test_X402_fill_plan_buyer_agent_excluded(t *testing.T) {
	f := fillPlanFixture(t)

	code, plan := postFillPlan(t, f, testWalletA, 0.05, 100)
	if code != http.StatusOK {
		t.Fatalf("fill-plan: status=%d", code)
	}
	if len(plan.Outputs) != 3 {
		t.Fatalf("want 3 outputs with buyer excluded, got %+v", plan.Outputs)
	}
	for _, o := range plan.Outputs {
		if o.Account == testWalletA {
			t.Fatalf("buyer-agent must be excluded, got %+v", plan.Outputs)
		}
	}
	got := planAmounts(t, plan)
	sum := big.NewInt(0)
	for _, v := range got {
		sum.Add(sum, v)
	}
	if sum.String() != plan.TotalAtomic {
		t.Fatalf("outputs sum = %q, totalAtomic = %q", sum, plan.TotalAtomic)
	}
}

func Test_X402_fill_plan_insufficient_spare(t *testing.T) {
	f := fillPlanFixture(t)
	if code, _ := postFillPlan(t, f, testWalletF, 0.5, 99999); code != http.StatusConflict {
		t.Fatalf("oversized want: status=%d, want 409", code)
	}
	rec := doRequest(f, http.MethodPost, "/fill-plan", fmt.Sprintf(`{"wallet":%q,"cu":0.5,"mem":99999}`, testWalletF))
	if got := codeOf(t, rec.Body.Bytes()); got != "insufficient_spare" {
		t.Fatalf("code = %q, want insufficient_spare", got)
	}
}

func Test_X402_fill_plan_validation(t *testing.T) {
	f := fillPlanFixture(t)
	bodies := []string{
		fmt.Sprintf(`{"wallet":%q,"cu":0,"mem":0}`, testWalletF),
		fmt.Sprintf(`{"wallet":%q,"cu":-0.1,"mem":100}`, testWalletF),
		fmt.Sprintf(`{"wallet":%q,"cu":0.1,"mem":-5}`, testWalletF),
		fmt.Sprintf(`{"wallet":%q,"cu":NaN,"mem":100}`, testWalletF),
		fmt.Sprintf(`{"wallet":%q,"cu":Inf,"mem":100}`, testWalletF),
		fmt.Sprintf(`{"wallet":"nope","cu":0.1,"mem":100}`),
		`{"wallet":` + testWalletF + `,"cu":0.1,"mem":100,"x":1}`,
	}
	for _, body := range bodies {
		rec := doRequest(f, http.MethodPost, "/fill-plan", body)
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("body %s: status=%d, want 400", body, rec.Code)
		}
		if got := codeOf(t, rec.Body.Bytes()); got != "bad_request" {
			t.Fatalf("body %s: code = %q, want bad_request", body, got)
		}
	}
}

func Test_X402_fill_plan_nonce_unique(t *testing.T) {
	f := fillPlanFixture(t)

	_, first := postFillPlan(t, f, testWalletF, 0.05, 100)
	_, second := postFillPlan(t, f, testWalletF, 0.05, 100)
	if first.Nonce == "" || second.Nonce == "" {
		t.Fatal("both plans must carry a nonce")
	}
	if first.Nonce == second.Nonce {
		t.Fatalf("nonces must differ, got %q twice", first.Nonce)
	}
}

func Test_X402_imputed_cost_time_spread(t *testing.T) {
	rateCU := big.NewInt(5_000_000)
	rateMB := big.NewInt(1220)
	fullBurn := domain.Usage{CUSeconds: 900, MBHours: 1000}
	got, err := imputedCost(fullBurn, rateMB, rateCU, 1)
	if err != nil {
		t.Fatalf("imputedCost: %v", err)
	}
	if want := big.NewInt(2_470_000); got.Cmp(want) != 0 {
		t.Fatalf("full-window burn imputed %s, want %s", got, want)
	}
	zero, err := imputedCost(domain.Usage{}, rateMB, rateCU, 1)
	if err != nil {
		t.Fatalf("imputedCost zero: %v", err)
	}
	if zero.Sign() != 0 {
		t.Fatalf("zero burn must impute zero, got %s", zero)
	}
}

func Test_X402_fill_plan_chain_down_fail_closed(t *testing.T) {
	f := fillPlanFixture(t)
	f.srv.verifier.(*stubVerifier).committedErr = errStubNodeDown

	rec := doRequest(f, http.MethodPost, "/fill-plan", fmt.Sprintf(`{"wallet":%q,"cu":0.05,"mem":100}`, testWalletF))
	if rec.Code == http.StatusOK {
		t.Fatalf("chain down must deny, got 200 body=%s", rec.Body.String())
	}
	if got := codeOf(t, rec.Body.Bytes()); got != "chain_unreadable" {
		t.Fatalf("code = %q, want chain_unreadable", got)
	}
}

func multilegBody(buyer string, sellers []string, mbs []int64, cus []float64, amounts []string, ids []string) string {
	var sb strings.Builder
	sb.WriteString(`{"to":` + fmt.Sprintf("%q", buyer) + `,"legs":[`)
	for i := range sellers {
		if i > 0 {
			sb.WriteString(",")
		}
		fmt.Fprintf(&sb, `{"seller":%q,"mb":%d,"cu":%v}`, sellers[i], mbs[i], cus[i])
	}
	sb.WriteString(`],"payments":[`)
	for i := range sellers {
		if i > 0 {
			sb.WriteString(",")
		}
		fmt.Fprintf(&sb, `{"seller":%q,"amountAtomic":%q,"settlementId":%q}`, sellers[i], amounts[i], ids[i])
	}
	sb.WriteString(`]}`)
	return sb.String()
}

func Test_X402_multileg_underpay(t *testing.T) {
	f := newFixture()
	allocate(t, f, testWalletA, 0.2, 800)
	allocate(t, f, testWalletB, 0.2, 800)

	body := multilegBody(testWalletF,
		[]string{testWalletA, testWalletB}, []int64{400, 400}, []float64{0.1, 0.1},
		[]string{"999999999999", "1"}, []string{"settle-aaa", "settle-bbb"})
	rec := doAppKey(f, http.MethodPost, "/transfer-quota", body)
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

	body := multilegBody(testWalletF,
		[]string{testWalletA, testWalletB}, []int64{400, 400}, []float64{0.1, 0.1},
		[]string{"999999999999", "999999999999"}, []string{"settle-aaa", "settle-bbb"})
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

	body := multilegBody(testWalletF,
		[]string{testWalletA, testWalletB}, []int64{400, 7999}, []float64{0.1, 0},
		[]string{"999999999999", "999999999999"}, []string{"settle-aaa", "settle-bbb"})
	rec := doAppKey(f, http.MethodPost, "/transfer-quota", body)
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

	body := multilegBody(testWalletF,
		[]string{testWalletA, testWalletB}, []int64{400, 400}, []float64{0.1, 0.1},
		[]string{"999999999999", "999999999999"}, []string{"settle-aaa", "settle-bbb"})

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

	body := multilegBody(testWalletF,
		[]string{testWalletA, testWalletB}, []int64{10, 10}, []float64{0.01, 0.01},
		[]string{"999999999999", "999999999999"}, []string{"settle-cap-1", "settle-cap-2"})
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

	body := multilegBody(testWalletF,
		[]string{testWalletA}, []int64{10}, []float64{0.01},
		[]string{"999999999999"}, []string{"opaque-id-no-verify"})
	rec := doAppKey(f, http.MethodPost, "/transfer-quota", body)
	if rec.Code != http.StatusOK {
		t.Fatalf("operator-attested commit: status=%d body=%s, want 200", rec.Code, rec.Body.String())
	}
	rec = doAppKey(f, http.MethodPost, "/transfer-quota", body)
	if rec.Code != http.StatusConflict {
		t.Fatalf("replay: status=%d body=%s, want 409", rec.Code, rec.Body.String())
	}
	if got := codeOf(t, rec.Body.Bytes()); got != "duplicate_payment" {
		t.Fatalf("code = %q, want duplicate_payment", got)
	}
}

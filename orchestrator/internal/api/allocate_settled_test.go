package api

import (
	"encoding/json"
	"math/big"
	"net/http"
	"testing"

	"github.com/Jashk120/Coalition/orchestrator/internal/settle"
)

const testV2PoolAddr = "0x8888888888888888888888888888888888888888"

// settledV2Fixture programs the stub chain for a settled v2 round and points
// the ledger at it. Callers settle the ledger explicitly after any
// pre-settle allocates.
func settledV2Fixture(t *testing.T, round int64) fixture {
	t.Helper()
	f := newFixture()
	f.srv.cfg.PoolV2Address = testV2PoolAddr
	stub := f.srv.verifier.(*stubVerifier)
	stub.roundId = big.NewInt(round)
	stub.roundViews = &settle.RoundViews{
		Target:           big.NewInt(10000000),
		TotalCommitted:   big.NewInt(10000000),
		Settled:          true,
		Expired:          false,
		ParticipantCount: big.NewInt(2),
		RoundId:          big.NewInt(round),
		Deadline:         big.NewInt(1799999999),
	}
	stub.committed = map[string]*big.Int{}
	f.led.SetCurrentRound(big.NewInt(round))
	return f
}

func allocateToken(t *testing.T, f fixture, wallet string, cpu float64, mem int64) string {
	t.Helper()
	body := `{"wallet":"` + wallet + `","cpu":` + floatStr(cpu) + `,"mem":` + intStr(mem) + `}`
	rec := doAppKey(f, http.MethodPost, "/allocate", body)
	if rec.Code != http.StatusCreated {
		t.Fatalf("allocate %s: status=%d body=%s", wallet, rec.Code, rec.Body.String())
	}
	var out struct {
		Token string `json:"token"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode: %v", err)
	}
	f.tok[wallet] = out.Token
	return out.Token
}

func Test_Allocate_post_settle_v2_chain_proof(t *testing.T) {
	f := settledV2Fixture(t, 7)
	allocate(t, f, testWalletA, 0.2, 800)
	f.led.MarkRoundSettled(big.NewInt(7))

	stub := f.srv.verifier.(*stubVerifier)
	stub.committed[testWalletB] = big.NewInt(2500000)

	tok := allocateToken(t, f, testWalletB, 0.2, 800)
	if tok == "" {
		t.Fatal("chain-proven participant must receive a token")
	}
	if got, err := f.led.WalletRound(mustWallet(t, testWalletB)); err != nil || got == nil || got.Cmp(big.NewInt(7)) != 0 {
		t.Fatalf("WalletRound = %v, %v; want 7", got, err)
	}
	if rec := doAuthed(f, http.MethodPost, "/run",
		`{"wallet":"`+testWalletB+`","cmd":["echo","hi"]}`, testWalletB); rec.Code != http.StatusOK {
		t.Fatalf("post-settle participant run: status=%d body=%s, want 200", rec.Code, rec.Body.String())
	}

	rec := doAppKey(f, http.MethodPost, "/allocate",
		`{"wallet":"`+testWalletC+`","cpu":0.2,"mem":800}`)
	if rec.Code != http.StatusConflict {
		t.Fatalf("unfunded wallet: status=%d body=%s, want 409", rec.Code, rec.Body.String())
	}
	if got := codeOf(t, rec.Body.Bytes()); got != "pool_settled" {
		t.Fatalf("code = %q, want pool_settled", got)
	}
}

func Test_Allocate_post_settle_fail_closed(t *testing.T) {
	newSettled := func(t *testing.T, mutate func(f fixture)) fixture {
		t.Helper()
		f := settledV2Fixture(t, 7)
		allocate(t, f, testWalletA, 0.2, 800)
		f.led.MarkRoundSettled(big.NewInt(7))
		if mutate != nil {
			mutate(f)
		}
		return f
	}
	newWalletBody := `{"wallet":"` + testWalletB + `","cpu":0.2,"mem":800}`
	cases := []struct {
		name   string
		mutate func(f fixture)
	}{
		{"node error", func(f fixture) {
			f.srv.verifier.(*stubVerifier).roundErr = errStubNodeDown
		}},
		{"chain round unsettled", func(f fixture) {
			stub := f.srv.verifier.(*stubVerifier)
			stub.roundViews.Settled = false
			stub.committed[testWalletB] = big.NewInt(2500000)
		}},
		{"no v2 pool configured", func(f fixture) {
			f.srv.cfg.PoolV2Address = ""
		}},
		{"zero stake", func(f fixture) {}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			f := newSettled(t, tc.mutate)
			if rec := doAppKey(f, http.MethodPost, "/allocate", newWalletBody); rec.Code != http.StatusConflict {
				t.Fatalf("status=%d body=%s, want 409", rec.Code, rec.Body.String())
			} else if got := codeOf(t, rec.Body.Bytes()); got != "pool_settled" {
				t.Fatalf("code = %q, want pool_settled", got)
			}
		})
	}

	t.Run("pre-settle reservation needs no chain", func(t *testing.T) {
		f := newSettled(t, func(f fixture) {
			f.srv.verifier.(*stubVerifier).roundErr = errStubNodeDown
		})
		rec := doAppKey(f, http.MethodPost, "/allocate",
			`{"wallet":"`+testWalletA+`","cpu":0.2,"mem":800}`)
		if rec.Code != http.StatusCreated {
			t.Fatalf("re-allocate with node down: status=%d body=%s, want 201", rec.Code, rec.Body.String())
		}
	})
}

func Test_Allocate_post_settle_pool_exhausted_preserved(t *testing.T) {
	f := settledV2Fixture(t, 7)
	for _, w := range []string{testWalletA, testWalletB, testWalletC, testWalletD, testWalletE} {
		allocate(t, f, w, 0.2, 819)
	}
	f.led.MarkRoundSettled(big.NewInt(7))
	stub := f.srv.verifier.(*stubVerifier)
	stub.committed[testWalletF] = big.NewInt(2500000)

	rec := doAppKey(f, http.MethodPost, "/allocate",
		`{"wallet":"`+testWalletF+`","cpu":0.1,"mem":100}`)
	if rec.Code != http.StatusConflict {
		t.Fatalf("status=%d body=%s, want 409", rec.Code, rec.Body.String())
	}
	if got := codeOf(t, rec.Body.Bytes()); got != "pool_exhausted" {
		t.Fatalf("code = %q, want pool_exhausted", got)
	}
}

package api

import (
	"encoding/json"
	"net/http"
	"testing"
)

// allocate -> free-pool -> wallet gone: the operator reset kills the
// container, removes the ledger record, and revokes the token, so the same
// pool is immediately re-testable.
func Test_FreePool_allocate_free_gone(t *testing.T) {
	f := newFixture()
	cidA := allocate(t, f, testWalletA, 0.2, 800)
	cidB := allocate(t, f, testWalletB, 0.2, 800)
	tokA := f.tok[testWalletA]

	rec := doAppKey(f, http.MethodPost, "/free-pool", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("free-pool: status=%d body=%s", rec.Code, rec.Body.String())
	}
	var out struct {
		Freed   int      `json:"freed"`
		RoundID string   `json:"roundId"`
		Failed  []string `json:"failed"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if out.Freed != 2 {
		t.Fatalf("freed=%d, want 2 (body=%s)", out.Freed, rec.Body.String())
	}
	if len(out.Failed) != 0 {
		t.Fatalf("failed=%v, want none", out.Failed)
	}
	if !f.be.Killed(cidA) || !f.be.Killed(cidB) {
		t.Fatal("both backend containers must be killed")
	}
	if f.led.HasWallet(mustWallet(t, testWalletA)) || f.led.HasWallet(mustWallet(t, testWalletB)) {
		t.Fatal("wallet records must be gone after free-pool")
	}
	// Old bearer token is revoked: no record left, so auth is 401.
	rec = doRequestWith(f, http.MethodPost, "/run",
		`{"wallet":"`+testWalletA+`","cmd":["echo","hi"]}`,
		map[string]string{"Authorization": "Bearer " + tokA})
	if rec.Code != http.StatusNotFound && rec.Code != http.StatusUnauthorized {
		t.Fatalf("run with freed token: status=%d body=%s, want 401 or 404", rec.Code, rec.Body.String())
	}
	// Pool capacity is back: the same wallets can allocate again.
	allocate(t, f, testWalletA, 0.2, 800)
}

// free-pool is operator tier: agent Bearer tokens must not call it, and a
// missing app key is 401.
func Test_FreePool_requires_app_key(t *testing.T) {
	f := newFixture()
	allocate(t, f, testWalletA, 0.2, 800)

	rec := doRequest(f, http.MethodPost, "/free-pool", "")
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("no key: status=%d body=%s, want 401", rec.Code, rec.Body.String())
	}
	rec = doAuthed(f, http.MethodPost, "/free-pool", "", testWalletA)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("bearer token: status=%d body=%s, want 401", rec.Code, rec.Body.String())
	}
	rec = doRequestWith(f, http.MethodPost, "/free-pool", "", map[string]string{appKeyHeader: "wrong-key"})
	if rec.Code != http.StatusForbidden {
		t.Fatalf("wrong key: status=%d body=%s, want 403", rec.Code, rec.Body.String())
	}
	if !f.led.HasWallet(mustWallet(t, testWalletA)) {
		t.Fatal("rejected reset must not free anything")
	}
}

// roundId scopes the reset: a non-matching round frees nothing.
func Test_FreePool_round_filter(t *testing.T) {
	f := newFixture()
	allocate(t, f, testWalletA, 0.2, 800)

	rec := doAppKey(f, http.MethodPost, "/free-pool", `{"roundId":"999"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("free-pool: status=%d body=%s", rec.Code, rec.Body.String())
	}
	var out struct {
		Freed   int    `json:"freed"`
		RoundID string `json:"roundId"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if out.Freed != 0 || out.RoundID != "999" {
		t.Fatalf("out=%+v, want {freed:0 roundId:999}", out)
	}
	if !f.led.HasWallet(mustWallet(t, testWalletA)) {
		t.Fatal("non-matching round filter must keep the wallet")
	}
}

// killAll overrides a round filter and frees everything.
func Test_FreePool_kill_all_overrides_filter(t *testing.T) {
	f := newFixture()
	allocate(t, f, testWalletA, 0.2, 800)

	rec := doAppKey(f, http.MethodPost, "/free-pool", `{"roundId":"999","killAll":true}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("free-pool: status=%d body=%s", rec.Code, rec.Body.String())
	}
	var out struct {
		Freed int `json:"freed"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if out.Freed != 1 {
		t.Fatalf("freed=%d, want 1", out.Freed)
	}
}

// DELETE /free-wallet frees one wallet: container killed, record gone, and
// the pool slot is reusable. Unknown wallets are 404.
func Test_FreeWallet_single(t *testing.T) {
	f := newFixture()
	cid := allocate(t, f, testWalletA, 0.2, 800)
	allocate(t, f, testWalletB, 0.2, 800)

	rec := doAuthed(f, http.MethodDelete, "/free-wallet", `{"wallet":"`+testWalletA+`"}`, testWalletA)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("bearer token: status=%d body=%s, want 401", rec.Code, rec.Body.String())
	}
	rec = doAppKey(f, http.MethodDelete, "/free-wallet", `{"wallet":"`+testWalletA+`"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("free-wallet: status=%d body=%s", rec.Code, rec.Body.String())
	}
	var out struct {
		Freed  int    `json:"freed"`
		Wallet string `json:"wallet"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if out.Freed != 1 {
		t.Fatalf("freed=%d, want 1", out.Freed)
	}
	if !f.be.Killed(cid) {
		t.Fatal("freed wallet's container must be killed")
	}
	if f.led.HasWallet(mustWallet(t, testWalletA)) {
		t.Fatal("freed wallet record must be gone")
	}
	if !f.led.HasWallet(mustWallet(t, testWalletB)) {
		t.Fatal("untargeted wallet must survive a single free")
	}

	rec = doAppKey(f, http.MethodDelete, "/free-wallet", `{"wallet":"`+testUnknown+`"}`)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("unknown wallet: status=%d body=%s, want 404", rec.Code, rec.Body.String())
	}
}

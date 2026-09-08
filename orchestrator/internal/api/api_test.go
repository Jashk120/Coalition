package api

import (
	"encoding/json"
	"io"
	"log/slog"
	"math/big"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"

	"github.com/Jashk120/Coalition/orchestrator/internal/backend"
	"github.com/Jashk120/Coalition/orchestrator/internal/config"
	"github.com/Jashk120/Coalition/orchestrator/internal/domain"
	"github.com/Jashk120/Coalition/orchestrator/internal/store"
)

const (
	testProvider = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266"
	testWalletA  = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8"
	testWalletB  = "0x90f79bf6eb2c4f870365e785982e1f101e93b906"
	testUnknown  = "0x000000000000000000000000000000000000dEaD"
)

type fixture struct {
	srv *Server
	be  *backend.MemoryBackend
	led *store.Store
	tok map[string]string
}

func newFixture() fixture {
	provider, err := domain.NewWalletAddress(testProvider)
	if err != nil {
		panic(err)
	}
	cfg := config.Config{
		ResourceName:    "Test Pool",
		CPUTotal:        1,
		MemMB:           4096,
		MaxAgents:       5,
		TargetUSDC:      "10.00",
		TargetAtomic:    big.NewInt(10000000),
		WindowHours:     72,
		ProviderAddress: provider,
		Port:            "8080",
		RPCURL:          "https://rpc.testnet.arc.io",
		Confirmations:   1,
		ReaperInterval:  1000000000,
		RateLimitRPS:    10000,
		RateLimitBurst:  10000,
	}
	be := backend.NewMemoryBackend()
	led := store.NewStore(cfg.WindowHours)
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	s, err := NewServer(cfg, led, be, logger)
	if err != nil {
		panic(err)
	}
	s.SetVerifier(newStubVerifier())
	return fixture{srv: s, be: be, led: led, tok: make(map[string]string)}
}

func doRequest(f fixture, method, target, body string) *httptest.ResponseRecorder {
	return doRequestWith(f, method, target, body, nil)
}

func doRequestWith(f fixture, method, target, body string, headers map[string]string) *httptest.ResponseRecorder {
	var rdr io.Reader
	if body != "" {
		rdr = strings.NewReader(body)
	}
	req := httptest.NewRequest(method, target, rdr)
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	rec := httptest.NewRecorder()
	f.srv.Handler().ServeHTTP(rec, req)
	return rec
}

// doAuthed attaches the fixture's stored bearer token for wallet.
func doAuthed(f fixture, method, target, body, wallet string) *httptest.ResponseRecorder {
	return doRequestWith(f, method, target, body, map[string]string{
		"Authorization": "Bearer " + f.tok[wallet],
	})
}

func mustWallet(t *testing.T, s string) domain.WalletAddress {
	t.Helper()
	w, err := domain.NewWalletAddress(s)
	if err != nil {
		t.Fatalf("wallet: %v", err)
	}
	return w
}

func allocate(t *testing.T, f fixture, wallet string, cpu float64, mem int64) string {
	t.Helper()
	body := `{"wallet":"` + wallet + `","cpu":` + floatStr(cpu) + `,"mem":` + intStr(mem) + `}`
	var rec *httptest.ResponseRecorder
	if tok := f.tok[wallet]; tok != "" {
		rec = doRequestWith(f, http.MethodPost, "/allocate", body, map[string]string{
			"Authorization": "Bearer " + tok,
		})
	} else {
		rec = doRequest(f, http.MethodPost, "/allocate", body)
	}
	if rec.Code != http.StatusCreated {
		t.Fatalf("allocate: status=%d body=%s", rec.Code, rec.Body.String())
	}
	var out struct {
		Wallet      string `json:"wallet"`
		ContainerID string `json:"containerId"`
		Token       string `json:"token"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if out.ContainerID == "" {
		t.Fatal("empty container id")
	}
	if out.Token == "" {
		t.Fatal("allocate must return an opaque bearer token")
	}
	f.tok[wallet] = out.Token
	return out.ContainerID
}

func floatStr(f float64) string { return strconv.FormatFloat(f, 'f', -1, 64) }

func intStr(i int64) string { return strconv.FormatInt(i, 10) }

func Test_Allocate_validation(t *testing.T) {
	tests := []struct {
		name   string
		body   string
		status int
	}{
		{"malformed json", `{"wallet":`, 400},
		{"bad wallet", `{"wallet":"nope","cpu":0.2,"mem":800}`, 400},
		{"zero cpu", `{"wallet":"` + testWalletA + `","cpu":0,"mem":800}`, 400},
		{"zero mem", `{"wallet":"` + testWalletA + `","cpu":0.2,"mem":0}`, 400},
		{"exceeds pool cpu", `{"wallet":"` + testWalletA + `","cpu":2,"mem":800}`, 409},
		{"exceeds pool mem", `{"wallet":"` + testWalletA + `","cpu":0.2,"mem":99999}`, 409},
		{"unknown field", `{"wallet":"` + testWalletA + `","cpu":0.2,"mem":800,"x":1}`, 400},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			f := newFixture()
			rec := doRequest(f, http.MethodPost, "/allocate", tt.body)
			if rec.Code != tt.status {
				t.Fatalf("status=%d body=%s, want %d", rec.Code, rec.Body.String(), tt.status)
			}
		})
	}
}

func Test_Allocate_idempotent_update(t *testing.T) {
	f := newFixture()
	first := allocate(t, f, testWalletA, 0.2, 800)
	second := allocate(t, f, testWalletA, 0.5, 1000)
	if first == second {
		t.Fatal("re-allocate should mint a new container")
	}
	ent, err := f.led.Entitlement(mustWallet(t, testWalletA))
	if err != nil {
		t.Fatalf("entitlement: %v", err)
	}
	if ent.CPU != 0.5 || ent.MemMB != 1000 {
		t.Fatalf("limits not updated: %+v", ent)
	}
}

func Test_Run_happy_and_errors(t *testing.T) {
	f := newFixture()
	allocate(t, f, testWalletA, 0.2, 800)
	rec := doAuthed(f, http.MethodPost, "/run",
		`{"wallet":"`+testWalletA+`","cmd":["echo","hi"]}`, testWalletA)
	if rec.Code != http.StatusOK {
		t.Fatalf("run: status=%d body=%s", rec.Code, rec.Body.String())
	}
	var out struct {
		Stdout   string `json:"stdout"`
		ExitCode int    `json:"exitCode"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if out.ExitCode != 0 || !strings.Contains(out.Stdout, "echo hi") {
		t.Fatalf("unexpected result: %+v", out)
	}

	errs := []struct {
		name   string
		method string
		target string
		body   string
		status int
		wallet string
	}{
		{"unknown wallet", http.MethodPost, "/run", `{"wallet":"` + testUnknown + `","cmd":["x"]}`, 404, ""},
		{"bad wallet", http.MethodPost, "/run", `{"wallet":"zz","cmd":["x"]}`, 400, ""},
		{"empty cmd", http.MethodPost, "/run", `{"wallet":"` + testWalletA + `","cmd":[]}`, 400, testWalletA},
		{"malformed", http.MethodPost, "/run", `{"wallet":`, 400, ""},
		{"missing token", http.MethodPost, "/run", `{"wallet":"` + testWalletA + `","cmd":["x"]}`, 401, "none"},
	}
	for _, tt := range errs {
		t.Run(tt.name, func(t *testing.T) {
			var rec *httptest.ResponseRecorder
			switch tt.wallet {
			case "":
				rec = doRequest(f, tt.method, tt.target, tt.body)
			case "none":
				rec = doRequestWith(f, tt.method, tt.target, tt.body, nil)
			default:
				rec = doAuthed(f, tt.method, tt.target, tt.body, tt.wallet)
			}
			if rec.Code != tt.status {
				t.Fatalf("status=%d body=%s, want %d", rec.Code, rec.Body.String(), tt.status)
			}
		})
	}
}

func Test_Run_quota_exceeded_kills(t *testing.T) {
	f := newFixture()
	id := allocate(t, f, testWalletA, 0.2, 800)
	w := mustWallet(t, testWalletA)
	if err := f.led.AddUsage(w, 0.2*72*3600+10, 0); err != nil {
		t.Fatalf("usage: %v", err)
	}
	rec := doAuthed(f, http.MethodPost, "/run",
		`{"wallet":"`+testWalletA+`","cmd":["echo","hi"]}`, testWalletA)
	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("status=%d body=%s, want 429", rec.Code, rec.Body.String())
	}
	var errBody struct {
		Code string `json:"code"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &errBody); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if errBody.Code != "quota_exceeded" {
		t.Fatalf("code = %q", errBody.Code)
	}
	if !f.be.Killed(id) {
		t.Fatal("over-quota container must be killed")
	}
}

func Test_Quote(t *testing.T) {
	f := newFixture()
	allocate(t, f, testWalletA, 0.2, 800)
	rec := doRequest(f, http.MethodGet, "/quote?seller="+testWalletA, "")
	if rec.Code != http.StatusOK {
		t.Fatalf("quote: status=%d body=%s", rec.Code, rec.Body.String())
	}
	var q struct {
		Seller             string `json:"seller"`
		PayTo              string `json:"payTo"`
		RatePerMBAtomic    string `json:"ratePerMBAtomic"`
		RatePerCUAtomic    string `json:"ratePerCUAtomic"`
		AvailableMB        string `json:"availableMB"`
		AvailableCU        string `json:"availableCU"`
		AvailableMBHours   string `json:"availableMBHours"`
		AvailableCUSeconds string `json:"availableCUSeconds"`
		TermsURI           string `json:"termsURI"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &q); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if q.Seller != testWalletA || q.PayTo != testWalletA {
		t.Fatalf("seller/payTo = %q/%q", q.Seller, q.PayTo)
	}
	if q.RatePerMBAtomic != "1220" {
		t.Fatalf("ratePerMBAtomic = %q", q.RatePerMBAtomic)
	}
	if q.RatePerCUAtomic != "5000000" {
		t.Fatalf("ratePerCUAtomic = %q", q.RatePerCUAtomic)
	}
	if q.AvailableMB == "" || q.AvailableMB == "0" {
		t.Fatalf("availableMB = %q", q.AvailableMB)
	}
	if q.AvailableCU == "" || q.AvailableCU == "0" {
		t.Fatalf("availableCU = %q", q.AvailableCU)
	}
	if q.AvailableMB != "800" {
		t.Fatalf("availableMB = %q, want slice-unit remainder 800", q.AvailableMB)
	}
	if q.AvailableCU != "200000" {
		t.Fatalf("availableCU = %q, want slice-unit remainder 200000 micro-CU", q.AvailableCU)
	}
	if q.AvailableMBHours != "57600" {
		t.Fatalf("availableMBHours = %q, want 57600", q.AvailableMBHours)
	}
	if q.AvailableCUSeconds != "51840" {
		t.Fatalf("availableCUSeconds = %q, want 51840", q.AvailableCUSeconds)
	}
	if !strings.HasSuffix(q.TermsURI, "/terms.json") {
		t.Fatalf("termsURI = %q", q.TermsURI)
	}

	for _, tc := range []struct {
		name   string
		target string
		status int
	}{
		{"missing seller", "/quote", 400},
		{"bad hex", "/quote?seller=zzz", 400},
		{"unknown seller", "/quote?seller=" + testUnknown, 404},
	} {
		t.Run(tc.name, func(t *testing.T) {
			rec := doRequest(f, http.MethodGet, tc.target, "")
			if rec.Code != tc.status {
				t.Fatalf("status=%d body=%s, want %d", rec.Code, rec.Body.String(), tc.status)
			}
		})
	}
}

func Test_Transfer(t *testing.T) {
	f := newFixture()
	allocate(t, f, testWalletA, 0.2, 800)
	rec := doAuthed(f, http.MethodPost, "/transfer-quota",
		`{"from":"`+testWalletA+`","to":"`+testWalletB+`","mb":400,"cu":0.1,"txHash":"`+stubTxHash+`"}`, testWalletA)
	if rec.Code != http.StatusOK {
		t.Fatalf("transfer: status=%d body=%s", rec.Code, rec.Body.String())
	}
	var out struct {
		From struct {
			MemMB int64 `json:"memMB"`
		} `json:"from"`
		To struct {
			MemMB int64 `json:"memMB"`
		} `json:"to"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if out.From.MemMB != 400 || out.To.MemMB != 400 {
		t.Fatalf("split wrong: %+v", out)
	}

	for _, tc := range []struct {
		name   string
		body   string
		status int
		auth   string
	}{
		{"insufficient", `{"from":"` + testWalletA + `","to":"` + testWalletB + `","mb":99999,"cu":0,"txHash":"` + stubTxHash + `"}`, 409, testWalletA},
		{"unknown sender", `{"from":"` + testUnknown + `","to":"` + testWalletB + `","mb":1,"cu":0,"txHash":"` + stubTxHash + `"}`, 401, ""},
		{"bad wallet", `{"from":"xx","to":"` + testWalletB + `","mb":1,"cu":0,"txHash":"` + stubTxHash + `"}`, 400, ""},
		{"malformed", `{"from":`, 400, ""},
		{"missing txHash", `{"from":"` + testWalletA + `","to":"` + testWalletB + `","mb":1,"cu":0}`, 400, testWalletA},
		{"missing token", `{"from":"` + testWalletA + `","to":"` + testWalletB + `","mb":1,"cu":0,"txHash":"` + stubTxHash + `"}`, 401, "none"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var rec *httptest.ResponseRecorder
			switch tc.auth {
			case "":
				rec = doRequest(f, http.MethodPost, "/transfer-quota", tc.body)
			case "none":
				rec = doRequestWith(f, http.MethodPost, "/transfer-quota", tc.body, nil)
			default:
				rec = doAuthed(f, http.MethodPost, "/transfer-quota", tc.body, tc.auth)
			}
			if rec.Code != tc.status {
				t.Fatalf("status=%d body=%s, want %d", rec.Code, rec.Body.String(), tc.status)
			}
		})
	}
}

func Test_Terms_live_from_config(t *testing.T) {
	f := newFixture()
	rec := doRequest(f, http.MethodGet, "/terms.json", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("terms: status=%d", rec.Code)
	}
	var doc struct {
		Name     string `json:"name"`
		Resource struct {
			Provider string `json:"provider"`
			CPU      string `json:"cpu"`
		} `json:"resource"`
		Funding struct {
			TargetUSDC   string `json:"targetUSDC"`
			TargetAtomic string `json:"targetAtomic"`
		} `json:"funding"`
		Resale struct {
			Permitted bool `json:"permitted"`
		} `json:"resale"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &doc); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if !strings.Contains(doc.Name, "Test Pool") {
		t.Fatalf("name should track config, got %q", doc.Name)
	}
	if doc.Resource.Provider != testProvider {
		t.Fatalf("provider = %q", doc.Resource.Provider)
	}
	if doc.Funding.TargetAtomic != "10000000" || doc.Funding.TargetUSDC != "10.00" {
		t.Fatalf("funding = %+v", doc.Funding)
	}
	if !doc.Resale.Permitted {
		t.Fatal("resale must be permitted")
	}
}

func Test_Health(t *testing.T) {
	f := newFixture()
	rec := doRequest(f, http.MethodGet, "/healthz", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("health: status=%d", rec.Code)
	}
}

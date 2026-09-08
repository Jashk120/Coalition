package api

import (
	"bytes"
	"log/slog"
	"net/http"
	"strings"
	"testing"
)

// newOpenFixture clones the standard fixture but with operator auth disabled,
// mirroring ALLOW_NO_APP_AUTH=1. Same package, so private fields are fair game.
func newOpenFixture(t *testing.T) fixture {
	t.Helper()
	f := newFixture()
	f.srv.cfg.AllowNoAppAuth = true
	f.srv.cfg.AppAPIKey = ""
	f.srv.appAuthOpen = true
	f.srv.appKeyHash = [32]byte{}
	return f
}

func Test_Tiers_public_routes_need_no_credentials(t *testing.T) {
	f := newFixture()
	allocate(t, f, testWalletA, 0.2, 800)
	tests := []struct {
		name   string
		method string
		target string
	}{
		{"healthz", http.MethodGet, "/healthz"},
		{"terms", http.MethodGet, "/terms.json"},
		{"quote", http.MethodGet, "/quote?seller=" + testWalletA},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if rec := doRequest(f, tt.method, tt.target, ""); rec.Code != http.StatusOK {
				t.Fatalf("%s %s: status=%d body=%s, want 200 with no credentials",
					tt.method, tt.target, rec.Code, rec.Body.String())
			}
		})
	}
}

func Test_Tiers_allocate_needs_app_key(t *testing.T) {
	body := `{"wallet":"` + testWalletB + `","cpu":0.1,"mem":100}`
	t.Run("missing key is 401", func(t *testing.T) {
		f := newFixture()
		rec := doRequest(f, http.MethodPost, "/allocate", body)
		if rec.Code != http.StatusUnauthorized {
			t.Fatalf("status=%d body=%s, want 401", rec.Code, rec.Body.String())
		}
		if got := codeOf(t, rec.Body.Bytes()); got != "unauthorized" {
			t.Fatalf("code = %q, want unauthorized", got)
		}
	})
	t.Run("wrong key is 403", func(t *testing.T) {
		f := newFixture()
		rec := doRequestWith(f, http.MethodPost, "/allocate", body,
			map[string]string{appKeyHeader: "wrong-key-0123456789abcdef"})
		if rec.Code != http.StatusForbidden {
			t.Fatalf("status=%d body=%s, want 403", rec.Code, rec.Body.String())
		}
		if got := codeOf(t, rec.Body.Bytes()); got != "forbidden" {
			t.Fatalf("code = %q, want forbidden", got)
		}
	})
	t.Run("correct key is 201", func(t *testing.T) {
		f := newFixture()
		rec := doAppKey(f, http.MethodPost, "/allocate", body)
		if rec.Code != http.StatusCreated {
			t.Fatalf("status=%d body=%s, want 201", rec.Code, rec.Body.String())
		}
	})
}

func Test_Tiers_are_independent_not_stacked(t *testing.T) {
	f := newFixture()
	allocate(t, f, testWalletA, 0.2, 800)
	runBody := `{"wallet":"` + testWalletA + `","cmd":["echo","hi"]}`
	t.Run("agent token alone runs", func(t *testing.T) {
		rec := doAuthed(f, http.MethodPost, "/run", runBody, testWalletA)
		if rec.Code != http.StatusOK {
			t.Fatalf("status=%d body=%s, want 200", rec.Code, rec.Body.String())
		}
	})
	t.Run("app key alone does not run", func(t *testing.T) {
		rec := doAppKey(f, http.MethodPost, "/run", runBody)
		if rec.Code != http.StatusUnauthorized {
			t.Fatalf("status=%d body=%s, want 401", rec.Code, rec.Body.String())
		}
	})
	t.Run("app key plus bad agent token does not run", func(t *testing.T) {
		rec := doRequestWith(f, http.MethodPost, "/run", runBody, map[string]string{
			appKeyHeader:    testAppKey,
			"Authorization": "Bearer deadbeef",
		})
		if rec.Code != http.StatusUnauthorized {
			t.Fatalf("status=%d body=%s, want 401", rec.Code, rec.Body.String())
		}
	})
	t.Run("transfer needs agent token not app key", func(t *testing.T) {
		rec := doAppKey(f, http.MethodPost, "/transfer-quota",
			`{"from":"`+testWalletA+`","to":"`+testWalletB+`","mb":10,"cu":0.01,"txHash":"`+stubTxHash+`"}`)
		if rec.Code != http.StatusUnauthorized {
			t.Fatalf("status=%d body=%s, want 401", rec.Code, rec.Body.String())
		}
		rec = doAuthed(f, http.MethodPost, "/transfer-quota",
			`{"from":"`+testWalletA+`","to":"`+testWalletB+`","mb":10,"cu":0.01,"txHash":"`+stubTxHash+`"}`, testWalletA)
		if rec.Code != http.StatusOK {
			t.Fatalf("status=%d body=%s, want 200", rec.Code, rec.Body.String())
		}
	})
}

func Test_Tiers_allow_no_app_auth_dev_path(t *testing.T) {
	f := newOpenFixture(t)
	rec := doRequest(f, http.MethodPost, "/allocate",
		`{"wallet":"`+testWalletA+`","cpu":0.2,"mem":800}`)
	if rec.Code != http.StatusCreated {
		t.Fatalf("open dev server: status=%d body=%s, want 201", rec.Code, rec.Body.String())
	}
}

func Test_Tiers_no_key_material_in_logs(t *testing.T) {
	for _, tc := range []struct {
		name    string
		headers map[string]string
	}{
		{"missing key 401", nil},
		{"wrong key 403", map[string]string{appKeyHeader: "attacker-key-0123456789abcdef"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newFixture()
			var buf bytes.Buffer
			f.srv.logger = slog.New(slog.NewTextHandler(&buf, nil))
			rec := doRequestWith(f, http.MethodPost, "/allocate",
				`{"wallet":"`+testWalletA+`","cpu":0.2,"mem":800}`, tc.headers)
			if rec.Code != http.StatusUnauthorized && rec.Code != http.StatusForbidden {
				t.Fatalf("status=%d, want 401/403", rec.Code)
			}
			if out := buf.String(); strings.Contains(out, testAppKey) ||
				strings.Contains(out, "attacker-key-0123456789abcdef") {
				t.Fatalf("log output leaks key material: %q", out)
			}
		})
	}
}

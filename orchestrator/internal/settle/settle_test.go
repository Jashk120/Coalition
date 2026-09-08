package settle

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"math/big"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Jashk120/Coalition/orchestrator/internal/store"
)

const testPool = "0x1111111111111111111111111111111111111111"

func discardLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

func decodeBody(r *http.Request, v any) error {
	defer func() {
		_ = r.Body.Close()
	}()
	return json.NewDecoder(r.Body).Decode(v)
}

// rpcStub serves canned eth_blockNumber / eth_getLogs replies. logsFn is
// consulted on every eth_getLogs call so tests can flip responses mid-run.
func rpcStub(t *testing.T, logsFn func() string) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Method string `json:"method"`
		}
		if err := decodeBody(r, &req); err != nil {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		switch req.Method {
		case "eth_blockNumber":
			_, _ = w.Write([]byte(`{"jsonrpc":"2.0","id":1,"result":"0x10"}`))
		case "eth_getLogs":
			_, _ = w.Write([]byte(`{"jsonrpc":"2.0","id":1,"result":` + logsFn() + `}`))
		default:
			w.WriteHeader(http.StatusBadRequest)
		}
	}))
	t.Cleanup(srv.Close)
	return srv
}

func Test_Listener_Check_marks_settled_on_match(t *testing.T) {
	var calls atomic.Int32
	srv := rpcStub(t, func() string {
		if calls.Add(1) == 1 {
			return `[{"blockNumber":"0x10","topics":["` + settledSelector + `"]}]`
		}
		return `[]`
	})
	ledger := store.NewStore(72)
	l := NewListener(srv.URL, testPool, time.Millisecond, ledger, discardLogger())

	first, err := l.Check(context.Background())
	if err != nil {
		t.Fatalf("first Check: %v", err)
	}
	if !first {
		t.Fatal("first Check should report the transition")
	}
	if !ledger.IsSettled() {
		t.Fatal("ledger should be settled after match")
	}

	first, err = l.Check(context.Background())
	if err != nil {
		t.Fatalf("second Check: %v", err)
	}
	if first {
		t.Fatal("second Check must not report a new transition")
	}
	if !ledger.IsSettled() {
		t.Fatal("ledger should stay settled")
	}
}

func Test_Listener_Check_empty_logs(t *testing.T) {
	srv := rpcStub(t, func() string { return `[]` })
	ledger := store.NewStore(72)
	l := NewListener(srv.URL, testPool, time.Millisecond, ledger, discardLogger())

	first, err := l.Check(context.Background())
	if err != nil {
		t.Fatalf("Check: %v", err)
	}
	if first {
		t.Fatal("empty logs must not report a transition")
	}
	if ledger.IsSettled() {
		t.Fatal("ledger must stay unsettled")
	}
}

func Test_Listener_Check_malformed_body(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`not json`))
	}))
	t.Cleanup(srv.Close)
	ledger := store.NewStore(72)
	l := NewListener(srv.URL, testPool, time.Millisecond, ledger, discardLogger())

	if _, err := l.Check(context.Background()); err == nil {
		t.Fatal("malformed body must error")
	}
	if ledger.IsSettled() {
		t.Fatal("ledger must stay unsettled on malformed body")
	}
}

func Test_Listener_Check_rpc_error_object(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"jsonrpc":"2.0","id":1,"error":{"code":-32000,"message":"unavailable"}}`))
	}))
	t.Cleanup(srv.Close)
	ledger := store.NewStore(72)
	l := NewListener(srv.URL, testPool, time.Millisecond, ledger, discardLogger())

	_, err := l.Check(context.Background())
	if err == nil {
		t.Fatal("rpc error object must error")
	}
	if !errors.Is(err, errRPC) {
		t.Fatalf("error should wrap errRPC, got %v", err)
	}
}

func Test_Listener_Run_settles_then_stops_cleanly(t *testing.T) {
	srv := rpcStub(t, func() string {
		return `[{"blockNumber":"0x10","topics":["` + settledSelector + `"]}]`
	})
	ledger := store.NewStore(72)
	l := NewListener(srv.URL, testPool, 5*time.Millisecond, ledger, discardLogger())

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err := l.Run(ctx); err != nil {
		t.Fatalf("Run: %v", err)
	}
	if !ledger.IsSettled() {
		t.Fatal("ledger should be settled after Run with matching logs")
	}
}

func Test_Listener_Run_cancel_before_match(t *testing.T) {
	srv := rpcStub(t, func() string { return `[]` })
	ledger := store.NewStore(72)
	l := NewListener(srv.URL, testPool, 5*time.Millisecond, ledger, discardLogger())

	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	if err := l.Run(ctx); err != nil {
		t.Fatalf("Run: %v", err)
	}
	if ledger.IsSettled() {
		t.Fatal("ledger must stay unsettled with empty logs")
	}
}

func Test_EqualSplit(t *testing.T) {
	tests := []struct {
		name    string
		cpu     float64
		mb      int64
		n       int
		wantCPU float64
		wantMB  int64
		wantErr bool
	}{
		{"reference economics", 1, 4096, 5, 0.2, 819, false},
		{"single participant", 1, 4096, 1, 1, 4096, false},
		{"zero participants", 1, 4096, 0, 0, 0, true},
		{"zero cpu", 0, 4096, 5, 0, 0, true},
		{"zero mem", 1, 0, 5, 0, 0, true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := EqualSplit(tt.cpu, tt.mb, tt.n)
			if tt.wantErr {
				if err == nil {
					t.Fatal("expected error")
				}
				if !errors.Is(err, errParticipants) {
					t.Fatalf("error should wrap errParticipants, got %v", err)
				}
				return
			}
			if err != nil {
				t.Fatalf("EqualSplit: %v", err)
			}
			if len(got) != tt.n {
				t.Fatalf("got %d shares, want %d", len(got), tt.n)
			}
			for _, s := range got {
				if s.CPU != tt.wantCPU || s.MemMB != tt.wantMB {
					t.Fatalf("got %+v, want cpu=%v mb=%d", s, tt.wantCPU, tt.wantMB)
				}
			}
		})
	}
}

// verifyingStub serves blockNumber/getLogs/eth_call so Check can prove the
// commitment gate: committedHex is the totalCommitted() answer.
func verifyingStub(t *testing.T, committedHex string) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Method string `json:"method"`
		}
		if err := decodeBody(r, &req); err != nil {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		switch req.Method {
		case "eth_blockNumber":
			_, _ = w.Write([]byte(`{"jsonrpc":"2.0","id":1,"result":"0x10"}`))
		case "eth_getLogs":
			_, _ = w.Write([]byte(`{"jsonrpc":"2.0","id":1,"result":[{"blockNumber":"0x10","topics":["` + settledSelector + `"]}]}`))
		case "eth_call":
			_, _ = w.Write([]byte(`{"jsonrpc":"2.0","id":1,"result":"` + committedHex + `"}`))
		default:
			w.WriteHeader(http.StatusBadRequest)
		}
	}))
	t.Cleanup(srv.Close)
	return srv
}

func Test_Listener_Check_verifies_commitment(t *testing.T) {
	target := big.NewInt(10000000)
	t.Run("sufficient total flips", func(t *testing.T) {
		srv := verifyingStub(t, "0x989680")
		ledger := store.NewStore(72)
		l := NewListener(srv.URL, testPool, time.Millisecond, ledger, discardLogger(),
			WithCommitmentTarget(target), WithConfirmations(1))
		first, err := l.Check(context.Background())
		if err != nil {
			t.Fatalf("Check: %v", err)
		}
		if !first || !ledger.IsSettled() {
			t.Fatal("sufficient commitment must flip the ledger")
		}
	})
	t.Run("insufficient total skips flip", func(t *testing.T) {
		srv := verifyingStub(t, "0x1")
		ledger := store.NewStore(72)
		l := NewListener(srv.URL, testPool, time.Millisecond, ledger, discardLogger(),
			WithCommitmentTarget(target), WithConfirmations(1))
		first, err := l.Check(context.Background())
		if err != nil {
			t.Fatalf("Check: %v", err)
		}
		if first || ledger.IsSettled() {
			t.Fatal("insufficient commitment must not flip the ledger")
		}
	})
	t.Run("unconfirmed log waits", func(t *testing.T) {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			var req struct {
				Method string `json:"method"`
			}
			if err := decodeBody(r, &req); err != nil {
				w.WriteHeader(http.StatusBadRequest)
				return
			}
			w.Header().Set("Content-Type", "application/json")
			switch req.Method {
			case "eth_blockNumber":
				_, _ = w.Write([]byte(`{"jsonrpc":"2.0","id":1,"result":"0x10"}`))
			case "eth_getLogs":
				_, _ = w.Write([]byte(`{"jsonrpc":"2.0","id":1,"result":[{"blockNumber":"0x10","topics":["` + settledSelector + `"]}]}`))
			default:
				w.WriteHeader(http.StatusBadRequest)
			}
		}))
		t.Cleanup(srv.Close)
		ledger := store.NewStore(72)
		l := NewListener(srv.URL, testPool, time.Millisecond, ledger, discardLogger(),
			WithConfirmations(2))
		first, err := l.Check(context.Background())
		if err != nil {
			t.Fatalf("Check: %v", err)
		}
		if first || ledger.IsSettled() {
			t.Fatal("depth-1 log with CONFIRMATIONS=2 must not flip yet")
		}
	})
}

func Test_Listener_boots_from_latest(t *testing.T) {
	srv := rpcStub(t, func() string { return `[]` })
	ledger := store.NewStore(72)
	l := NewListener(srv.URL, testPool, time.Millisecond, ledger, discardLogger())
	if got := l.lastChecked(); got != "latest" {
		t.Fatalf("cursor = %q, want latest (no genesis rescan)", got)
	}
}

// mutableChain is a scriptable chain stub: head, logs, and committed move
// under test control between Check calls.
type mutableChain struct {
	head      string
	logs      string
	committed string
}

func (m *mutableChain) serve(t *testing.T) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Method string `json:"method"`
		}
		if err := decodeBody(r, &req); err != nil {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		switch req.Method {
		case "eth_blockNumber":
			_, _ = w.Write([]byte(`{"jsonrpc":"2.0","id":1,"result":"` + m.head + `"}`))
		case "eth_getLogs":
			_, _ = w.Write([]byte(`{"jsonrpc":"2.0","id":1,"result":` + m.logs + `}`))
		case "eth_call":
			_, _ = w.Write([]byte(`{"jsonrpc":"2.0","id":1,"result":"` + m.committed + `"}`))
		default:
			w.WriteHeader(http.StatusBadRequest)
		}
	}))
	t.Cleanup(srv.Close)
	return srv
}

func settledLogAt(block string) string {
	return `[{"blockNumber":"` + block + `","topics":["` + settledSelector + `"]}]`
}

func Test_Listener_cursor_pins_and_chain_gate_flips(t *testing.T) {
	target := big.NewInt(10000000)
	chain := &mutableChain{head: "0x10", logs: settledLogAt("0x10"), committed: "0x1"}
	srv := chain.serve(t)
	ledger := store.NewStore(72)
	l := NewListener(srv.URL, testPool, time.Millisecond, ledger, discardLogger(),
		WithCommitmentTarget(target), WithConfirmations(1))

	if flipped, err := l.Check(context.Background()); err != nil || flipped {
		t.Fatalf("below-target round: flipped=%v err=%v, want no flip", flipped, err)
	}
	if ledger.IsSettled() {
		t.Fatal("below-target log must not flip the ledger")
	}
	if got := l.lastChecked(); got != "0x10" {
		t.Fatalf("cursor = %q, want pin at first unverifiable log 0x10", got)
	}

	chain.logs = `[]`
	chain.committed = "0x989680"
	if flipped, err := l.Check(context.Background()); err != nil || !flipped {
		t.Fatalf("top-up round: flipped=%v err=%v, want flip with no new log", flipped, err)
	}
	if !ledger.IsSettled() {
		t.Fatal("chain-state top-up must flip the ledger without a new event")
	}
}

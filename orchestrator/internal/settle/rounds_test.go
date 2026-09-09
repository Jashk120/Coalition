package settle

import (
	"context"
	"encoding/json"
	"fmt"
	"math/big"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/Jashk120/Coalition/orchestrator/internal/store"
)

const testV2Pool = "0x2222222222222222222222222222222222222222"

// roundRig is a scriptable v2 chain stub: head, current round, per-round
// tuple/expired/participant answers, and the v2 log set move under test
// control between Check calls.
type roundRig struct {
	head         string
	currentRound string
	tuples       map[string]string
	expired      map[string]string
	participants map[string]string
	logs         string
}

func uintHex(v int64) string { return fmt.Sprintf("%064x", v) }

func roundTuple(target, deadline, committed, settled int64) string {
	return "0x" + uintHex(target) + uintHex(deadline) + uintHex(5) +
		uintHex(committed) + uintHex(0) + uintHex(settled) + uintHex(0) +
		uintHex(0) + uintHex(0) + uintHex(0) + uintHex(0) + uintHex(0) + uintHex(0)
}

func roundStartedLogAt(block string, round int64) string {
	return `{"blockNumber":"` + block + `","topics":["` + roundStartedSelector + `","0x` + uintHex(round) + `"],"data":"0x"}`
}

func settledV2LogAt(block string, round int64) string {
	return `{"blockNumber":"` + block + `","topics":["` + settledV2Selector + `","0x` + uintHex(round) + `"],"data":"0x"}`
}

func (m *roundRig) roundOf(data string) string {
	d := strings.ToLower(data)
	switch {
	case strings.HasPrefix(d, roundsSelector),
		strings.HasPrefix(d, expiredAtSelector),
		strings.HasPrefix(d, participantCountAtSelector):
		if len(d) >= 64 {
			return d[len(d)-64:]
		}
	}
	return ""
}

func (m *roundRig) serve(t *testing.T) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Method string          `json:"method"`
			Params json.RawMessage `json:"params"`
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
			var params []json.RawMessage
			if err := json.Unmarshal(req.Params, &params); err != nil || len(params) == 0 {
				w.WriteHeader(http.StatusBadRequest)
				return
			}
			var call struct {
				Data string `json:"data"`
			}
			if err := json.Unmarshal(params[0], &call); err != nil {
				w.WriteHeader(http.StatusBadRequest)
				return
			}
			d := strings.ToLower(call.Data)
			var answer string
			switch {
			case strings.HasPrefix(d, currentRoundIdSelector):
				answer = m.currentRound
			case strings.HasPrefix(d, roundsSelector):
				answer = m.tuples[m.roundOf(d)]
			case strings.HasPrefix(d, expiredAtSelector):
				answer = m.expired[m.roundOf(d)]
			case strings.HasPrefix(d, participantCountAtSelector):
				answer = m.participants[m.roundOf(d)]
			default:
				w.WriteHeader(http.StatusBadRequest)
				return
			}
			if answer == "" {
				w.WriteHeader(http.StatusBadRequest)
				return
			}
			_, _ = w.Write([]byte(`{"jsonrpc":"2.0","id":1,"result":"` + answer + `"}`))
		default:
			w.WriteHeader(http.StatusBadRequest)
		}
	}))
	t.Cleanup(srv.Close)
	return srv
}

func newV2Listener(srv *httptest.Server, ledger *store.Store) *Listener {
	return NewListener(srv.URL, "", time.Millisecond, ledger, discardLogger(),
		WithV2Pool(testV2Pool), WithConfirmations(1))
}

func Test_Rounds_RoundStarted_advances_current_round(t *testing.T) {
	rig := &roundRig{
		head:         "0x20",
		currentRound: "0x2",
		tuples: map[string]string{
			uintHex(2): roundTuple(10000000, 9999999999, 1, 0),
		},
		expired:      map[string]string{uintHex(2): "0x0"},
		participants: map[string]string{uintHex(2): "0x0"},
		logs:         `[` + roundStartedLogAt("0x20", 2) + `]`,
	}
	srv := rig.serve(t)
	ledger := store.NewStore(72)
	l := newV2Listener(srv, ledger)

	flipped, err := l.Check(context.Background())
	if err != nil {
		t.Fatalf("Check: %v", err)
	}
	if flipped {
		t.Fatal("unfunded round must not flip")
	}
	if got := ledger.CurrentRound(); got == nil || got.Cmp(big.NewInt(2)) != 0 {
		t.Fatalf("CurrentRound = %v, want 2", got)
	}
	if tracked := l.trackedV2Round(); tracked == nil || tracked.Cmp(big.NewInt(2)) != 0 {
		t.Fatalf("tracked = %v, want 2", tracked)
	}
	if ledger.IsRoundSettled(big.NewInt(2)) {
		t.Fatal("unfunded round must stay unsettled")
	}
}

func Test_Rounds_cursors_are_per_round(t *testing.T) {
	rig := &roundRig{
		head:         "0x10",
		currentRound: "0x1",
		tuples: map[string]string{
			uintHex(1): roundTuple(10000000, 9999999999, 1, 0),
		},
		expired:      map[string]string{uintHex(1): "0x0"},
		participants: map[string]string{uintHex(1): "0x0"},
		logs:         `[]`,
	}
	srv := rig.serve(t)
	ledger := store.NewStore(72)
	l := newV2Listener(srv, ledger)

	if _, err := l.Check(context.Background()); err != nil {
		t.Fatalf("round 1 Check: %v", err)
	}
	if got := l.roundCursorOf(big.NewInt(1)); got != "0x10" {
		t.Fatalf("round 1 cursor = %q, want 0x10", got)
	}

	rig.head = "0x20"
	rig.currentRound = "0x2"
	rig.tuples[uintHex(2)] = roundTuple(5000000, 9999999999, 1, 0)
	rig.expired[uintHex(2)] = "0x0"
	rig.participants[uintHex(2)] = "0x0"
	if _, err := l.Check(context.Background()); err != nil {
		t.Fatalf("round 2 Check: %v", err)
	}
	if got := ledger.CurrentRound(); got == nil || got.Cmp(big.NewInt(2)) != 0 {
		t.Fatalf("CurrentRound = %v, want 2", got)
	}
	if got := l.roundCursorOf(big.NewInt(2)); got != "0x20" {
		t.Fatalf("round 2 cursor = %q, want restart at 0x20", got)
	}
	if got := l.roundCursorOf(big.NewInt(1)); got != "0x10" {
		t.Fatalf("round 1 cursor = %q, want preserved 0x10", got)
	}
}

func Test_Rounds_Settled_flips_only_tracked_round(t *testing.T) {
	rig := &roundRig{
		head:         "0x20",
		currentRound: "0x2",
		tuples: map[string]string{
			uintHex(2): roundTuple(10000000, 9999999999, 10000000, 1),
		},
		expired:      map[string]string{uintHex(2): "0x0"},
		participants: map[string]string{uintHex(2): "0x3"},
		logs:         `[` + settledV2LogAt("0x20", 2) + `]`,
	}
	srv := rig.serve(t)
	ledger := store.NewStore(72)
	if !ledger.MarkRoundSettled(big.NewInt(1)) {
		t.Fatal("setup: round 1 must flip")
	}
	l := newV2Listener(srv, ledger)

	flipped, err := l.Check(context.Background())
	if err != nil {
		t.Fatalf("Check: %v", err)
	}
	if !flipped {
		t.Fatal("funded round must flip")
	}
	if !ledger.IsRoundSettled(big.NewInt(2)) {
		t.Fatal("round 2 must be settled")
	}
	if !ledger.IsRoundSettled(big.NewInt(1)) {
		t.Fatal("round 1 must stay settled")
	}
	if ledger.IsRoundSettled(big.NewInt(3)) {
		t.Fatal("unobserved round 3 must stay unsettled")
	}
	if ledger.IsSettled() {
		t.Fatal("v2 settle must not flip the legacy v1 flag")
	}

	flipped, err = l.Check(context.Background())
	if err != nil {
		t.Fatalf("second Check: %v", err)
	}
	if flipped {
		t.Fatal("second Check must not report a new transition")
	}
}

func Test_Rounds_chain_gate_flips_without_event(t *testing.T) {
	rig := &roundRig{
		head:         "0x20",
		currentRound: "0x1",
		tuples: map[string]string{
			uintHex(1): roundTuple(10000000, 9999999999, 10000000, 1),
		},
		expired:      map[string]string{uintHex(1): "0x0"},
		participants: map[string]string{uintHex(1): "0x2"},
		logs:         `[]`,
	}
	srv := rig.serve(t)
	ledger := store.NewStore(72)
	l := newV2Listener(srv, ledger)

	flipped, err := l.Check(context.Background())
	if err != nil {
		t.Fatalf("Check: %v", err)
	}
	if !flipped || !ledger.IsRoundSettled(big.NewInt(1)) {
		t.Fatal("funded round must flip from chain state alone (inline settle emits no new log)")
	}
}

func Test_Rounds_cursor_pins_on_below_target_settled(t *testing.T) {
	rig := &roundRig{
		head:         "0x20",
		currentRound: "0x1",
		tuples: map[string]string{
			uintHex(1): roundTuple(10000000, 9999999999, 1, 0),
		},
		expired:      map[string]string{uintHex(1): "0x0"},
		participants: map[string]string{uintHex(1): "0x1"},
		logs:         `[` + settledV2LogAt("0x10", 1) + `]`,
	}
	srv := rig.serve(t)
	ledger := store.NewStore(72)
	l := newV2Listener(srv, ledger)

	flipped, err := l.Check(context.Background())
	if err != nil {
		t.Fatalf("Check: %v", err)
	}
	if flipped || ledger.IsRoundSettled(big.NewInt(1)) {
		t.Fatal("below-target Settled log must not flip the round")
	}
	if got := l.roundCursorOf(big.NewInt(1)); got != "0x10" {
		t.Fatalf("round cursor = %q, want pin at unverifiable log 0x10", got)
	}

	rig.logs = `[]`
	rig.tuples[uintHex(1)] = roundTuple(10000000, 9999999999, 10000000, 1)
	flipped, err = l.Check(context.Background())
	if err != nil {
		t.Fatalf("top-up Check: %v", err)
	}
	if !flipped || !ledger.IsRoundSettled(big.NewInt(1)) {
		t.Fatal("chain-state top-up must flip the round without a new event")
	}
}

func Test_Rounds_foreign_settled_log_ignored(t *testing.T) {
	rig := &roundRig{
		head:         "0x20",
		currentRound: "0x2",
		tuples: map[string]string{
			uintHex(2): roundTuple(10000000, 9999999999, 1, 0),
		},
		expired:      map[string]string{uintHex(2): "0x0"},
		participants: map[string]string{uintHex(2): "0x0"},
		logs:         `[` + settledV2LogAt("0x20", 9) + `]`,
	}
	srv := rig.serve(t)
	ledger := store.NewStore(72)
	l := newV2Listener(srv, ledger)

	flipped, err := l.Check(context.Background())
	if err != nil {
		t.Fatalf("Check: %v", err)
	}
	if flipped {
		t.Fatal("Settled log for a foreign round must not flip the tracked round")
	}
	if ledger.IsRoundSettled(big.NewInt(2)) || ledger.IsRoundSettled(big.NewInt(9)) {
		t.Fatal("no round may flip on a foreign log")
	}
}

func Test_Rounds_legacy_v1_flow_coexists(t *testing.T) {
	srv := rpcStub(t, func() string {
		return `[{"blockNumber":"0x10","topics":["` + settledSelector + `"]}]`
	})
	ledger := store.NewStore(72)
	l := NewListener(srv.URL, testPool, time.Millisecond, ledger, discardLogger(),
		WithV2Pool(testV2Pool))

	flipped, err := l.Check(context.Background())
	if err == nil {
		t.Fatal("v2 views against a v1-only stub must error (fail loud, Run warns)")
	}
	if !flipped {
		t.Fatal("legacy transition still reports even as the v2 leg fails")
	}
	if !ledger.IsSettled() {
		t.Fatal("legacy v1 Settled log must still flip the global flag first")
	}
}

func Test_ReadRoundViews_mirrors_sdk_round_state(t *testing.T) {
	rig := &roundRig{
		head:         "0x20",
		currentRound: "0x4",
		tuples: map[string]string{
			uintHex(4): roundTuple(10000000, 1719999999, 10000000, 1),
		},
		expired:      map[string]string{uintHex(4): "0x1"},
		participants: map[string]string{uintHex(4): "0x5"},
		logs:         `[]`,
	}
	srv := rig.serve(t)
	c := NewClient(srv.URL)

	views, err := c.ReadRoundViews(context.Background(), testV2Pool, big.NewInt(4))
	if err != nil {
		t.Fatalf("ReadRoundViews: %v", err)
	}
	if views.Target.Cmp(big.NewInt(10000000)) != 0 {
		t.Fatalf("target = %s", views.Target)
	}
	if views.TotalCommitted.Cmp(big.NewInt(10000000)) != 0 {
		t.Fatalf("totalCommitted = %s", views.TotalCommitted)
	}
	if !views.Settled {
		t.Fatal("settled must be true")
	}
	if !views.Expired {
		t.Fatal("expired must be true")
	}
	if views.ParticipantCount.Cmp(big.NewInt(5)) != 0 {
		t.Fatalf("participantCount = %s", views.ParticipantCount)
	}
	if views.RoundId.Cmp(big.NewInt(4)) != 0 {
		t.Fatalf("roundId = %s", views.RoundId)
	}
	if views.Deadline.Cmp(big.NewInt(1719999999)) != 0 {
		t.Fatalf("deadline = %s", views.Deadline)
	}

	id, err := c.CurrentRoundId(context.Background(), testV2Pool, "latest")
	if err != nil {
		t.Fatalf("CurrentRoundId: %v", err)
	}
	if id.Cmp(big.NewInt(4)) != 0 {
		t.Fatalf("currentRoundId = %s, want 4", id)
	}
}

func Test_ReadRoundViews_rejects_bad_round(t *testing.T) {
	rig := &roundRig{head: "0x20", currentRound: "0x1"}
	srv := rig.serve(t)
	c := NewClient(srv.URL)

	if _, err := c.ReadRoundViews(context.Background(), testV2Pool, nil); err == nil {
		t.Fatal("nil round must error")
	}
	if _, err := c.ReadRoundViews(context.Background(), testV2Pool, big.NewInt(-1)); err == nil {
		t.Fatal("negative round must error")
	}
}

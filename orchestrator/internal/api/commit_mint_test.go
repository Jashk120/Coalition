package api

import (
	"encoding/json"
	"fmt"
	"math/big"
	"net/http"
	"strings"
	"testing"

	"github.com/Jashk120/Coalition/orchestrator/internal/settle"
)

const commitMintTx = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
const commitMintNonce = "abababababababababababababababababababababababababababababababab"

var commitMintAgents = []string{testWalletC, testWalletD, testWalletA, testWalletB}

func commitMintBody(to string, mb int64, cuMicro int64, tx, nonce, round string, accts []string, amounts []string) string {
	var sb strings.Builder
	fmt.Fprintf(&sb, `{"to":%q,"mb":%d,"cuMicro":%d,"settlementTxHash":%q,"nonce":%q,"roundId":%q,"outputs":[`, to, mb, cuMicro, tx, nonce, round)
	for i := range accts {
		if i > 0 {
			sb.WriteString(",")
		}
		fmt.Fprintf(&sb, `{"account":%q,"amountAtomic":%q}`, accts[i], amounts[i])
	}
	sb.WriteString(`]}`)
	return sb.String()
}

func commitMintReceipt(from string, accts []string, amounts []int64) *settle.Receipt {
	logs := make([]settle.ReceiptLog, 0, len(accts))
	for i, acct := range accts {
		logs = append(logs, settle.ReceiptLog{
			Address: "0x3600000000000000000000000000000000000000",
			Topics:  []string{commitMintTransferSig, padTopic(from), padTopic(acct)},
			Data:    fmt.Sprintf("0x%064x", amounts[i]),
		})
	}
	return &settle.Receipt{
		From:        from,
		To:          "0xcA11bde05977b3631167028862bE2a173976CA11",
		Value:       big.NewInt(0),
		BlockNumber: big.NewInt(0x20),
		Status:      "0x1",
		TxHash:      commitMintTx,
		Logs:        logs,
	}
}

func commitMintHappyBody() string {
	return commitMintBody(testWalletF, 100, 50000, commitMintTx, commitMintNonce, "7",
		commitMintAgents, []string{"93000", "93000", "93000", "93000"})
}

func Test_CommitMint_happy(t *testing.T) {
	f := fillPlanFixture(t)
	stub := f.srv.verifier.(*stubVerifier)
	stub.receipts[commitMintTx] = commitMintReceipt(testWalletF, commitMintAgents, []int64{93000, 93000, 93000, 93000})

	rec := doAppKey(f, http.MethodPost, "/commit-mint", commitMintHappyBody())
	if rec.Code != http.StatusOK {
		t.Fatalf("commit-mint: status=%d body=%s, want 200", rec.Code, rec.Body.String())
	}
	var out struct {
		To struct {
			Wallet string  `json:"wallet"`
			CPU    float64 `json:"cpu"`
			MemMB  int64   `json:"memMB"`
		} `json:"to"`
		ToToken string `json:"toToken"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if out.To.Wallet != testWalletF || out.To.MemMB != 100 || out.To.CPU != 0.05 {
		t.Fatalf("buyer slice = %+v, want F/0.05/100", out.To)
	}
	if out.ToToken == "" {
		t.Fatal("commit-mint must return the buyer token")
	}
}

func Test_CommitMint_tampered_amounts(t *testing.T) {
	f := fillPlanFixture(t)
	stub := f.srv.verifier.(*stubVerifier)
	stub.receipts[commitMintTx] = commitMintReceipt(testWalletF, commitMintAgents, []int64{93000, 93000, 93000, 93000})

	bad := commitMintBody(testWalletF, 100, 50000, commitMintTx, commitMintNonce, "7",
		commitMintAgents, []string{"93000", "93000", "93000", "92999"})
	rec := doAppKey(f, http.MethodPost, "/commit-mint", bad)
	if rec.Code != http.StatusPaymentRequired {
		t.Fatalf("tampered: status=%d body=%s, want 402", rec.Code, rec.Body.String())
	}
	if got := codeOf(t, rec.Body.Bytes()); got != "payment_required" {
		t.Fatalf("code = %q, want payment_required", got)
	}
	if f.led.HasWallet(mustWallet(t, testWalletF)) {
		t.Fatal("failed commit must not create buyer")
	}
	rec = doAppKey(f, http.MethodPost, "/commit-mint", commitMintHappyBody())
	if rec.Code != http.StatusOK {
		t.Fatalf("retry with exact amounts: status=%d body=%s, want 200", rec.Code, rec.Body.String())
	}
}

func Test_CommitMint_replay(t *testing.T) {
	f := fillPlanFixture(t)
	stub := f.srv.verifier.(*stubVerifier)
	stub.receipts[commitMintTx] = commitMintReceipt(testWalletF, commitMintAgents, []int64{93000, 93000, 93000, 93000})

	if rec := doAppKey(f, http.MethodPost, "/commit-mint", commitMintHappyBody()); rec.Code != http.StatusOK {
		t.Fatalf("first commit: status=%d body=%s", rec.Code, rec.Body.String())
	}
	rec := doAppKey(f, http.MethodPost, "/commit-mint", commitMintHappyBody())
	if rec.Code != http.StatusConflict {
		t.Fatalf("replay: status=%d body=%s, want 409", rec.Code, rec.Body.String())
	}
	if got := codeOf(t, rec.Body.Bytes()); got != "duplicate_payment" {
		t.Fatalf("code = %q, want duplicate_payment", got)
	}
}

func Test_CommitMint_wrong_sender(t *testing.T) {
	f := fillPlanFixture(t)
	stub := f.srv.verifier.(*stubVerifier)
	stub.receipts[commitMintTx] = commitMintReceipt(testWalletE, commitMintAgents, []int64{93000, 93000, 93000, 93000})

	rec := doAppKey(f, http.MethodPost, "/commit-mint", commitMintHappyBody())
	if rec.Code != http.StatusPaymentRequired {
		t.Fatalf("wrong sender: status=%d body=%s, want 402", rec.Code, rec.Body.String())
	}
	if got := codeOf(t, rec.Body.Bytes()); got != "payment_required" {
		t.Fatalf("code = %q, want payment_required", got)
	}
	if f.led.HasWallet(mustWallet(t, testWalletF)) {
		t.Fatal("failed commit must not create buyer")
	}
}

func Test_CommitMint_direct_transfer_rejected(t *testing.T) {
	f := fillPlanFixture(t)
	stub := f.srv.verifier.(*stubVerifier)
	r := commitMintReceipt(testWalletF, commitMintAgents, []int64{93000, 93000, 93000, 93000})
	r.To = "0x3600000000000000000000000000000000000000"
	stub.receipts[commitMintTx] = r

	rec := doAppKey(f, http.MethodPost, "/commit-mint", commitMintHappyBody())
	if rec.Code != http.StatusPaymentRequired {
		t.Fatalf("direct transfer: status=%d body=%s, want 402", rec.Code, rec.Body.String())
	}
	if f.led.HasWallet(mustWallet(t, testWalletF)) {
		t.Fatal("failed commit must not create buyer")
	}
}

func Test_CommitMint_auth_tier(t *testing.T) {
	f := fillPlanFixture(t)

	rec := doRequest(f, http.MethodPost, "/commit-mint", commitMintHappyBody())
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("no key: status=%d body=%s, want 401", rec.Code, rec.Body.String())
	}
	rec = doRequestWith(f, http.MethodPost, "/commit-mint", commitMintHappyBody(), map[string]string{
		appKeyHeader: "wrong-key-0123456789abcdef",
	})
	if rec.Code != http.StatusForbidden {
		t.Fatalf("wrong key: status=%d body=%s, want 403", rec.Code, rec.Body.String())
	}
}

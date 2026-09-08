package api

import (
	"context"
	"math/big"
	"strings"

	"github.com/Jashk120/Coalition/orchestrator/internal/settle"
)

const stubTxHash = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

// stubVerifier is a programmable receiptVerifier fake: receipts keyed by hash,
// head fixed for confirmation math, pool views programmable. calls counts
// every RPC read so tests can assert invalid requests never touch the chain.
type stubVerifier struct {
	receipts map[string]*settle.Receipt
	head     *big.Int
	views    *settle.PoolViews
	err      error
	calls    int
}

func newStubVerifier() *stubVerifier {
	return &stubVerifier{
		receipts: map[string]*settle.Receipt{
			stubTxHash: {
				From:        testWalletB,
				To:          testWalletA,
				Value:       maxUint256(),
				BlockNumber: big.NewInt(0x20),
				Status:      "0x1",
				TxHash:      stubTxHash,
			},
		},
		head:  big.NewInt(0x20),
		views: &settle.PoolViews{Settled: false, Expired: false, TotalCommitted: big.NewInt(0)},
	}
}

func maxUint256() *big.Int {
	v := new(big.Int).Sub(new(big.Int).Lsh(big.NewInt(1), 256), big.NewInt(1))
	return v
}

func (s *stubVerifier) BlockNumber(_ context.Context) (*big.Int, error) {
	s.calls++
	if s.err != nil {
		return nil, s.err
	}
	return new(big.Int).Set(s.head), nil
}

func (s *stubVerifier) TransactionReceipt(_ context.Context, txHash string) (*settle.Receipt, error) {
	s.calls++
	if s.err != nil {
		return nil, s.err
	}
	if r, ok := s.receipts[strings.ToLower(txHash)]; ok {
		return r, nil
	}
	for k, r := range s.receipts {
		if strings.EqualFold(k, txHash) {
			return r, nil
		}
	}
	return nil, settle.ErrNoReceipt
}

func (s *stubVerifier) ReadPoolViews(_ context.Context, _ string) (*settle.PoolViews, error) {
	s.calls++
	if s.err != nil {
		return nil, s.err
	}
	out := *s.views
	out.TotalCommitted = new(big.Int).Set(s.views.TotalCommitted)
	return &out, nil
}

package api

import (
	"context"
	"errors"
	"math/big"
	"strings"

	"github.com/Jashk120/Coalition/orchestrator/internal/settle"
)

const stubTxHash = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

var errStubNodeDown = errors.New("stub: node down")

// stubVerifier is a programmable receiptVerifier fake: receipts keyed by hash,
// head fixed for confirmation math, pool views programmable. calls counts
// every RPC read so tests can assert invalid requests never touch the chain.
// The round fields drive the optional round surface (CurrentRoundId,
// ReadRoundViews, ReadCommitted): unset means the chain proof fails closed,
// mirroring an unreachable node.
type stubVerifier struct {
	receipts map[string]*settle.Receipt
	head     *big.Int
	views    *settle.PoolViews
	err      error
	calls    int

	roundId      *big.Int
	roundViews   *settle.RoundViews
	roundErr     error
	committed    map[string]*big.Int
	committedErr error
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

func (s *stubVerifier) CurrentRoundId(_ context.Context, _ string, _ string) (*big.Int, error) {
	s.calls++
	if s.err != nil {
		return nil, s.err
	}
	if s.roundErr != nil {
		return nil, s.roundErr
	}
	if s.roundId == nil {
		return nil, errors.New("stub: no round programmed")
	}
	return new(big.Int).Set(s.roundId), nil
}

func (s *stubVerifier) ReadRoundViews(_ context.Context, _ string, _ *big.Int) (*settle.RoundViews, error) {
	s.calls++
	if s.err != nil {
		return nil, s.err
	}
	if s.roundErr != nil {
		return nil, s.roundErr
	}
	if s.roundViews == nil {
		return nil, errors.New("stub: no round views programmed")
	}
	out := *s.roundViews
	return &out, nil
}

func (s *stubVerifier) ReadCommitted(_ context.Context, _ string, _ *big.Int, wallet string) (*big.Int, error) {
	s.calls++
	if s.err != nil {
		return nil, s.err
	}
	if s.committedErr != nil {
		return nil, s.committedErr
	}
	if v, ok := s.committed[strings.ToLower(wallet)]; ok {
		return new(big.Int).Set(v), nil
	}
	return big.NewInt(0), nil
}

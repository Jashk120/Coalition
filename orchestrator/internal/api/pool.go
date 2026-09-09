package api

import (
	"context"
	"log/slog"
	"math/big"
	"net/http"

	"github.com/Jashk120/Coalition/orchestrator/internal/settle"
)

// roundReader is the optional round-scoped RPC surface the pool gate needs
// for the v2 pool. The production *settle.Client implements it; verifiers
// that do not (e.g. legacy test fakes) keep the v1-only gate. Asserted at
// runtime so the receiptVerifier interface stays stable.
type roundReader interface {
	CurrentRoundId(ctx context.Context, pool, blockTag string) (*big.Int, error)
	ReadRoundViews(ctx context.Context, pool string, roundId *big.Int) (*settle.RoundViews, error)
}

// poolGate enforces pool awareness on the funding endpoints: when POOL_ADDRESS
// is set and the chain reports expired && !settled, the pool closed unfilled
// and /allocate, /quote, /transfer-quota are rejected with 409 pool_closed.
// When POOL_V2_ADDRESS is set the same rule applies to the CURRENT round's
// views: only the current round's expired-unfilled state closes funding.
// /run is deliberately ungated: existing allocations keep local continuity —
// no funds ever moved, so there is nothing to unwind, and killing running
// work on expiry would destroy value for free.
//
// Fail-open: an unreachable node (or an unset POOL_ADDRESS / POOL_V2_ADDRESS)
// skips the gate with a warning, never a denial. A down node must not brick
// local metering.
func (s *Server) poolGate(ctx context.Context) *APIError {
	if s.cfg.PoolAddress == "" {
		s.logger.Debug("pool gate skipped: POOL_ADDRESS empty")
	} else {
		views, err := s.verifier.ReadPoolViews(ctx, s.cfg.PoolAddress)
		if err != nil {
			s.logger.Warn("pool gate fail-open: node unreachable",
				slog.String("pool", s.cfg.PoolAddress),
				slog.Any("err", err))
		} else if views.Expired && !views.Settled {
			return poolClosed("pool expired unfilled: funding endpoints closed")
		}
	}
	if s.cfg.PoolV2Address == "" {
		s.logger.Debug("pool gate skipped: POOL_V2_ADDRESS empty")
		return nil
	}
	rr, ok := s.verifier.(roundReader)
	if !ok {
		s.logger.Debug("pool gate skipped: verifier has no round views")
		return nil
	}
	roundId, err := rr.CurrentRoundId(ctx, s.cfg.PoolV2Address, "latest")
	if err != nil {
		s.logger.Warn("pool gate fail-open: node unreachable",
			slog.String("pool", s.cfg.PoolV2Address),
			slog.Any("err", err))
		return nil
	}
	views, err := rr.ReadRoundViews(ctx, s.cfg.PoolV2Address, roundId)
	if err != nil {
		s.logger.Warn("pool gate fail-open: node unreachable",
			slog.String("pool", s.cfg.PoolV2Address),
			slog.String("round", roundId.String()),
			slog.Any("err", err))
		return nil
	}
	if views.Expired && !views.Settled {
		return poolClosed("pool round expired unfilled: funding endpoints closed")
	}
	return nil
}

func (s *Server) checkPoolGate(w http.ResponseWriter, r *http.Request) bool {
	if apiErr := s.poolGate(r.Context()); apiErr != nil {
		writeJSONError(w, s.logger, apiErr)
		return false
	}
	return true
}

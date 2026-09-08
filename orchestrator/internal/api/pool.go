package api

import (
	"context"
	"log/slog"
	"net/http"
)

// poolGate enforces pool awareness on the funding endpoints: when POOL_ADDRESS
// is set and the chain reports expired && !settled, the pool closed unfilled
// and /allocate, /quote, /transfer-quota are rejected with 409 pool_closed.
// /run is deliberately ungated: existing allocations keep local continuity —
// no funds ever moved, so there is nothing to unwind, and killing running
// work on expiry would destroy value for free.
//
// Fail-open: an unreachable node (or an unset POOL_ADDRESS) skips the gate
// with a warning, never a denial. A down node must not brick local metering.
func (s *Server) poolGate(ctx context.Context) *APIError {
	if s.cfg.PoolAddress == "" {
		s.logger.Debug("pool gate skipped: POOL_ADDRESS empty")
		return nil
	}
	views, err := s.verifier.ReadPoolViews(ctx, s.cfg.PoolAddress)
	if err != nil {
		s.logger.Warn("pool gate fail-open: node unreachable",
			slog.String("pool", s.cfg.PoolAddress),
			slog.Any("err", err))
		return nil
	}
	if views.Expired && !views.Settled {
		return poolClosed("pool expired unfilled: funding endpoints closed")
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

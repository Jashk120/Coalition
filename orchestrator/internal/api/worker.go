package api

import (
	"context"
	"log/slog"
	"sync"
	"sync/atomic"
	"time"

	"github.com/Jashk120/Coalition/orchestrator/internal/domain"
)

// workerBurn is one demo tick per container: ~5-10s of sha256 stream, short
// enough that a 30s tick never overlaps itself, long enough that 1s-polled
// in-flight bars visibly climb while it runs.
var workerBurn = []string{"sh", "-c", `for i in $(seq 1 80000); do echo -n "$i" | sha256sum >/dev/null; done; echo worked`}

// StartWorker launches the post-settle demo burn: every tick each live
// container execs a short load, metered exactly like /run, so agent usage
// climbs on its own once funding closes. Pre-settle it idles: the compute
// window starts at settlement, so burning before would bill a window that
// has not begun. Zero interval disables it. Stops on ctx cancel, never leaks.
func (s *Server) StartWorker(ctx context.Context) {
	if s.cfg.WorkerInterval <= 0 {
		return
	}
	go func() {
		ticker := time.NewTicker(s.cfg.WorkerInterval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				s.workOnce(ctx)
			}
		}
	}()
}

// workOnce burns once per live container and returns how many ran. Burns
// run in parallel so every agent's bar climbs in the same tick; the
// reserve-pattern metering keeps concurrent execs from jointly overspending
// undetected. Factored out so tests drive it directly instead of sleeping
// for a tick.
func (s *Server) workOnce(ctx context.Context) int {
	if !s.ledger.FundingClosed() {
		return 0
	}
	var ran atomic.Int64
	var wg sync.WaitGroup
	for _, b := range s.ledger.ListContainers() {
		if b.ContainerID == "" {
			continue
		}
		wg.Add(1)
		go func() {
			defer wg.Done()
			if s.workWallet(ctx, b.Wallet, b.ContainerID) {
				ran.Add(1)
			}
		}()
	}
	wg.Wait()
	return int(ran.Load())
}

// workWallet runs one metered burn for a wallet: budget-checked reserve,
// container exec, actuals billing — the same seam as handleRun minus auth,
// since the worker acts as the pool itself, not as an agent caller.
func (s *Server) workWallet(ctx context.Context, rawWallet, containerID string) bool {
	wallet, err := domain.NewWalletAddress(rawWallet)
	if err != nil {
		return false
	}
	ent, err := s.ledger.Entitlement(wallet)
	if err != nil {
		return false
	}
	if over, err := s.ledger.Exceeded(wallet); err != nil || over {
		return false
	}
	if err := s.ledger.BeginExec(wallet); err != nil {
		return false
	}
	start := time.Now()
	_, execErr := s.backend.ExecCommand(ctx, containerID, workerBurn)
	elapsed := time.Since(start).Seconds()
	if uerr := s.ledger.EndExec(wallet, elapsed*ent.CPU, elapsed*float64(ent.MemMB)/3600); uerr != nil {
		s.logger.Warn("worker-bill-failed",
			slog.String("wallet", wallet.String()),
			slog.Any("err", uerr))
		return false
	}
	if execErr != nil {
		s.logger.Warn("worker-exec-failed",
			slog.String("wallet", wallet.String()),
			slog.String("container", containerID),
			slog.Any("err", execErr))
		return false
	}
	s.logger.Info("worker-burn",
		slog.String("wallet", wallet.String()),
		slog.Float64("elapsed_s", elapsed))
	return true
}

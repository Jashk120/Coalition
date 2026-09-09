// Command orchestrator starts the Coalition pool orchestrator: paid resource
// limits over Docker, resale-market endpoints, and live pool terms.
package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/Jashk120/Coalition/orchestrator/internal/api"
	"github.com/Jashk120/Coalition/orchestrator/internal/backend"
	"github.com/Jashk120/Coalition/orchestrator/internal/config"
	"github.com/Jashk120/Coalition/orchestrator/internal/settle"
	"github.com/Jashk120/Coalition/orchestrator/internal/store"
)

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	if err := run(logger); err != nil {
		logger.Error("orchestrator exited", slog.Any("err", err))
		os.Exit(1)
	}
}

func run(logger *slog.Logger) error {
	cfg, err := config.Load()
	if err != nil {
		return err
	}
	logger.Info("startup",
		slog.String("resource", cfg.ResourceName),
		slog.String("port", cfg.Port),
		slog.String("provider", cfg.ProviderAddress.String()),
		slog.Bool("settleEnabled", cfg.PoolAddress != ""),
		slog.Bool("roundsEnabled", cfg.PoolV2Address != ""))

	ledger := store.NewStore(cfg.WindowHours)
	if cfg.AllowNoAppAuth {
		logger.Warn("ALLOW_NO_APP_AUTH=1: operator endpoints accept unauthenticated provisioning; dev-only, never enable in production")
	}
	be, err := pickBackend(logger, cfg.DockerHost, cfg.NetworkMode, cfg.RequireDocker)
	if err != nil {
		return err
	}

	srv, err := api.NewServer(cfg, ledger, be, logger)
	if err != nil {
		return err
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	srv.StartReaper(ctx)
	srv.StartWorker(ctx)

	done := make(chan error, 2)
	procs := 1
	go func() { done <- srv.Run(ctx) }()
	if cfg.PoolAddress != "" || cfg.PoolV2Address != "" {
		lis := settle.NewListener(cfg.RPCURL, cfg.PoolAddress, cfg.PollInterval, ledger, logger,
			settle.WithCommitmentTarget(cfg.TargetAtomic),
			settle.WithConfirmations(uint64(cfg.Confirmations)),
			settle.WithV2Pool(cfg.PoolV2Address),
		)
		procs = 2
		go func() { done <- lis.Run(ctx) }()
	} else {
		logger.Info("settle listener disabled: POOL_ADDRESS empty")
	}

	select {
	case err := <-done:
		return err
	case <-ctx.Done():
	}
	logger.Info("shutdown signal received")
	timer := time.NewTimer(10 * time.Second)
	defer timer.Stop()
	for i := 0; i < procs; i++ {
		select {
		case err := <-done:
			if err != nil {
				return err
			}
		case <-timer.C:
			return errors.New("shutdown timed out")
		}
	}
	return nil
}

// pickBackend prefers the Docker daemon and falls back to the in-memory fake
// with a loud warning when the daemon is unreachable. With REQUIRE_DOCKER=1
// an unreachable daemon is fatal instead of a fallback: silently running
// without enforcement would bill for protection that is not there. It never
// crashes otherwise: the service stays up for terms/quotes/metering without
// container enforcement.
func pickBackend(logger *slog.Logger, dockerHost, networkMode string, requireDocker bool) (backend.ContainerBackend, error) {
	docker, err := backend.NewDockerBackend(dockerHost, networkMode)
	if err != nil {
		if requireDocker {
			return nil, fmt.Errorf("docker backend misconfigured: %w", err)
		}
		logger.Warn("docker backend misconfigured, using memory backend", slog.Any("err", err))
		return backend.NewMemoryBackend(), nil
	}
	pingCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := docker.Ping(pingCtx); err != nil {
		if requireDocker {
			return nil, fmt.Errorf("docker daemon unreachable: %w", err)
		}
		logger.Warn("docker daemon unreachable, using memory backend", slog.Any("err", err))
		return backend.NewMemoryBackend(), nil
	}
	logger.Info("docker backend ready")
	return docker, nil
}

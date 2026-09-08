package api

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"time"

	"github.com/Jashk120/Coalition/orchestrator/internal/backend"
	"github.com/Jashk120/Coalition/orchestrator/internal/domain"
	"github.com/Jashk120/Coalition/orchestrator/internal/store"
)

type runRequest struct {
	Wallet string   `json:"wallet"`
	Cmd    []string `json:"cmd"`
}

type runResponse struct {
	Stdout   string `json:"stdout"`
	Stderr   string `json:"stderr"`
	ExitCode int    `json:"exitCode"`
}

func (s *Server) handleRun(w http.ResponseWriter, r *http.Request) {
	var req runRequest
	if err := decodeJSON(r, &req); err != nil {
		writeJSONError(w, s.logger, badRequest("invalid JSON: "+err.Error()))
		return
	}
	wallet, err := domain.NewWalletAddress(req.Wallet)
	if err != nil {
		writeJSONError(w, s.logger, badRequest(err.Error()))
		return
	}
	if len(req.Cmd) == 0 {
		writeJSONError(w, s.logger, badRequest("cmd must be a non-empty array"))
		return
	}
	ent, err := s.ledger.Entitlement(wallet)
	if err != nil {
		writeJSONError(w, s.logger, notFound("unknown wallet "+wallet.String()))
		return
	}
	if !s.authenticateWallet(w, wallet, r) {
		return
	}
	containerID, err := s.ledger.Container(wallet)
	if err != nil {
		containerID, err = s.provisionContainer(r.Context(), wallet, ent)
		if err != nil {
			writeJSONError(w, s.logger, fmt.Errorf("provision container: %w", err))
			return
		}
	}
	if err := s.enforceQuota(r.Context(), w, wallet, containerID); err != nil {
		return
	}
	if err := s.ledger.BeginExec(wallet); err != nil {
		if errors.Is(err, store.ErrQuotaExceeded) {
			_ = s.backend.KillContainer(r.Context(), containerID)
			s.ledger.Revoke(wallet)
			qerr := quotaExceeded("wallet " + wallet.String() + " exceeded paid slice; container killed")
			writeJSONError(w, s.logger, qerr)
			return
		}
		writeJSONError(w, s.logger, err)
		return
	}
	start := time.Now()
	res, execErr := s.backend.ExecCommand(r.Context(), containerID, req.Cmd)
	elapsed := time.Since(start).Seconds()
	if uerr := s.ledger.EndExec(wallet, elapsed*ent.CPU, elapsed*float64(ent.MemMB)/3600); uerr != nil {
		writeJSONError(w, s.logger, uerr)
		return
	}
	if execErr != nil {
		writeJSONError(w, s.logger, fmt.Errorf("exec: %w", execErr))
		return
	}
	writeJSON(w, http.StatusOK, runResponse{Stdout: res.Stdout, Stderr: res.Stderr, ExitCode: res.ExitCode})
}

// provisionContainer creates a container for a wallet that holds entitlement
// but lost its binding (eviction, restart, transfer-created). Only fully
// unknown wallets (no entitlement) stay 404.
func (s *Server) provisionContainer(ctx context.Context, wallet domain.WalletAddress, ent domain.Entitlement) (string, error) {
	name := "coalition-" + wallet.String()[2:]
	id, err := s.backend.CreateContainer(ctx, name, backend.Limits{CPUCores: ent.CPU, MemMB: ent.MemMB})
	if err != nil {
		return "", err
	}
	s.ledger.SetContainer(wallet, id)
	s.logger.Info("auto-provision",
		slog.String("wallet", wallet.String()),
		slog.String("container", id))
	return id, nil
}

// enforceQuota kills the container and writes a quota error when the wallet
// already exceeds its paid slice. A kill for overuse is a dropout: the token
// is revoked so the wallet cannot keep executing. A nil return means proceed.
func (s *Server) enforceQuota(ctx context.Context, w http.ResponseWriter, wallet domain.WalletAddress, containerID string) error {
	exceeded, err := s.ledger.Exceeded(wallet)
	if err != nil {
		writeJSONError(w, s.logger, notFound("unknown wallet "+wallet.String()))
		return err
	}
	if !exceeded {
		return nil
	}
	if kerr := s.backend.KillContainer(ctx, containerID); kerr != nil {
		writeJSONError(w, s.logger, fmt.Errorf("kill over-quota container: %w", kerr))
		return kerr
	}
	s.ledger.Revoke(wallet)
	s.logger.Warn("quota-exceeded",
		slog.String("wallet", wallet.String()),
		slog.String("container", containerID))
	qerr := quotaExceeded("wallet " + wallet.String() + " exceeded paid slice; container killed")
	writeJSONError(w, s.logger, qerr)
	return qerr
}

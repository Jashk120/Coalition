package api

import (
	"errors"
	"io"
	"log/slog"
	"math/big"
	"net/http"

	"github.com/Jashk120/Coalition/orchestrator/internal/domain"
)

// freePoolRequest scopes an operator pool reset. Empty body frees everything:
// roundId pins the reset to wallets stamped to that funding round (decimal
// round id string), killAll overrides any roundId filter and frees all
// wallets. No roundId and no killAll frees all wallets — the same as
// killAll:true — so a bare POST is the judges' one-click reset.
type freePoolRequest struct {
	RoundID *string `json:"roundId,omitempty"`
	KillAll *bool   `json:"killAll,omitempty"`
}

// freePoolResponse reports the reset. freed counts removed wallet records;
// failed lists wallets whose docker kill failed (their ledger records are
// still removed — see handleFreePool — so the pool is always re-testable).
// roundId echoes the round filter used, "" when the reset was unscoped.
type freePoolResponse struct {
	Freed   int      `json:"freed"`
	RoundID string   `json:"roundId"`
	Failed  []string `json:"failed,omitempty"`
}

// freeWalletRequest targets one wallet for the per-wallet operator kill.
type freeWalletRequest struct {
	Wallet string `json:"wallet"`
}

// freeWalletResponse reports a single-wallet kill. freed is 0 or 1;
// failed carries the wallet when its docker kill failed (record still
// removed, same policy as the pool reset).
type freeWalletResponse struct {
	Freed  int    `json:"freed"`
	Wallet string `json:"wallet"`
	Failed []string `json:"failed,omitempty"`
}

// handleFreePool is the operator pool reset: for every in-scope wallet it
// kills the bound container (when one is bound), then removes the wallet's
// ledger record entirely — entitlement, container binding, bearer token, and
// usage. Full clear, not usage-preserving: pool admission is
// SUM(entitlements) <= totals, so keeping entitlement rows would leave the
// pool exhausted and defeat the reset; usage without entitlement is
// meaningless, so it goes too.
//
// A failed docker kill never blocks the reset: the wallet is logged warn
// (same shape as reapOnce), reported in failed, and its record is still
// removed — otherwise one stuck container would brick judging. A later
// reaper pass or daemon restart reclaims the corpse; the ledger is already
// free for re-test.
//
// Operator tier only: the route is wrapped in requireAppKey, so agent Bearer
// tokens buy nothing here (missing key 401, wrong key 403, token-only 401).
func (s *Server) handleFreePool(w http.ResponseWriter, r *http.Request) {
	var req freePoolRequest
	if err := decodeJSON(r, &req); err != nil && !errors.Is(err, io.EOF) {
		writeJSONError(w, s.logger, badRequest("invalid JSON: "+err.Error()))
		return
	}
	filter := ""
	if req.RoundID != nil {
		filter = *req.RoundID
	}
	if req.KillAll != nil && *req.KillAll {
		filter = ""
	}
	roundID := filter
	if roundID == "" {
		if cur := s.ledger.CurrentRound(); cur != nil {
			roundID = cur.String()
		}
	}
	var failed []string
	freed := 0
	for _, b := range s.ledger.ListContainers() {
		if filter != "" && !roundMatches(s, b.Wallet, filter) {
			continue
		}
		if b.ContainerID != "" {
			if err := s.backend.KillContainer(r.Context(), b.ContainerID); err != nil {
				s.logger.Warn("free-pool-kill-failed",
					slog.String("wallet", b.Wallet),
					slog.String("container", b.ContainerID),
					slog.Any("err", err))
				failed = append(failed, b.Wallet)
			}
		}
		if wallet, err := domain.NewWalletAddress(b.Wallet); err == nil {
			s.ledger.RemoveWallet(wallet)
			freed++
		}
		s.logger.Warn("freed-wallet",
			slog.String("wallet", b.Wallet),
			slog.String("container", b.ContainerID))
	}
	writeJSON(w, http.StatusOK, freePoolResponse{Freed: freed, RoundID: roundID, Failed: failed})
}

// handleFreeWallet kills one wallet's container and removes its ledger
// record, under the same operator-tier auth and the same kill-failure policy
// as the pool reset: a failed kill is reported, never blocking. Unknown
// wallets are 404; wallets with no bound container are still removed (their
// entitlement alone would keep pool capacity held).
func (s *Server) handleFreeWallet(w http.ResponseWriter, r *http.Request) {
	var req freeWalletRequest
	if err := decodeJSON(r, &req); err != nil {
		writeJSONError(w, s.logger, badRequest("invalid JSON: "+err.Error()))
		return
	}
	wallet, err := domain.NewWalletAddress(req.Wallet)
	if err != nil {
		writeJSONError(w, s.logger, badRequest(err.Error()))
		return
	}
	if !s.ledger.HasWallet(wallet) {
		writeJSONError(w, s.logger, notFound("unknown wallet "+wallet.String()))
		return
	}
	var failed []string
	if containerID, err := s.ledger.Container(wallet); err == nil && containerID != "" {
		if kerr := s.backend.KillContainer(r.Context(), containerID); kerr != nil {
			s.logger.Warn("free-wallet-kill-failed",
				slog.String("wallet", wallet.String()),
				slog.String("container", containerID),
				slog.Any("err", kerr))
			failed = append(failed, wallet.String())
		}
	}
	s.ledger.RemoveWallet(wallet)
	s.logger.Warn("freed-wallet", slog.String("wallet", wallet.String()))
	writeJSON(w, http.StatusOK, freeWalletResponse{Freed: 1, Wallet: wallet.String(), Failed: failed})
}

// roundMatches reports whether the wallet's stamped funding round equals the
// decimal filter. Unstamped wallets (pre-round era) never match a filter;
// an unparseable filter falls back to plain string comparison so operator
// typos fail closed to zero matches instead of erroring the whole reset.
func roundMatches(s *Server, walletStr, filter string) bool {
	wallet, err := domain.NewWalletAddress(walletStr)
	if err != nil {
		return false
	}
	stamped, err := s.ledger.WalletRound(wallet)
	if err != nil || stamped == nil {
		return false
	}
	if want, ok := new(big.Int).SetString(filter, 10); ok {
		return stamped.Cmp(want) == 0
	}
	return stamped.String() == filter
}

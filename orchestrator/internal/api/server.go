package api

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"errors"
	"fmt"
	"log/slog"
	"math"
	"net"
	"net/http"
	"sync"
	"time"

	"github.com/Jashk120/Coalition/orchestrator/internal/backend"
	"github.com/Jashk120/Coalition/orchestrator/internal/config"
	"github.com/Jashk120/Coalition/orchestrator/internal/domain"
	"github.com/Jashk120/Coalition/orchestrator/internal/settle"
	"github.com/Jashk120/Coalition/orchestrator/internal/store"
)

// errInvalidLimiter marks malformed limiter construction params. There is
// no fallback value: a malformed limiter fails the server build.
var errInvalidLimiter = errors.New("api: invalid rate limiter params")

// maxBodyBytes caps every POST body: without it a client can force unbounded
// JSON buffering before validation runs.
const maxBodyBytes = 1 << 20

// Server wires config, ledger, and backend to HTTP routes. No global state:
// construct via NewServer.
type Server struct {
	cfg         config.Config
	ledger      *store.Store
	backend     backend.ContainerBackend
	logger      *slog.Logger
	mux         *http.ServeMux
	verifier    receiptVerifier
	limiter     *ipLimiter
	appKeyHash  [32]byte
	appAuthOpen bool
}

// NewServer builds the router. Invalid limiter params are a hard error, not
// a silent default: callers pass explicit values (config.Load already
// rejects malformed RATE_LIMIT_* at startup). Use Handler to serve it.
func NewServer(cfg config.Config, ledger *store.Store, be backend.ContainerBackend, logger *slog.Logger) (*Server, error) {
	limiter, err := newIPLimiter(cfg.RateLimitRPS, cfg.RateLimitBurst)
	if err != nil {
		return nil, err
	}
	s := &Server{
		cfg:         cfg,
		ledger:      ledger,
		backend:     be,
		logger:      logger,
		mux:         http.NewServeMux(),
		verifier:    settle.NewClient(cfg.RPCURL),
		limiter:     limiter,
		appKeyHash:  sha256.Sum256([]byte(cfg.AppAPIKey)),
		appAuthOpen: cfg.AllowNoAppAuth && cfg.AppAPIKey == "",
	}
	s.mux.HandleFunc("POST /allocate", s.requireAppKey(s.handleAllocate))
	s.mux.HandleFunc("POST /free-pool", s.requireAppKey(s.handleFreePool))
	s.mux.HandleFunc("DELETE /free-wallet", s.requireAppKey(s.handleFreeWallet))
	s.mux.HandleFunc("POST /run", s.handleRun)
	s.mux.HandleFunc("GET /terms.json", s.handleTerms)
	s.mux.HandleFunc("GET /quote", s.handleQuote)
	s.mux.HandleFunc("GET /usage", s.handleUsage)
	s.mux.HandleFunc("POST /transfer-quota", s.handleTransfer)
	s.mux.HandleFunc("GET /healthz", s.handleHealth)
	return s, nil
}

// SetVerifier swaps the receipt verifier; tests inject a fake, production
// keeps the *settle.Client built from RPC_URL.
func (s *Server) SetVerifier(v receiptVerifier) { s.verifier = v }

// appKeyHeader carries the operator app key. It is deliberately NOT the
// Authorization: Bearer scheme: that header belongs to agent tokens, and the
// two tiers must never be confusable at the parsing layer.
const appKeyHeader = "X-App-Key"

// requireAppKey enforces the operator tier in the router, not per-handler:
// POST /allocate mints quota plus agent tokens (a privilege grant), so only
// the operator app may call it — agents must not self-provision.
//
// Why a shared key instead of the usual alternatives: no IP allowlisting —
// the Next app's egress location is unknown (Vercel/VPS IPs are dynamic and
// brittle, so an allowlist would either break deploys or rot into 0.0.0.0/0),
// and key-based auth is location-independent. No mTLS yet — worth adding once
// the app host is fixed and stable, since client certs then give per-caller
// identity without shared-secret rotation pain; until then the app key is
// the whole operator boundary, so it must be long, random, and rotated on
// any suspected leak.
func (s *Server) requireAppKey(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if s.appAuthOpen {
			next(w, r)
			return
		}
		presented := r.Header.Get(appKeyHeader)
		if presented == "" {
			writeJSONError(w, s.logger, unauthorized("operator app key required"))
			return
		}
		sum := sha256.Sum256([]byte(presented))
		if subtle.ConstantTimeCompare(sum[:], s.appKeyHash[:]) != 1 {
			writeJSONError(w, s.logger, forbidden("operator app key rejected"))
			return
		}
		next(w, r)
	}
}

// Handler exposes the router for httptest, wrapped in body-limit and
// per-IP rate-limit middleware.
func (s *Server) Handler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost {
			r.Body = http.MaxBytesReader(w, r.Body, maxBodyBytes)
		}
		if !s.limiter.allow(clientIP(r)) {
			writeJSONError(w, s.logger, &APIError{
				Status:  http.StatusTooManyRequests,
				Code:    "rate_limited",
				Message: "per-IP rate limit exceeded",
			})
			return
		}
		s.mux.ServeHTTP(w, r)
	})
}

// clientIP keys the rate limiter on the TCP peer, never on headers: client
// headers are attacker-controlled and would let one client mint identities.
func clientIP(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

// Run serves until ctx is cancelled, then shuts down gracefully.
func (s *Server) Run(ctx context.Context) error {
	srv := &http.Server{
		Addr:              ":" + s.cfg.Port,
		Handler:           s.Handler(),
		ReadTimeout:       15 * time.Second,
		WriteTimeout:      30 * time.Second,
		ReadHeaderTimeout: 5 * time.Second,
	}
	errCh := make(chan error, 1)
	go func() {
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			errCh <- fmt.Errorf("listen: %w", err)
		}
		close(errCh)
	}()
	select {
	case <-ctx.Done():
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		return srv.Shutdown(shutdownCtx)
	case err := <-errCh:
		return err
	}
}

// StartReaper launches the background reaper: every tick it kills containers
// whose billed usage plus in-flight estimate exceeds budget and revokes their
// tokens (dropout). It stops when ctx is cancelled and never leaks.
func (s *Server) StartReaper(ctx context.Context) {
	go func() {
		ticker := time.NewTicker(s.cfg.ReaperInterval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				s.reapOnce(ctx)
			}
		}
	}()
}

// reapOnce is one reaper pass, factored out so tests drive it directly over a
// channel instead of sleeping for a tick.
func (s *Server) reapOnce(ctx context.Context) {
	for _, t := range s.ledger.ReapTargets() {
		if err := s.backend.KillContainer(ctx, t.ContainerID); err != nil {
			s.logger.Warn("reap-kill-failed",
				slog.String("wallet", t.Wallet),
				slog.String("container", t.ContainerID),
				slog.Any("err", err))
			continue
		}
		if w, err := domain.NewWalletAddress(t.Wallet); err == nil {
			s.ledger.Revoke(w)
		}
		s.logger.Warn("reaped-over-budget",
			slog.String("wallet", t.Wallet),
			slog.String("container", t.ContainerID))
	}
}

func (s *Server) handleHealth(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// ipLimiter is a per-IP token bucket: burst tokens max, refilled at rps.
// Coarse mutex-guarded map; stale entries are pruned opportunistically.
type ipLimiter struct {
	mu      sync.Mutex
	rps     float64
	burst   float64
	buckets map[string]*bucket
}

type bucket struct {
	tokens float64
	last   time.Time
}

func newIPLimiter(rps float64, burst int64) (*ipLimiter, error) {
	if math.IsNaN(rps) || math.IsInf(rps, 0) || rps <= 0 {
		return nil, fmt.Errorf("rate limit rps=%v: %w", rps, errInvalidLimiter)
	}
	if burst < 1 {
		return nil, fmt.Errorf("rate limit burst=%d: %w", burst, errInvalidLimiter)
	}
	return &ipLimiter{rps: rps, burst: float64(burst), buckets: make(map[string]*bucket)}, nil
}

func (l *ipLimiter) allow(ip string) bool {
	now := time.Now()
	l.mu.Lock()
	defer l.mu.Unlock()
	b, ok := l.buckets[ip]
	if !ok {
		b = &bucket{tokens: l.burst, last: now}
		l.buckets[ip] = b
	}
	elapsed := now.Sub(b.last).Seconds()
	if elapsed > 0 {
		b.tokens += elapsed * l.rps
		if b.tokens > l.burst {
			b.tokens = l.burst
		}
		b.last = now
	}
	if len(l.buckets) > 4096 {
		for k, v := range l.buckets {
			if now.Sub(v.last) > time.Minute {
				delete(l.buckets, k)
			}
		}
	}
	if b.tokens < 1 {
		return false
	}
	b.tokens--
	return true
}

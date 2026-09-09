// Package config loads the orchestrator Config from environment variables.
// The environment is the single source of truth: there is no checked-in
// per-deployment JSON. Required fields fail fast with a typed error;
// malformed optional fields are fatal too, never silently defaulted.
package config

import (
	"errors"
	"fmt"
	"math"
	"math/big"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/Jashk120/Coalition/orchestrator/internal/domain"
	"github.com/Jashk120/Coalition/orchestrator/internal/money"
)

var (
	// ErrMissingProvider is returned when PROVIDER_ADDRESS is empty.
	ErrMissingProvider = errors.New("config: PROVIDER_ADDRESS is required")
	// ErrMissingAppKey is returned when APP_API_KEY is empty without the
	// ALLOW_NO_APP_AUTH=1 dev escape hatch.
	ErrMissingAppKey = errors.New("config: APP_API_KEY is required (or ALLOW_NO_APP_AUTH=1 for dev)")
	// ErrInvalidValue wraps every malformed env value.
	ErrInvalidValue = errors.New("config: invalid value")
)

// Config is the validated orchestrator configuration.
type Config struct {
	ResourceName    string
	CPUTotal        float64
	MemMB           int64
	MaxAgents       int64
	TargetUSDC      string
	TargetAtomic    *big.Int
	WindowHours     int64
	ProviderAddress domain.WalletAddress
	PoolAddress     string
	PoolV2Address   string
	Port            string
	DockerHost      string
	NetworkMode     string
	RPCURL          string
	PollInterval    time.Duration
	Confirmations   int64
	ReaperInterval  time.Duration
	RateLimitRPS    float64
	RateLimitBurst  int64
	PublicBaseURL   string
	TrustProxy      bool
	RequireDocker   bool
	AppAPIKey       string
	AllowNoAppAuth  bool
}

// WindowSeconds returns the compute window in seconds.
func (c Config) WindowSeconds() float64 {
	return float64(c.WindowHours) * 3600
}

// lookup reads key from env, reporting whether it was set.
func lookup(key string) (string, bool) {
	v, ok := os.LookupEnv(key)
	return v, ok
}

// Load reads the process environment and returns a validated Config.
func Load() (Config, error) {
	return loadFrom(lookup)
}

func loadFrom(lookup func(string) (string, bool)) (Config, error) {
	get := func(key, def string) string {
		if v, ok := lookup(key); ok && strings.TrimSpace(v) != "" {
			return strings.TrimSpace(v)
		}
		return def
	}
	var cfg Config

	cfg.ResourceName = get("RESOURCE_NAME", "Coalition Pool #1")

	cpuRaw := get("CPU_UNITS", "1")
	cpu, err := strconv.ParseFloat(cpuRaw, 64)
	if err != nil || math.IsNaN(cpu) || math.IsInf(cpu, 0) || cpu <= 0 {
		return Config{}, fmt.Errorf("CPU_UNITS=%q: %w", cpuRaw, ErrInvalidValue)
	}
	cfg.CPUTotal = cpu

	memRaw := get("MEM_MB", "4096")
	mem, err := strconv.ParseInt(memRaw, 10, 64)
	if err != nil || mem <= 0 {
		return Config{}, fmt.Errorf("MEM_MB=%q: %w", memRaw, ErrInvalidValue)
	}
	cfg.MemMB = mem

	targetRaw := get("TARGET_USDC", "10.00")
	target, err := money.ParseAtomic(targetRaw)
	if err != nil {
		return Config{}, fmt.Errorf("TARGET_USDC=%q: %w", targetRaw, ErrInvalidValue)
	}
	cfg.TargetUSDC = targetRaw
	cfg.TargetAtomic = target

	maxAgentsRaw := get("MAX_AGENTS", "5")
	maxAgents, err := strconv.ParseInt(maxAgentsRaw, 10, 64)
	if err != nil || maxAgents <= 0 {
		return Config{}, fmt.Errorf("MAX_AGENTS=%q: %w", maxAgentsRaw, ErrInvalidValue)
	}
	cfg.MaxAgents = maxAgents

	windowRaw := get("WINDOW_HOURS", "72")
	window, err := strconv.ParseInt(windowRaw, 10, 64)
	if err != nil || window <= 0 {
		return Config{}, fmt.Errorf("WINDOW_HOURS=%q: %w", windowRaw, ErrInvalidValue)
	}
	cfg.WindowHours = window

	providerRaw, _ := lookup("PROVIDER_ADDRESS")
	providerRaw = strings.TrimSpace(providerRaw)
	if providerRaw == "" {
		return Config{}, ErrMissingProvider
	}
	provider, err := domain.NewWalletAddress(providerRaw)
	if err != nil {
		return Config{}, fmt.Errorf("PROVIDER_ADDRESS: %w", err)
	}
	cfg.ProviderAddress = provider

	poolRaw := get("POOL_ADDRESS", "")
	if poolRaw != "" {
		pool, err := domain.NewWalletAddress(poolRaw)
		if err != nil {
			return Config{}, fmt.Errorf("POOL_ADDRESS: %w", err)
		}
		cfg.PoolAddress = pool.String()
	}

	poolV2Raw := get("POOL_V2_ADDRESS", "")
	if poolV2Raw != "" {
		poolV2, err := domain.NewWalletAddress(poolV2Raw)
		if err != nil {
			return Config{}, fmt.Errorf("POOL_V2_ADDRESS: %w", err)
		}
		cfg.PoolV2Address = poolV2.String()
	}

	portRaw := get("PORT", "8080")
	port, err := strconv.Atoi(portRaw)
	if err != nil || port < 1 || port > 65535 {
		return Config{}, fmt.Errorf("PORT=%q: %w", portRaw, ErrInvalidValue)
	}
	cfg.Port = portRaw

	cfg.DockerHost = get("DOCKER_HOST", "")

	cfg.NetworkMode = get("DOCKER_NETWORK_MODE", "none")
	if cfg.NetworkMode == "" {
		return Config{}, fmt.Errorf("DOCKER_NETWORK_MODE=%q: %w", cfg.NetworkMode, ErrInvalidValue)
	}

	if strings.HasPrefix(strings.ToLower(strings.TrimSpace(cfg.DockerHost)), "tcp://") &&
		!parseBoolEnv(get("ALLOW_INSECURE_DOCKER_TCP", "")) {
		return Config{}, fmt.Errorf("DOCKER_HOST=%q is tcp:// without ALLOW_INSECURE_DOCKER_TCP=1: %w",
			cfg.DockerHost, ErrInvalidValue)
	}

	rpcRaw := get("RPC_URL", "https://rpc.testnet.arc.io")
	u, err := url.ParseRequestURI(rpcRaw)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") {
		return Config{}, fmt.Errorf("RPC_URL=%q: %w", rpcRaw, ErrInvalidValue)
	}
	if u.Scheme == "http" && !isLoopbackHost(u.Hostname()) {
		return Config{}, fmt.Errorf("RPC_URL=%q must be https except on localhost: %w", rpcRaw, ErrInvalidValue)
	}
	cfg.RPCURL = rpcRaw

	pollRaw := get("POLL_INTERVAL", "5s")
	poll, err := time.ParseDuration(pollRaw)
	if err != nil || poll <= 0 {
		return Config{}, fmt.Errorf("POLL_INTERVAL=%q: %w", pollRaw, ErrInvalidValue)
	}
	cfg.PollInterval = poll

	confRaw := get("CONFIRMATIONS", "1")
	conf, err := strconv.ParseInt(confRaw, 10, 64)
	if err != nil || conf < 1 {
		return Config{}, fmt.Errorf("CONFIRMATIONS=%q: %w", confRaw, ErrInvalidValue)
	}
	cfg.Confirmations = conf

	reaperRaw := get("REAPER_INTERVAL", "10s")
	reaper, err := time.ParseDuration(reaperRaw)
	if err != nil || reaper <= 0 {
		return Config{}, fmt.Errorf("REAPER_INTERVAL=%q: %w", reaperRaw, ErrInvalidValue)
	}
	cfg.ReaperInterval = reaper

	rpsRaw := get("RATE_LIMIT_RPS", "20")
	rps, err := strconv.ParseFloat(rpsRaw, 64)
	if err != nil || math.IsNaN(rps) || math.IsInf(rps, 0) || rps <= 0 {
		return Config{}, fmt.Errorf("RATE_LIMIT_RPS=%q: %w", rpsRaw, ErrInvalidValue)
	}
	cfg.RateLimitRPS = rps

	burstRaw := get("RATE_LIMIT_BURST", "40")
	burst, err := strconv.ParseInt(burstRaw, 10, 64)
	if err != nil || burst < 1 {
		return Config{}, fmt.Errorf("RATE_LIMIT_BURST=%q: %w", burstRaw, ErrInvalidValue)
	}
	cfg.RateLimitBurst = burst

	cfg.TrustProxy = parseBoolEnv(get("TRUST_PROXY", ""))
	cfg.RequireDocker = parseBoolEnv(get("REQUIRE_DOCKER", ""))
	cfg.AllowNoAppAuth = parseBoolEnv(get("ALLOW_NO_APP_AUTH", ""))

	keyRaw := strings.TrimSpace(get("APP_API_KEY", ""))
	if keyRaw == "" {
		if !cfg.AllowNoAppAuth {
			return Config{}, ErrMissingAppKey
		}
	} else if len(keyRaw) < 16 {
		return Config{}, fmt.Errorf("APP_API_KEY too short (%d chars, want >=16): %w", len(keyRaw), ErrInvalidValue)
	}
	cfg.AppAPIKey = keyRaw

	baseRaw := strings.TrimSpace(get("PUBLIC_BASE_URL", ""))
	if baseRaw != "" {
		u, err := url.ParseRequestURI(strings.TrimSuffix(baseRaw, "/"))
		if err != nil || (u.Scheme != "http" && u.Scheme != "https") {
			return Config{}, fmt.Errorf("PUBLIC_BASE_URL=%q: %w", baseRaw, ErrInvalidValue)
		}
		if u.Host == "" {
			return Config{}, fmt.Errorf("PUBLIC_BASE_URL=%q has no host: %w", baseRaw, ErrInvalidValue)
		}
		cfg.PublicBaseURL = strings.TrimSuffix(baseRaw, "/")
	}

	return cfg, nil
}

// parseBoolEnv reports whether a raw env value opts in. Only explicit truthy
// spellings count; anything else (including "0"/"false"/empty) is false so a
// typo never silently enables an insecure mode.
func parseBoolEnv(v string) bool {
	switch strings.ToLower(strings.TrimSpace(v)) {
	case "1", "true", "yes", "on":
		return true
	default:
		return false
	}
}

// isLoopbackHost reports whether host is a loopback name or IP. Plain http is
// only ever allowed here (httptest boot tests); everything else must be https.
func isLoopbackHost(host string) bool {
	h := strings.ToLower(strings.TrimSpace(host))
	if h == "localhost" {
		return true
	}
	if strings.HasPrefix(h, "127.") {
		return true
	}
	return h == "::1" || h == "[::1]"
}

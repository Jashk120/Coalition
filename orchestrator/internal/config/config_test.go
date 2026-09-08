package config

import (
	"errors"
	"math/big"
	"testing"
	"time"
)

const testProvider = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"

func lookupOf(env map[string]string) func(string) (string, bool) {
	return func(k string) (string, bool) {
		v, ok := env[k]
		return v, ok
	}
}

func Test_LoadFrom_defaults_apply(t *testing.T) {
	cfg, err := loadFrom(lookupOf(map[string]string{
		"PROVIDER_ADDRESS":  testProvider,
		"ALLOW_NO_APP_AUTH": "1",
	}))
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if cfg.ResourceName != "Coalition Pool #1" {
		t.Errorf("ResourceName = %q", cfg.ResourceName)
	}
	if cfg.CPUTotal != 1 {
		t.Errorf("CPUTotal = %v", cfg.CPUTotal)
	}
	if cfg.MemMB != 4096 {
		t.Errorf("MemMB = %d", cfg.MemMB)
	}
	if cfg.TargetUSDC != "10.00" {
		t.Errorf("TargetUSDC = %q", cfg.TargetUSDC)
	}
	if cfg.TargetAtomic.Cmp(big.NewInt(10000000)) != 0 {
		t.Errorf("TargetAtomic = %s", cfg.TargetAtomic)
	}
	if cfg.MaxAgents != 5 {
		t.Errorf("MaxAgents = %d", cfg.MaxAgents)
	}
	if cfg.Confirmations != 1 {
		t.Errorf("Confirmations = %d", cfg.Confirmations)
	}
	if cfg.NetworkMode != "none" {
		t.Errorf("NetworkMode = %q", cfg.NetworkMode)
	}
	if cfg.ReaperInterval != 10*time.Second {
		t.Errorf("ReaperInterval = %v", cfg.ReaperInterval)
	}
	if cfg.RateLimitRPS != 20 {
		t.Errorf("RateLimitRPS = %v", cfg.RateLimitRPS)
	}
	if cfg.RateLimitBurst != 40 {
		t.Errorf("RateLimitBurst = %d", cfg.RateLimitBurst)
	}
	if cfg.TrustProxy {
		t.Error("TrustProxy should default false")
	}
	if cfg.RequireDocker {
		t.Error("RequireDocker should default false")
	}
	if cfg.WindowHours != 72 {
		t.Errorf("WindowHours = %d", cfg.WindowHours)
	}
	if cfg.ProviderAddress.String() != "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266" {
		t.Errorf("ProviderAddress = %s", cfg.ProviderAddress)
	}
	if cfg.PoolAddress != "" {
		t.Errorf("PoolAddress should default empty, got %q", cfg.PoolAddress)
	}
	if cfg.Port != "8080" {
		t.Errorf("Port = %q", cfg.Port)
	}
	if cfg.DockerHost != "" {
		t.Errorf("DockerHost should default empty, got %q", cfg.DockerHost)
	}
	if cfg.RPCURL != "https://rpc.testnet.arc.io" {
		t.Errorf("RPCURL = %q", cfg.RPCURL)
	}
	if cfg.PollInterval != 5*time.Second {
		t.Errorf("PollInterval = %v", cfg.PollInterval)
	}
	if cfg.AppAPIKey != "" {
		t.Errorf("AppAPIKey should default empty, got %q", cfg.AppAPIKey)
	}
	if !cfg.AllowNoAppAuth {
		t.Error("AllowNoAppAuth should be true via test env")
	}
}

func Test_LoadFrom_missing_provider_fails(t *testing.T) {
	_, err := loadFrom(lookupOf(map[string]string{}))
	if !errors.Is(err, ErrMissingProvider) {
		t.Fatalf("expected ErrMissingProvider, got %v", err)
	}
}

func Test_LoadFrom_bad_values_fail(t *testing.T) {
	tests := []struct {
		name string
		env  map[string]string
	}{
		{"cpu zero", map[string]string{"CPU_UNITS": "0"}},
		{"cpu negative", map[string]string{"CPU_UNITS": "-1"}},
		{"cpu garbage", map[string]string{"CPU_UNITS": "lots"}},
		{"cpu NaN", map[string]string{"CPU_UNITS": "NaN"}},
		{"cpu +Inf", map[string]string{"CPU_UNITS": "+Inf"}},
		{"cpu -Inf", map[string]string{"CPU_UNITS": "-Inf"}},
		{"max agents zero", map[string]string{"MAX_AGENTS": "0"}},
		{"max agents negative", map[string]string{"MAX_AGENTS": "-2"}},
		{"max agents garbage", map[string]string{"MAX_AGENTS": "many"}},
		{"confirmations zero", map[string]string{"CONFIRMATIONS": "0"}},
		{"confirmations garbage", map[string]string{"CONFIRMATIONS": "soon"}},
		{"tcp without opt-in", map[string]string{"DOCKER_HOST": "tcp://10.0.0.9:2375"}},
		{"rpc http remote", map[string]string{"RPC_URL": "http://rpc.example.com"}},
		{"rate rps zero", map[string]string{"RATE_LIMIT_RPS": "0"}},
		{"rate rps NaN", map[string]string{"RATE_LIMIT_RPS": "NaN"}},
		{"rate burst zero", map[string]string{"RATE_LIMIT_BURST": "0"}},
		{"reaper zero", map[string]string{"REAPER_INTERVAL": "0s"}},
		{"mem zero", map[string]string{"MEM_MB": "0"}},
		{"mem garbage", map[string]string{"MEM_MB": "4GB"}},
		{"target garbage", map[string]string{"TARGET_USDC": "ten"}},
		{"target too precise", map[string]string{"TARGET_USDC": "10.0000001"}},
		{"window negative", map[string]string{"WINDOW_HOURS": "-72"}},
		{"provider bad hex", map[string]string{"PROVIDER_ADDRESS": "0xZZZ"}},
		{"provider short", map[string]string{"PROVIDER_ADDRESS": "0x1234"}},
		{"pool bad hex", map[string]string{"POOL_ADDRESS": "nope"}},
		{"port zero", map[string]string{"PORT": "0"}},
		{"port too big", map[string]string{"PORT": "99999"}},
		{"port garbage", map[string]string{"PORT": "http"}},
		{"rpc wrong scheme", map[string]string{"RPC_URL": "ftp://example.com"}},
		{"rpc garbage", map[string]string{"RPC_URL": "::::"}},
		{"poll zero", map[string]string{"POLL_INTERVAL": "0s"}},
		{"poll garbage", map[string]string{"POLL_INTERVAL": "soon"}},
		{"app key short", map[string]string{"APP_API_KEY": "short"}},
		{"app key 15 chars", map[string]string{"APP_API_KEY": "123456789012345"}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			env := map[string]string{"PROVIDER_ADDRESS": testProvider, "ALLOW_NO_APP_AUTH": "1"}
			for k, v := range tt.env {
				env[k] = v
			}
			if _, err := loadFrom(lookupOf(env)); err == nil {
				t.Fatal("expected error")
			}
		})
	}
}

func Test_LoadFrom_app_api_key(t *testing.T) {
	t.Run("missing without escape hatch fails", func(t *testing.T) {
		_, err := loadFrom(lookupOf(map[string]string{"PROVIDER_ADDRESS": testProvider}))
		if !errors.Is(err, ErrMissingAppKey) {
			t.Fatalf("expected ErrMissingAppKey, got %v", err)
		}
	})
	t.Run("escape hatch allows empty", func(t *testing.T) {
		cfg, err := loadFrom(lookupOf(map[string]string{
			"PROVIDER_ADDRESS":  testProvider,
			"ALLOW_NO_APP_AUTH": "1",
		}))
		if err != nil {
			t.Fatalf("load: %v", err)
		}
		if !cfg.AllowNoAppAuth || cfg.AppAPIKey != "" {
			t.Fatalf("got AllowNoAppAuth=%v AppAPIKey=%q", cfg.AllowNoAppAuth, cfg.AppAPIKey)
		}
	})
	t.Run("16 chars accepted, stored verbatim", func(t *testing.T) {
		cfg, err := loadFrom(lookupOf(map[string]string{
			"PROVIDER_ADDRESS": testProvider,
			"APP_API_KEY":      "0123456789abcdef",
		}))
		if err != nil {
			t.Fatalf("load: %v", err)
		}
		if cfg.AppAPIKey != "0123456789abcdef" {
			t.Fatalf("AppAPIKey = %q", cfg.AppAPIKey)
		}
		if cfg.AllowNoAppAuth {
			t.Error("AllowNoAppAuth should default false")
		}
	})
}

func Test_LoadFrom_insecure_modes_opt_in(t *testing.T) {
	cfg, err := loadFrom(lookupOf(map[string]string{
		"PROVIDER_ADDRESS":          testProvider,
		"DOCKER_HOST":               "tcp://10.0.0.9:2375",
		"ALLOW_INSECURE_DOCKER_TCP": "1",
		"RPC_URL":                   "http://127.0.0.1:8545",
		"TRUST_PROXY":               "1",
		"REQUIRE_DOCKER":            "true",
		"DOCKER_NETWORK_MODE":       "bridge",
		"MAX_AGENTS":                "7",
		"CONFIRMATIONS":             "3",
		"REAPER_INTERVAL":           "3s",
		"RATE_LIMIT_RPS":            "5",
		"RATE_LIMIT_BURST":          "10",
		"APP_API_KEY":               "test-operator-app-key-0123456789abcdef",
	}))
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if cfg.DockerHost != "tcp://10.0.0.9:2375" {
		t.Errorf("DockerHost = %q", cfg.DockerHost)
	}
	if cfg.NetworkMode != "bridge" {
		t.Errorf("NetworkMode = %q", cfg.NetworkMode)
	}
	if cfg.MaxAgents != 7 || cfg.Confirmations != 3 {
		t.Errorf("MaxAgents/Confirmations = %d/%d", cfg.MaxAgents, cfg.Confirmations)
	}
	if cfg.ReaperInterval != 3*time.Second {
		t.Errorf("ReaperInterval = %v", cfg.ReaperInterval)
	}
	if cfg.RateLimitRPS != 5 || cfg.RateLimitBurst != 10 {
		t.Errorf("RateLimit = %v/%d", cfg.RateLimitRPS, cfg.RateLimitBurst)
	}
	if !cfg.TrustProxy || !cfg.RequireDocker {
		t.Error("TrustProxy and RequireDocker should be true")
	}
	if cfg.AppAPIKey != "test-operator-app-key-0123456789abcdef" {
		t.Errorf("AppAPIKey = %q", cfg.AppAPIKey)
	}
}

func Test_LoadFrom_public_base_url(t *testing.T) {
	cfg, err := loadFrom(lookupOf(map[string]string{
		"PROVIDER_ADDRESS":  testProvider,
		"PUBLIC_BASE_URL":   "https://pool.example/",
		"ALLOW_NO_APP_AUTH": "1",
	}))
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if cfg.PublicBaseURL != "https://pool.example" {
		t.Errorf("PublicBaseURL = %q, want trailing slash trimmed", cfg.PublicBaseURL)
	}
	for _, tc := range []struct {
		name string
		env  map[string]string
	}{
		{"bad scheme", map[string]string{"PUBLIC_BASE_URL": "ftp://pool.example"}},
		{"not a url", map[string]string{"PUBLIC_BASE_URL": "::::"}},
		{"no host", map[string]string{"PUBLIC_BASE_URL": "https://"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			env := map[string]string{"PROVIDER_ADDRESS": testProvider, "ALLOW_NO_APP_AUTH": "1"}
			for k, v := range tc.env {
				env[k] = v
			}
			if _, err := loadFrom(lookupOf(env)); err == nil {
				t.Fatal("expected error")
			}
		})
	}
}

func Test_LoadFrom_pool_optional_parses(t *testing.T) {
	pool := "0x70997970C51812dc3A010C7d01b50e0d17dc79C8"
	cfg, err := loadFrom(lookupOf(map[string]string{
		"PROVIDER_ADDRESS":  testProvider,
		"POOL_ADDRESS":      pool,
		"ALLOW_NO_APP_AUTH": "1",
	}))
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if cfg.PoolAddress != "0x70997970c51812dc3a010c7d01b50e0d17dc79c8" {
		t.Errorf("PoolAddress = %q", cfg.PoolAddress)
	}
}

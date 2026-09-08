package main

import (
	"io"
	"log/slog"
	"testing"

	"github.com/Jashk120/Coalition/orchestrator/internal/backend"
)

func Test_PickBackend_falls_back_without_daemon(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	for _, tc := range []struct {
		name string
		host string
	}{
		{"bad scheme", "bogus://nope"},
		{"refused tcp", "tcp://127.0.0.1:1"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			be, err := pickBackend(logger, tc.host, "none", false)
			if err != nil {
				t.Fatalf("fallback must not error: %v", err)
			}
			if _, ok := be.(*backend.MemoryBackend); !ok {
				t.Fatalf("expected *MemoryBackend fallback, got %T", be)
			}
		})
	}
}

func Test_PickBackend_require_docker_fatals(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	if _, err := pickBackend(logger, "tcp://127.0.0.1:1", "none", true); err == nil {
		t.Fatal("REQUIRE_DOCKER with unreachable daemon must fatal")
	}
	if _, err := pickBackend(logger, "bogus://nope", "none", true); err == nil {
		t.Fatal("REQUIRE_DOCKER with misconfigured host must fatal")
	}
}

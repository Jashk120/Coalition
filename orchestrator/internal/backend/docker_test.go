package backend

import (
	"context"
	"errors"
	"testing"
	"time"
)

func Test_SplitDockerHost(t *testing.T) {
	tests := []struct {
		name       string
		raw        string
		wantScheme string
		wantAddr   string
		isErr      bool
	}{
		{"default socket", "", "unix", "/var/run/docker.sock", false},
		{"custom socket", "unix:///tmp/docker.sock", "unix", "/tmp/docker.sock", false},
		{"tcp daemon", "tcp://127.0.0.1:2375", "tcp", "127.0.0.1:2375", false},
		{"empty unix path", "unix://", "", "", true},
		{"empty tcp addr", "tcp://", "", "", true},
		{"bare scheme", "http://x", "", "", true},
		{"bare path", "/tmp/docker.sock", "", "", true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			scheme, addr, err := splitDockerHost(tt.raw)
			if tt.isErr {
				if err == nil {
					t.Fatal("expected error")
				}
				if !errors.Is(err, ErrDaemon) {
					t.Fatalf("should wrap ErrDaemon, got %v", err)
				}
				return
			}
			if err != nil {
				t.Fatalf("split: %v", err)
			}
			if scheme != tt.wantScheme || addr != tt.wantAddr {
				t.Fatalf("got %s://%s", scheme, addr)
			}
		})
	}
}

func Test_Demux(t *testing.T) {
	frame := []byte{
		1, 0, 0, 0, 0, 0, 0, 2, 'h', 'i',
		2, 0, 0, 0, 0, 0, 0, 3, 'b', 'y', 'e',
	}
	stdout, stderr := demux(frame)
	if stdout != "hi" {
		t.Fatalf("stdout = %q", stdout)
	}
	if stderr != "bye" {
		t.Fatalf("stderr = %q", stderr)
	}
	if out, errOut := demux(nil); out != "" || errOut != "" {
		t.Fatal("empty frame must yield empty strings")
	}
}

func Test_Docker_daemon_integration(t *testing.T) {
	if testing.Short() {
		t.Skip("daemon integration gated behind -short=false")
	}
	be, err := NewDockerBackend("")
	if err != nil {
		t.Fatalf("backend: %v", err)
	}
	if be.NetworkMode() != "none" {
		t.Fatalf("default NetworkMode = %q, want none", be.NetworkMode())
	}
	custom, err := NewDockerBackend("", "bridge")
	if err != nil {
		t.Fatalf("backend: %v", err)
	}
	if custom.NetworkMode() != "bridge" {
		t.Fatalf("NetworkMode = %q, want bridge", custom.NetworkMode())
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if err := be.Ping(ctx); err != nil {
		t.Skipf("no daemon available: %v", err)
	}
}

package backend

import (
	"context"
	"testing"
)

func Test_Memory_create_exec_kill(t *testing.T) {
	m := NewMemoryBackend()
	ctx := context.Background()
	id, err := m.CreateContainer(ctx, "w1", Limits{CPUCores: 0.2, MemMB: 800})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if id == "" {
		t.Fatal("empty container id")
	}
	lim, ok := m.LimitsOf(id)
	if !ok || lim.CPUCores != 0.2 || lim.MemMB != 800 {
		t.Fatalf("limits = %+v, %v", lim, ok)
	}
	res, err := m.ExecCommand(ctx, id, []string{"echo", "hi"})
	if err != nil {
		t.Fatalf("exec: %v", err)
	}
	if res.ExitCode != 0 || res.Stdout == "" {
		t.Fatalf("exec result = %+v", res)
	}
	if err := m.KillContainer(ctx, id); err != nil {
		t.Fatalf("kill: %v", err)
	}
	if !m.Killed(id) {
		t.Fatal("kill not recorded")
	}
	snap, err := m.InspectUsage(ctx, id)
	if err != nil {
		t.Fatalf("inspect: %v", err)
	}
	if snap != (UsageSnapshot{}) {
		t.Fatalf("fake usage should be zero, got %+v", snap)
	}
}

func Test_Memory_recreate_replaces(t *testing.T) {
	m := NewMemoryBackend()
	ctx := context.Background()
	first, err := m.CreateContainer(ctx, "w1", Limits{CPUCores: 0.2, MemMB: 800})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	second, err := m.CreateContainer(ctx, "w1", Limits{CPUCores: 0.5, MemMB: 1000})
	if err != nil {
		t.Fatalf("recreate: %v", err)
	}
	if first == second {
		t.Fatal("recreate should mint a new id")
	}
	if _, ok := m.LimitsOf(first); ok {
		t.Fatal("old container should be gone")
	}
}

func Test_Memory_canned_result(t *testing.T) {
	m := NewMemoryBackend()
	ctx := context.Background()
	id, _ := m.CreateContainer(ctx, "w1", Limits{CPUCores: 0.2, MemMB: 800})
	m.SetExecResult(id, ExecResult{Stdout: "out", Stderr: "err", ExitCode: 3})
	res, err := m.ExecCommand(ctx, id, []string{"false"})
	if err != nil {
		t.Fatalf("exec: %v", err)
	}
	if res.Stdout != "out" || res.Stderr != "err" || res.ExitCode != 3 {
		t.Fatalf("got %+v", res)
	}
}

func Test_Memory_unknown_container(t *testing.T) {
	m := NewMemoryBackend()
	ctx := context.Background()
	if _, err := m.ExecCommand(ctx, "nope", []string{"x"}); err == nil {
		t.Fatal("exec unknown must error")
	}
	if err := m.KillContainer(ctx, "nope"); err == nil {
		t.Fatal("kill unknown must error")
	}
	if _, err := m.InspectUsage(ctx, "nope"); err == nil {
		t.Fatal("inspect unknown must error")
	}
	if _, ok := m.LimitsOf("nope"); ok {
		t.Fatal("limits unknown must miss")
	}
	if m.Killed("nope") {
		t.Fatal("unknown must not read killed")
	}
}

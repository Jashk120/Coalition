// Package backend — in-memory fake used by all unit tests.
package backend

import (
	"context"
	"fmt"
	"strings"
	"sync"
)

// MemoryBackend is a mutex-guarded fake ContainerBackend. Exec output is
// canned per container; kills are recorded for enforcement assertions.
type MemoryBackend struct {
	mu       sync.RWMutex
	seq      int
	byID     map[string]*fakeContainer
	byName   map[string]string
	killed   map[string]bool
	execOut  map[string]ExecResult
	execHist map[string][][]string
}

type fakeContainer struct {
	id     string
	name   string
	limits Limits
}

// NewMemoryBackend builds an empty fake.
func NewMemoryBackend() *MemoryBackend {
	return &MemoryBackend{
		byID:     make(map[string]*fakeContainer),
		byName:   make(map[string]string),
		killed:   make(map[string]bool),
		execOut:  make(map[string]ExecResult),
		execHist: make(map[string][][]string),
	}
}

// CreateContainer records a container, replacing any same-named one so
// re-allocate stays idempotent.
func (m *MemoryBackend) CreateContainer(_ context.Context, name string, lim Limits) (string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if old, ok := m.byName[name]; ok {
		delete(m.byID, old)
		delete(m.killed, old)
	}
	m.seq++
	id := fmt.Sprintf("fake-%d", m.seq)
	m.byID[id] = &fakeContainer{id: id, name: name, limits: lim}
	m.byName[name] = id
	return id, nil
}

// SetExecResult programs canned output for a container.
func (m *MemoryBackend) SetExecResult(containerID string, res ExecResult) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.execOut[containerID] = res
}

// ExecCommand returns the canned result, defaulting to exit 0 echo of cmd.
func (m *MemoryBackend) ExecCommand(_ context.Context, containerID string, cmd []string) (ExecResult, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, ok := m.byID[containerID]; !ok {
		return ExecResult{}, fmt.Errorf("container %s: %w", containerID, ErrNoSuchContainer)
	}
	m.execHist[containerID] = append(m.execHist[containerID], cmd)
	if res, ok := m.execOut[containerID]; ok {
		return res, nil
	}
	return ExecResult{Stdout: "fake exec: " + strings.Join(cmd, " ")}, nil
}

// KillContainer marks a container killed.
func (m *MemoryBackend) KillContainer(_ context.Context, containerID string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, ok := m.byID[containerID]; !ok {
		return fmt.Errorf("container %s: %w", containerID, ErrNoSuchContainer)
	}
	m.killed[containerID] = true
	return nil
}

// Killed reports whether KillContainer was invoked for an ID.
func (m *MemoryBackend) Killed(containerID string) bool {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.killed[containerID]
}

// InspectUsage returns zeros; the fake has no cgroup telemetry.
func (m *MemoryBackend) InspectUsage(_ context.Context, containerID string) (UsageSnapshot, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	if _, ok := m.byID[containerID]; !ok {
		return UsageSnapshot{}, fmt.Errorf("container %s: %w", containerID, ErrNoSuchContainer)
	}
	return UsageSnapshot{}, nil
}

// LimitsOf exposes recorded limits for assertions.
func (m *MemoryBackend) LimitsOf(containerID string) (Limits, bool) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	c, ok := m.byID[containerID]
	if !ok {
		return Limits{}, false
	}
	return c.limits, true
}

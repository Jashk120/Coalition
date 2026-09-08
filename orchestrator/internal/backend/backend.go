// Package backend abstracts container operations behind ContainerBackend so
// unit tests run against the in-memory fake and only gated tests touch a
// real Docker daemon.
package backend

import "context"

// Limits describes the resource envelope for one wallet container.
type Limits struct {
	CPUCores float64
	MemMB    int64
}

// ExecResult is the outcome of running a command inside a container.
type ExecResult struct {
	Stdout   string
	Stderr   string
	ExitCode int
}

// UsageSnapshot is a point-in-time resource reading for a container.
type UsageSnapshot struct {
	MemBytes   int64
	CPUPercent float64
}

// ContainerBackend creates, executes in, kills, and inspects wallet containers.
// Implementations must honor ctx cancellation on every method.
type ContainerBackend interface {
	CreateContainer(ctx context.Context, name string, lim Limits) (string, error)
	ExecCommand(ctx context.Context, containerID string, cmd []string) (ExecResult, error)
	KillContainer(ctx context.Context, containerID string) error
	InspectUsage(ctx context.Context, containerID string) (UsageSnapshot, error)
}

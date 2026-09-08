package backend

import "errors"

var (
	// ErrNoSuchContainer is returned when an operation names an unknown container.
	ErrNoSuchContainer = errors.New("backend: no such container")
	// ErrDaemon is returned when the Docker Engine API cannot be reached.
	ErrDaemon = errors.New("backend: docker daemon error")
)

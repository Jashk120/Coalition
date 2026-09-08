// Package domain holds branded primitives and smart constructors for the
// orchestrator. Values crossing an HTTP boundary are raw strings there;
// inside the domain they exist only as validated types built by New* funcs.
package domain

import (
	"errors"
	"fmt"
	"math"
	"strings"
)

var (
	// ErrInvalidWallet is returned when a string is not a 0x EVM address.
	ErrInvalidWallet = errors.New("domain: invalid wallet address")
	// ErrInvalidQuota is returned for non-positive resource quantities.
	ErrInvalidQuota = errors.New("domain: invalid quota quantity")
)

// WalletAddress is a validated 0x-prefixed EVM address. The zero value is
// invalid; construct via NewWalletAddress.
type WalletAddress struct {
	raw string
}

// NewWalletAddress parses s into a WalletAddress, lowercasing hex digits.
// It accepts exactly 0x followed by 40 hex characters.
func NewWalletAddress(s string) (WalletAddress, error) {
	s = strings.TrimSpace(s)
	if len(s) != 42 || !strings.HasPrefix(s, "0x") {
		return WalletAddress{}, fmt.Errorf("address %q: %w", s, ErrInvalidWallet)
	}
	body := s[2:]
	for i := 0; i < len(body); i++ {
		c := body[i]
		if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f' || c >= 'A' && c <= 'F') {
			return WalletAddress{}, fmt.Errorf("address %q: %w", s, ErrInvalidWallet)
		}
	}
	return WalletAddress{raw: "0x" + strings.ToLower(body)}, nil
}

// String returns the canonical lowercase address.
func (w WalletAddress) String() string { return w.raw }

// IsZero reports whether this is the invalid zero value.
func (w WalletAddress) IsZero() bool { return w.raw == "" }

// Entitlement is a wallet's paid capacity slice: CPU cores and memory MB.
type Entitlement struct {
	CPU   float64
	MemMB int64
}

// NewEntitlement validates a capacity slice. Both dimensions must be positive.
// NaN, +Inf, and -Inf are rejected: float comparisons alone would let NaN
// slip past range checks (every comparison with NaN is false) and Inf would
// defeat pool-total accounting downstream.
func NewEntitlement(cpu float64, memMB int64) (Entitlement, error) {
	if math.IsNaN(cpu) || math.IsInf(cpu, 0) || cpu <= 0 || memMB <= 0 {
		return Entitlement{}, fmt.Errorf("cpu=%v memMB=%d: %w", cpu, memMB, ErrInvalidQuota)
	}
	return Entitlement{CPU: cpu, MemMB: memMB}, nil
}

// Usage is cumulative consumption: CU-seconds and MB-hours metered by /run.
type Usage struct {
	CUSeconds float64
	MBHours   float64
}

// NewUsage validates cumulative usage counters (never negative, never NaN/Inf).
func NewUsage(cuSeconds, mbHours float64) (Usage, error) {
	if math.IsNaN(cuSeconds) || math.IsInf(cuSeconds, 0) ||
		math.IsNaN(mbHours) || math.IsInf(mbHours, 0) ||
		cuSeconds < 0 || mbHours < 0 {
		return Usage{}, fmt.Errorf("cuSeconds=%v mbHours=%v: %w", cuSeconds, mbHours, ErrInvalidQuota)
	}
	return Usage{CUSeconds: cuSeconds, MBHours: mbHours}, nil
}

// Package money converts decimal USDC strings to 6-decimal atomic units and
// derives cost-basis resale rates from pool funding config.
package money

import (
	"errors"
	"fmt"
	"math"
	"math/big"
	"strconv"
	"strings"
)

var (
	// ErrInvalidAmount is returned for malformed decimal amount strings.
	ErrInvalidAmount = errors.New("money: invalid decimal amount")
	// ErrInvalidTotal is returned for non-positive division denominators.
	ErrInvalidTotal = errors.New("money: total must be positive")
)

// Decimals is the USDC ERC-20 view decimals used for atomic conversion.
const Decimals = 6

// ParseAtomic converts a decimal USDC string (e.g. "10.00") to atomic units
// (10.00 -> 10000000). It rejects empty input, signs, more than 6 fractional
// digits, and non-digit characters. Never use float64 here: binary floats
// cannot represent decimal fractions exactly and would corrupt payouts.
func ParseAtomic(s string) (*big.Int, error) {
	s = strings.TrimSpace(s)
	if s == "" {
		return nil, fmt.Errorf("empty amount: %w", ErrInvalidAmount)
	}
	intPart := s
	fracPart := ""
	if i := strings.IndexByte(s, '.'); i >= 0 {
		intPart = s[:i]
		fracPart = s[i+1:]
	}
	if intPart == "" || fracPart == "" && strings.Contains(s, ".") {
		return nil, fmt.Errorf("amount %q: %w", s, ErrInvalidAmount)
	}
	for _, c := range intPart {
		if c < '0' || c > '9' {
			return nil, fmt.Errorf("amount %q: %w", s, ErrInvalidAmount)
		}
	}
	if len(fracPart) > Decimals {
		return nil, fmt.Errorf("amount %q exceeds %d decimals: %w", s, Decimals, ErrInvalidAmount)
	}
	for _, c := range fracPart {
		if c < '0' || c > '9' {
			return nil, fmt.Errorf("amount %q: %w", s, ErrInvalidAmount)
		}
	}
	padded := fracPart + strings.Repeat("0", Decimals-len(fracPart))
	digits := intPart + padded
	digits = strings.TrimLeft(digits, "0")
	if digits == "" {
		return nil, fmt.Errorf("amount %q is zero: %w", s, ErrInvalidAmount)
	}
	v, ok := new(big.Int).SetString(digits, 10)
	if !ok {
		return nil, fmt.Errorf("amount %q: %w", s, ErrInvalidAmount)
	}
	return v, nil
}

// RatePerMB returns floor(targetAtomic / (2*totalMB)): the cost-basis resale
// rate per MB in atomic units.
//
// Rationale: the funding target pays for both dimensions jointly — one
// dollar of pool target buys a slice that is simultaneously some MB and some
// CU, not MB or CU alone. Pricing each dimension at the FULL target would
// double-charge: the SDK composes quotes as mb*rateMB + cu*rateCU, so each
// leg must price half the target for the sum to land on the funded share.
// With $10 target, 4096MB, 1CU: rateMB = 1220, rateCU = 5000000, and the
// equal slice 819MB + 0.2CU costs 819*1220 + 0.2*5000000 = 1999180 atomic,
// ≈ $2.00 = the seller's funded share (dust remainder stays with the pool).
//
// Dust note: integer division truncates the remainder (targetAtomic mod
// 2*totalMB). That dust stays unpriced and is absorbed by the pool rather
// than quoted to buyers. Quoting a rounded-up rate would overcharge.
func RatePerMB(targetAtomic *big.Int, totalMB int64) (*big.Int, error) {
	if totalMB <= 0 {
		return nil, fmt.Errorf("totalMB=%d: %w", totalMB, ErrInvalidTotal)
	}
	half := new(big.Int).Quo(targetAtomic, big.NewInt(2))
	return new(big.Int).Quo(half, big.NewInt(totalMB)), nil
}

// RatePerCU returns floor(targetAtomic / (2*totalCU)) for a possibly
// fractional total CPU count. NaN and Inf totals are rejected before
// formatting: NaN would otherwise format to "NaN" and fail opaquely, while
// +Inf formats to "+Inf" with the same problem. The halving rationale and
// dust note from RatePerMB apply identically: the truncated remainder is
// absorbed by the pool, never quoted.
func RatePerCU(targetAtomic *big.Int, totalCU float64) (*big.Int, error) {
	if math.IsNaN(totalCU) || math.IsInf(totalCU, 0) || totalCU <= 0 {
		return nil, fmt.Errorf("totalCU=%v: %w", totalCU, ErrInvalidTotal)
	}
	denom, ok := new(big.Rat).SetString(strconv.FormatFloat(totalCU, 'g', -1, 64))
	if !ok {
		return nil, fmt.Errorf("totalCU=%v: %w", totalCU, ErrInvalidTotal)
	}
	num := new(big.Rat).SetInt(new(big.Int).Quo(targetAtomic, big.NewInt(2)))
	q := new(big.Rat).Quo(num, denom)
	// big.Rat keeps the denominator positive, so truncated division of
	// non-negative values is the floor.
	return new(big.Int).Quo(q.Num(), q.Denom()), nil
}

// FormatAtomic renders atomic units back to a decimal USDC string.
func FormatAtomic(v *big.Int) string {
	neg := v.Sign() < 0
	abs := new(big.Int).Abs(v)
	s := abs.String()
	for len(s) <= Decimals {
		s = "0" + s
	}
	intPart := s[:len(s)-Decimals]
	fracPart := strings.TrimRight(s[len(s)-Decimals:], "0")
	out := intPart
	if fracPart != "" {
		out += "." + fracPart
	}
	if neg {
		out = "-" + out
	}
	return out
}

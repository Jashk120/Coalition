package money

import (
	"errors"
	"math"
	"math/big"
	"testing"
)

func Test_ParseAtomic(t *testing.T) {
	tests := []struct {
		name  string
		in    string
		want  string
		isErr bool
	}{
		{"round dollars", "10.00", "10000000", false},
		{"no fraction", "2", "2000000", false},
		{"micro unit", "0.000001", "1", false},
		{"half", "1.50", "1500000", false},
		{"padded input", "  1.50  ", "1500000", false},
		{"empty", "", "", true},
		{"letters", "ten", "", true},
		{"NaN string", "NaN", "", true},
		{"Inf string", "Inf", "", true},
		{"infinity string", "infinity", "", true},
		{"too precise", "10.0000001", "", true},
		{"negative", "-1", "", true},
		{"dangling dot", "1.", "", true},
		{"no int part", ".5", "", true},
		{"zero", "0", "", true},
		{"zero decimal", "0.00", "", true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := ParseAtomic(tt.in)
			if tt.isErr {
				if err == nil {
					t.Fatal("expected error")
				}
				if !errors.Is(err, ErrInvalidAmount) {
					t.Fatalf("should wrap ErrInvalidAmount, got %v", err)
				}
				return
			}
			if err != nil {
				t.Fatalf("parse: %v", err)
			}
			if got.String() != tt.want {
				t.Fatalf("got %s, want %s", got, tt.want)
			}
		})
	}
}

func Test_RatePerMB(t *testing.T) {
	target := big.NewInt(10000000)
	got, err := RatePerMB(target, 4096)
	if err != nil {
		t.Fatalf("rate: %v", err)
	}
	if got.String() != "1220" {
		t.Fatalf("got %s, want 1220 (half-target cost model)", got)
	}
	if _, err := RatePerMB(target, 0); !errors.Is(err, ErrInvalidTotal) {
		t.Fatalf("zero total should wrap ErrInvalidTotal, got %v", err)
	}
	if _, err := RatePerMB(target, -5); !errors.Is(err, ErrInvalidTotal) {
		t.Fatalf("negative total should wrap ErrInvalidTotal, got %v", err)
	}
}

func Test_RatePerCU(t *testing.T) {
	target := big.NewInt(10000000)
	got, err := RatePerCU(target, 1)
	if err != nil {
		t.Fatalf("rate: %v", err)
	}
	if got.String() != "5000000" {
		t.Fatalf("got %s, want 5000000 (half-target cost model)", got)
	}
	got, err = RatePerCU(target, 0.2)
	if err != nil {
		t.Fatalf("rate: %v", err)
	}
	if got.String() != "25000000" {
		t.Fatalf("got %s, want 25000000", got)
	}
	if _, err := RatePerCU(target, 0); !errors.Is(err, ErrInvalidTotal) {
		t.Fatalf("zero total should wrap ErrInvalidTotal, got %v", err)
	}
	for _, tc := range []struct {
		name string
		cu   float64
	}{
		{"NaN", math.NaN()},
		{"+Inf", math.Inf(1)},
		{"-Inf", math.Inf(-1)},
		{"negative", -0.5},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := RatePerCU(target, tc.cu); !errors.Is(err, ErrInvalidTotal) {
				t.Fatalf("should wrap ErrInvalidTotal, got %v", err)
			}
		})
	}
}

func Test_EqualSliceCost_matches_funded_share(t *testing.T) {
	target := big.NewInt(10000000)
	rateMB, err := RatePerMB(target, 4096)
	if err != nil {
		t.Fatalf("rateMB: %v", err)
	}
	rateCU, err := RatePerCU(target, 1)
	if err != nil {
		t.Fatalf("rateCU: %v", err)
	}
	mbLeg := new(big.Int).Mul(rateMB, big.NewInt(819))
	cuLeg := new(big.Rat).Mul(new(big.Rat).SetInt(rateCU), big.NewRat(2, 10))
	cuCost := new(big.Int).Quo(cuLeg.Num(), cuLeg.Denom())
	cost := new(big.Int).Add(mbLeg, cuCost)
	share := new(big.Int).Quo(target, big.NewInt(5))
	gap := new(big.Int).Sub(share, cost)
	if gap.Sign() < 0 || gap.Cmp(big.NewInt(8192)) > 0 {
		t.Fatalf("equal-slice cost %s vs funded share %s: gap %s exceeds dust bound", cost, share, gap)
	}
}

func Test_FormatAtomic(t *testing.T) {
	tests := []struct {
		in   int64
		want string
	}{
		{1220, "0.00122"},
		{10000000, "10"},
		{2000000, "2"},
		{1500000, "1.5"},
	}
	for _, tt := range tests {
		if got := FormatAtomic(big.NewInt(tt.in)); got != tt.want {
			t.Errorf("FormatAtomic(%d) = %q, want %q", tt.in, got, tt.want)
		}
	}
}

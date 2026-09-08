package domain

import (
	"errors"
	"math"
	"testing"
)

func Test_NewWalletAddress(t *testing.T) {
	tests := []struct {
		name  string
		in    string
		want  string
		isErr bool
	}{
		{"lowercase", "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266", "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266", false},
		{"mixed case lowercased", "0xF39Fd6e51aad88F6F4ce6aB8827279cffFb92266", "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266", false},
		{"padded", "  0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266\n", "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266", false},
		{"missing prefix", "f39fd6e51aad88f6f4ce6ab8827279cfffb92266", "", true},
		{"too short", "0x1234", "", true},
		{"too long", "0xf39fd6e51aad88f6f4ce6ab8827279cfffb9226600", "", true},
		{"non hex", "0xZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ", "", true},
		{"empty", "", "", true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := NewWalletAddress(tt.in)
			if tt.isErr {
				if err == nil {
					t.Fatal("expected error")
				}
				if !errors.Is(err, ErrInvalidWallet) {
					t.Fatalf("should wrap ErrInvalidWallet, got %v", err)
				}
				return
			}
			if err != nil {
				t.Fatalf("parse: %v", err)
			}
			if got.String() != tt.want {
				t.Fatalf("got %q, want %q", got, tt.want)
			}
			if got.IsZero() {
				t.Fatal("parsed address must not be zero")
			}
		})
	}
	if (WalletAddress{}).IsZero() != true {
		t.Fatal("zero value must report IsZero")
	}
}

func Test_NewEntitlement(t *testing.T) {
	if _, err := NewEntitlement(0.2, 800); err != nil {
		t.Fatalf("valid: %v", err)
	}
	for _, tc := range []struct {
		name string
		cpu  float64
		mem  int64
	}{
		{"zero cpu", 0, 800},
		{"negative cpu", -0.1, 800},
		{"zero mem", 0.2, 0},
		{"negative mem", 0.2, -1},
		{"NaN cpu", math.NaN(), 800},
		{"+Inf cpu", math.Inf(1), 800},
		{"-Inf cpu", math.Inf(-1), 800},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := NewEntitlement(tc.cpu, tc.mem); !errors.Is(err, ErrInvalidQuota) {
				t.Fatalf("should wrap ErrInvalidQuota, got %v", err)
			}
		})
	}
}

func Test_NewUsage(t *testing.T) {
	if _, err := NewUsage(0, 0); err != nil {
		t.Fatalf("zero usage is valid: %v", err)
	}
	for _, tc := range []struct {
		name string
		cu   float64
		mb   float64
	}{
		{"negative cu", -1, 0},
		{"negative mb", 0, -0.5},
		{"NaN cu", math.NaN(), 0},
		{"NaN mb", 0, math.NaN()},
		{"+Inf cu", math.Inf(1), 0},
		{"-Inf mb", 0, math.Inf(-1)},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := NewUsage(tc.cu, tc.mb); !errors.Is(err, ErrInvalidQuota) {
				t.Fatalf("should wrap ErrInvalidQuota, got %v", err)
			}
		})
	}
}

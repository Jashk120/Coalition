// Package api serves the orchestrator HTTP surface with one error funnel.
package api

import (
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"

	"github.com/Jashk120/Coalition/orchestrator/internal/domain"
	"github.com/Jashk120/Coalition/orchestrator/internal/store"
)

// APIError is a typed service error carrying its HTTP status. Handlers wrap
// domain failures into these; writeJSONError maps them in one place.
type APIError struct {
	Status  int    `json:"-"`
	Code    string `json:"code"`
	Message string `json:"message"`
}

// Error implements error.
func (e *APIError) Error() string { return e.Code + ": " + e.Message }

func badRequest(msg string) *APIError {
	return &APIError{Status: http.StatusBadRequest, Code: "bad_request", Message: msg}
}

func notFound(msg string) *APIError {
	return &APIError{Status: http.StatusNotFound, Code: "not_found", Message: msg}
}

func quotaExceeded(msg string) *APIError {
	return &APIError{Status: http.StatusTooManyRequests, Code: "quota_exceeded", Message: msg}
}

func insufficientQuota(msg string) *APIError {
	return &APIError{Status: http.StatusConflict, Code: "insufficient_quota", Message: msg}
}

func unauthorized(msg string) *APIError {
	return &APIError{Status: http.StatusUnauthorized, Code: "unauthorized", Message: msg}
}

func forbidden(msg string) *APIError {
	return &APIError{Status: http.StatusForbidden, Code: "forbidden", Message: msg}
}

func poolSettled(msg string) *APIError {
	return &APIError{Status: http.StatusConflict, Code: "pool_settled", Message: msg}
}

func poolExhausted(msg string) *APIError {
	return &APIError{Status: http.StatusConflict, Code: "pool_exhausted", Message: msg}
}

func paymentRequired(msg string) *APIError {
	return &APIError{Status: http.StatusPaymentRequired, Code: "payment_required", Message: msg}
}

func duplicatePayment(msg string) *APIError {
	return &APIError{Status: http.StatusConflict, Code: "duplicate_payment", Message: msg}
}

func poolClosed(msg string) *APIError {
	return &APIError{Status: http.StatusConflict, Code: "pool_closed", Message: msg}
}

// writeJSONError is the single error funnel: every handler error passes here.
func writeJSONError(w http.ResponseWriter, logger *slog.Logger, err error) {
	var apiErr *APIError
	if errors.As(err, &apiErr) {
		writeJSON(w, apiErr.Status, apiErr)
		return
	}
	switch {
	case errors.Is(err, store.ErrUnknownWallet):
		writeJSON(w, http.StatusNotFound, notFound("unknown wallet"))
		return
	case errors.Is(err, store.ErrQuotaExceeded):
		writeJSON(w, http.StatusTooManyRequests, quotaExceeded(err.Error()))
		return
	case errors.Is(err, store.ErrInsufficientQuota):
		writeJSON(w, http.StatusConflict, insufficientQuota(err.Error()))
		return
	case errors.Is(err, store.ErrDuplicatePayment):
		writeJSON(w, http.StatusConflict, duplicatePayment(err.Error()))
		return
	case errors.Is(err, store.ErrPoolExhausted):
		writeJSON(w, http.StatusConflict, poolExhausted(err.Error()))
		return
	case errors.Is(err, store.ErrTokenInvalid):
		writeJSON(w, http.StatusUnauthorized, unauthorized(err.Error()))
		return
	case errors.Is(err, store.ErrTokenRevoked),
		errors.Is(err, store.ErrTokenExpired):
		writeJSON(w, http.StatusForbidden, forbidden(err.Error()))
		return
	case errors.Is(err, domain.ErrInvalidWallet),
		errors.Is(err, domain.ErrInvalidQuota):
		writeJSON(w, http.StatusBadRequest, badRequest(err.Error()))
		return
	default:
		logger.Error("unmapped error", slog.Any("err", err))
		writeJSON(w, http.StatusInternalServerError, &APIError{
			Status:  http.StatusInternalServerError,
			Code:    "internal",
			Message: "internal error",
		})
	}
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func decodeJSON(r *http.Request, v any) error {
	defer func() {
		_ = r.Body.Close()
	}()
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	return dec.Decode(v)
}

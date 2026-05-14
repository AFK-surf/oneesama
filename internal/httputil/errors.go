package httputil

import (
	"net/http"

	"github.com/gin-gonic/gin"
)

const (
	CodeInvalidRequest = "invalid_request"
	CodeUnauthorized   = "unauthorized"
	CodeConflict       = "conflict"
	CodeNotFound       = "not_found"
	CodeInternal       = "internal_error"
)

type APIError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
	Details any    `json:"details,omitempty"`
}

type ErrorEnvelope struct {
	Error APIError `json:"error"`
}

type HTTPError struct {
	Status  int
	Payload APIError
}

func (e *HTTPError) Error() string {
	return e.Payload.Message
}

func AbortWithError(c *gin.Context, err *HTTPError) {
	c.AbortWithStatusJSON(err.Status, ErrorEnvelope{Error: err.Payload})
}

func InvalidRequestError(message string, details any) *HTTPError {
	return &HTTPError{
		Status: http.StatusBadRequest,
		Payload: APIError{
			Code:    CodeInvalidRequest,
			Message: message,
			Details: details,
		},
	}
}

func UnauthorizedError(message string, details any) *HTTPError {
	return &HTTPError{
		Status: http.StatusUnauthorized,
		Payload: APIError{
			Code:    CodeUnauthorized,
			Message: message,
			Details: details,
		},
	}
}

func ConflictError(message string, details any) *HTTPError {
	return &HTTPError{
		Status: http.StatusConflict,
		Payload: APIError{
			Code:    CodeConflict,
			Message: message,
			Details: details,
		},
	}
}

func NotFoundError(message string, details any) *HTTPError {
	return &HTTPError{
		Status: http.StatusNotFound,
		Payload: APIError{
			Code:    CodeNotFound,
			Message: message,
			Details: details,
		},
	}
}

func InternalServerError(message string, details any) *HTTPError {
	return &HTTPError{
		Status: http.StatusInternalServerError,
		Payload: APIError{
			Code:    CodeInternal,
			Message: message,
			Details: details,
		},
	}
}

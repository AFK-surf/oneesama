package httpserver

import (
	"context"
	"net/http"
)

type ManagedServer struct {
	Server   *http.Server
	Shutdown func(context.Context) error
}

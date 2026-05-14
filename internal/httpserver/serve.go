package httpserver

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"
)

func Serve(logger *slog.Logger, managed *ManagedServer) error {
	if managed == nil || managed.Server == nil {
		return errors.New("managed server is required")
	}

	server := managed.Server
	errCh := make(chan error, 1)
	go func() {
		if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			errCh <- fmt.Errorf("listen %s: %w", server.Addr, err)
		}
	}()

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)

	select {
	case sig := <-stop:
		logger.Info("shutdown signal received", "signal", sig.String())
	case err := <-errCh:
		return err
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := server.Shutdown(ctx); err != nil {
		return fmt.Errorf("shutdown %s: %w", server.Addr, err)
	}
	if managed.Shutdown != nil {
		if err := managed.Shutdown(ctx); err != nil {
			return fmt.Errorf("shutdown cleanup %s: %w", server.Addr, err)
		}
	}
	return nil
}

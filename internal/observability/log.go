package observability

import (
	"log/slog"
	"os"
	"strings"
)

func InitLogger(level string, format string) *slog.Logger {
	programLevel := new(slog.LevelVar)
	programLevel.Set(parseLevel(level))

	options := &slog.HandlerOptions{Level: programLevel}
	switch strings.ToLower(strings.TrimSpace(format)) {
	case "text":
		return slog.New(slog.NewTextHandler(os.Stdout, options))
	default:
		return slog.New(slog.NewJSONHandler(os.Stdout, options))
	}
}

func parseLevel(level string) slog.Level {
	switch strings.ToLower(strings.TrimSpace(level)) {
	case "debug":
		return slog.LevelDebug
	case "warn", "warning":
		return slog.LevelWarn
	case "error":
		return slog.LevelError
	default:
		return slog.LevelInfo
	}
}

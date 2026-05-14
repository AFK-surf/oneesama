package httpserver

import (
	"log/slog"
	"time"

	"github.com/gin-gonic/gin"
)

func requestLogMiddleware(logger *slog.Logger) gin.HandlerFunc {
	return func(c *gin.Context) {
		startedAt := time.Now()
		c.Next()

		logger.Info("http request",
			slog.String("method", c.Request.Method),
			slog.String("path", c.Request.URL.Path),
			slog.Int("status", c.Writer.Status()),
			slog.Duration("duration", time.Since(startedAt)),
			slog.String("client_ip", c.ClientIP()),
		)
	}
}

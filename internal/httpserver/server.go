package httpserver

import (
	"log/slog"
	"net/http"
	"time"

	"github.com/AFK-surf/oneesama/internal/internalauth"
	"github.com/AFK-surf/oneesama/pkg/contract"
	"github.com/AFK-surf/oneesama/pkg/version"
	"github.com/gin-contrib/cors"
	"github.com/gin-gonic/gin"
)

type RouteRegistrar interface {
	RegisterRoutes(rg *gin.RouterGroup)
}

func New(serviceName string, logger *slog.Logger, allowedOrigins []string, registrars ...RouteRegistrar) *gin.Engine {
	router := gin.New()
	router.Use(gin.Recovery())
	router.Use(requestLogMiddleware(logger))
	router.Use(cors.New(cors.Config{
		AllowOrigins:     normalizeOrigins(allowedOrigins),
		AllowMethods:     []string{http.MethodGet, http.MethodPost, http.MethodPut, http.MethodPatch, http.MethodDelete, http.MethodOptions},
		AllowHeaders:     []string{"Authorization", "Content-Type", "X-Requested-With", internalauth.HeaderName},
		AllowCredentials: true,
		MaxAge:           12 * time.Hour,
	}))

	router.GET("/healthz", func(c *gin.Context) {
		c.JSON(http.StatusOK, contract.HealthResponse{
			OK:      true,
			Service: serviceName,
			Version: version.Version,
		})
	})
	router.GET("/health", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{"status": "ok"})
	})

	api := router.Group("/")
	for _, registrar := range registrars {
		registrar.RegisterRoutes(api)
	}

	return router
}

func normalizeOrigins(origins []string) []string {
	if len(origins) == 0 {
		return []string{"*"}
	}
	return origins
}

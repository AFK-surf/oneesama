package slackagent

import (
	"net/http"
	"strconv"

	"github.com/gin-gonic/gin"
)

type Handler struct {
	service *Service
}

func NewHandler(service *Service) *Handler {
	return &Handler{service: service}
}

func (h *Handler) handleStatus(c *gin.Context) {
	c.JSON(http.StatusOK, h.service.Status())
}

func (h *Handler) handleHeartbeatContext(c *gin.Context) {
	contextText, err := h.service.BuildHeartbeatContext(c.Request.Context())
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"ok": false, "error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true, "context": contextText})
}

func (h *Handler) handleMemorySearch(c *gin.Context) {
	limit, _ := strconv.Atoi(c.Query("limit"))
	ctx := c.Request.Context()
	c.JSON(http.StatusOK, gin.H{
		"ok":      true,
		"summary": h.service.MemorySummaryContext(ctx),
		"results": h.service.SearchLocalMemoryContext(ctx, c.Query("q"), limit),
	})
}

func (h *Handler) RegisterRoutes(rg *gin.RouterGroup) {
	slack := rg.Group("/slack")
	slack.GET("/status", h.handleStatus)
	slack.GET("/install", h.handleInstall)
	slack.GET("/oauth", h.handleOAuthCallback)

	commands := slack.Group("/commands")
	commands.Use(h.requireSlackSignature)
	commands.POST("/avatar", h.handleAvatarCommand)

	events := slack.Group("/events")
	events.Use(h.requireSlackSignature)
	events.POST("", h.handleEvents)

	interactions := slack.Group("/")
	interactions.Use(h.requireSlackSignature)
	interactions.POST("/interactions", h.handleInteraction)
	interactions.POST("/actions", h.handleInteraction)

	internalSlack := slack.Group("/")
	internalSlack.Use(h.requireInternalAuth)
	internalSlack.POST("/post-message", h.handlePostMessage)
	internalSlack.POST("/workspace/bootstrap", h.handleWorkspaceBootstrap)
	internalSlack.POST("/validate", h.handleRuntimeValidate)
	internalSlack.GET("/app/manifest", h.handleAppManifest)
	internalSlack.POST("/app/manifest/validate", h.handleValidateAppManifest)
	internalSlack.GET("/installations", h.handleListInstallations)
	internalSlack.GET("/installations/resolve", h.handleResolveInstallation)
	internalSlack.GET("/inbound/status", h.handleInboundStatus)
	internalSlack.POST("/inbound/flush", h.handleInboundFlush)
	internalSlack.POST("/scanner/sweep", h.handleScannerSweep)
	internalSlack.POST("/scanner/compact", h.handleScannerCompact)
	internalSlack.GET("/triage/status", h.handleTriageStatus)
	internalSlack.GET("/triage/audit", h.handleTriageAudit)
	internalSlack.POST("/triage/run", h.handleTriageRun)
	internalSlack.POST("/triage/probe", h.handleTriageProbe)
	internalSlack.GET("/daily-report/status", h.handleDailyReportStatus)
	internalSlack.POST("/daily-report/run", h.handleDailyReportRun)
	internalSlack.GET("/followups/status", h.handleFollowupStatus)
	internalSlack.POST("/followups/create", h.handleFollowupCreate)
	internalSlack.POST("/followups/surface", h.handleFollowupSurface)
	internalSlack.GET("/heartbeat/context", h.handleHeartbeatContext)
	internalSlack.GET("/tools/parity", h.handleSlackToolsParity)
	internalSlack.POST("/tools/call", h.handleSlackToolCall)

	internal := rg.Group("/")
	internal.Use(h.requireInternalAuth)
	internal.GET("/memory", h.handleMemorySearch)
	internal.GET("/tools/parity", h.handleSlackToolsParity)
	internal.POST("/tools/call", h.handleSlackToolCall)
	internal.GET("/canvas/published", h.handleListPublishedCanvas)
	internal.POST("/canvas/publish", h.handlePublishCanvas)
	internal.POST("/post-meeting/publish", h.handlePublishCanvas)

	webhooks := rg.Group("/webhooks")
	webhooks.POST("/meeting-result", h.handleMeetingWebhook)
}

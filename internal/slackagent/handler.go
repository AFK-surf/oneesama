package slackagent

import "github.com/gin-gonic/gin"

type Handler struct {
	service *Service
}

func NewHandler(service *Service) *Handler {
	return &Handler{service: service}
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
	internalSlack.POST("/triage/run", h.handleTriageRun)
	internalSlack.GET("/followups/status", h.handleFollowupStatus)
	internalSlack.POST("/followups/create", h.handleFollowupCreate)
	internalSlack.POST("/followups/surface", h.handleFollowupSurface)
	internalSlack.GET("/heartbeat/context", h.handleHeartbeatContext)

	internal := rg.Group("/")
	internal.Use(h.requireInternalAuth)
	internal.GET("/memory", h.handleMemorySearch)
	internal.GET("/canvas/published", h.handleListPublishedCanvas)
	internal.POST("/canvas/publish", h.handlePublishCanvas)
	internal.POST("/post-meeting/publish", h.handlePostMeetingPublish)

	webhooks := rg.Group("/webhooks")
	webhooks.POST("/meeting-result", h.handleMeetingWebhook)
}

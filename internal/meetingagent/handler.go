package meetingagent

import (
	"net/http"

	"github.com/AFK-surf/oneesama/internal/httputil"
	"github.com/gin-gonic/gin"
)

type Handler struct {
	service *Service
}

func NewHandler(service *Service) *Handler {
	return &Handler{service: service}
}

func (h *Handler) RegisterRoutes(rg *gin.RouterGroup) {
	routes := rg.Group("/meetings")
	routes.Use(h.requireInternalAuth)
	h.registerMeetdRoutes(routes)
	routes.GET("/status", h.handleStatus)
	routes.GET("/sessions", h.handleListSessions)
	routes.GET("/session", h.handleGetSession)
	routes.POST("/session", h.handleUpsertSession)
	routes.DELETE("/session", h.handleDeleteSession)
	routes.GET("/artifacts", h.handleListArtifacts)
	routes.GET("/artifact", h.handleGetArtifact)
	routes.GET("/artifact/chat", h.handleGetArtifactChat)
	routes.POST("/post-process", h.handlePostProcess)
	routes.POST("/digest-webhook", h.handleDigestWebhook)

	join := rg.Group("/join")
	join.Use(h.requireInternalAuth)
	join.POST("/google-meet", h.handleJoinGoogleMeet)
	join.GET("/status", h.handleJoinStatus)
	join.POST("/stop", h.handleJoinStop)

	worker := rg.Group("/worker")
	worker.Use(h.requireInternalAuth)
	worker.POST("/report", h.handleWorkerReport)
	worker.POST("/delegate", h.handleWorkerDelegate)
	worker.POST("/status", h.handleWorkerStatus)
	worker.GET("/jobs", h.handleWorkerJobs)
	worker.POST("/poll-realtime", h.handleWorkerPollRealtime)
	worker.POST("/poll-slack", h.handleWorkerPollSlack)
	worker.POST("/mark-slack-delivered", h.handleWorkerMarkSlackDelivered)

	realtime := rg.Group("/realtime")
	realtime.Use(h.requireInternalAuth)
	realtime.GET("/config", h.handleRealtimeConfig)
	realtime.GET("/context-health", h.handleRealtimeContextHealth)
	realtime.POST("/client-secret", h.handleRealtimeClientSecret)

	tools := rg.Group("/tools")
	tools.Use(h.requireInternalAuth)
	tools.POST("/:name", h.handleRealtimeWorkspaceTool)

	dialog := rg.Group("/dialog")
	dialog.Use(h.requireInternalAuth)
	dialog.GET("/providers", h.handleDialogProviders)
	dialog.POST("/turn", h.handleDialogTurn)

	tts := rg.Group("/tts")
	tts.Use(h.requireInternalAuth)
	tts.POST("/synthesize", h.handleTTSSynthesize)

	screenShare := rg.Group("/screen-share")
	screenShare.Use(h.requireInternalAuth)
	screenShare.POST("/start", h.handleScreenShareStart)
	screenShare.POST("/present", h.handleScreenSharePresent)
	screenShare.POST("/video", h.handleScreenShareVideo)
	screenShare.POST("/apps", h.handleScreenShareApps)
	screenShare.POST("/app", h.handleScreenShareApp)
	screenShare.POST("/stop", h.handleScreenShareStop)

	rg.GET("/stage-media/video", h.handleStageMediaVideo)
}

func (h *Handler) handleStatus(c *gin.Context) {
	sessions, err := h.service.SessionSummary(c.Request.Context())
	if err != nil {
		httputil.AbortWithError(c, httputil.InternalServerError("load session summary failed", gin.H{"reason": err.Error()}))
		return
	}
	artifacts, err := h.service.ListArtifacts()
	if err != nil {
		httputil.AbortWithError(c, httputil.InternalServerError("load artifact summary failed", gin.H{"reason": err.Error()}))
		return
	}
	c.JSON(http.StatusOK, gin.H{
		"ok":      true,
		"service": "meeting-agent",
		"mode":    "go-rewrite-r6.2",
		"persistence": gin.H{
			"provider":   h.service.persistence.Provider,
			"dataDir":    h.service.persistence.DataDir,
			"sqlitePath": h.service.persistence.SQLitePath,
		},
		"internal_auth_configured": h.service.internalAuthKey != "",
		"artifacts": gin.H{
			"root_dir": h.service.pipeline.RootDir(),
			"count":    len(artifacts),
		},
		"sessions": sessions,
	})
}

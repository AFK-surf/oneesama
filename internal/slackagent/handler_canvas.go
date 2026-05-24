package slackagent

import (
	"net/http"

	"github.com/AFK-surf/oneesama/internal/httputil"
	"github.com/gin-gonic/gin"
)

type canvasPublishRequest struct {
	Artifact         CanvasArtifact `json:"artifact"`
	ArtifactID       string         `json:"artifact_id"`
	ID               string         `json:"id"`
	Title            string         `json:"title"`
	SummaryMarkdown  string         `json:"summary_markdown"`
	SummaryPath      string         `json:"summary_path"`
	NotificationText string         `json:"notification_text"`
	Destination      string         `json:"destination"`
	Channel          string         `json:"channel"`
	ThreadTS         string         `json:"thread_ts"`
	DedupKey         string         `json:"dedup_key"`
	WorkspaceID      string         `json:"workspace_id"`
	SnapshotTS       string         `json:"snapshot_ts"`
	CanvasID         string         `json:"canvas_id"`
	Operation        string         `json:"operation"`
	SectionID        string         `json:"section_id"`
	ForceSlackCanvas bool           `json:"force_slack_canvas"`
}

func (h *Handler) handleListPublishedCanvas(c *gin.Context) {
	published, err := h.service.ListPublishedCanvas()
	if err != nil {
		httputil.AbortWithError(c, httputil.InternalServerError("list published canvas", gin.H{"reason": err.Error()}))
		return
	}
	c.JSON(http.StatusOK, gin.H{
		"ok":        true,
		"published": published,
	})
}

func (h *Handler) handlePublishCanvas(c *gin.Context) {
	var request canvasPublishRequest
	if err := c.ShouldBindJSON(&request); err != nil {
		httputil.AbortWithError(c, httputil.InvalidRequestError("invalid canvas publish body", gin.H{"reason": err.Error()}))
		return
	}

	result, err := h.service.PublishCanvas(c.Request.Context(), CanvasPublishInput{
		Artifact:         request.Artifact,
		ArtifactID:       request.ArtifactID,
		ID:               request.ID,
		Title:            request.Title,
		SummaryMarkdown:  request.SummaryMarkdown,
		SummaryPath:      request.SummaryPath,
		NotificationText: request.NotificationText,
		Destination:      request.Destination,
		Channel:          request.Channel,
		ThreadTS:         request.ThreadTS,
		DedupKey:         request.DedupKey,
		WorkspaceID:      request.WorkspaceID,
		SnapshotTS:       request.SnapshotTS,
		CanvasID:         request.CanvasID,
		Operation:        request.Operation,
		SectionID:        request.SectionID,
		ForceSlackCanvas: request.ForceSlackCanvas,
	})
	if err != nil {
		httputil.AbortWithError(c, httputil.InternalServerError("publish canvas", gin.H{"reason": err.Error()}))
		return
	}

	status := http.StatusOK
	if !result.OK {
		status = http.StatusBadGateway
	}
	c.JSON(status, gin.H{
		"ok":        result.OK,
		"published": result,
	})
}

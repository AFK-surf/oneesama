package slackagent

import "github.com/gin-gonic/gin"

// handlePostMeetingPublish preserves the legacy TS route shape while reusing the
// same publish flow as /canvas/publish.
func (h *Handler) handlePostMeetingPublish(c *gin.Context) {
	h.handlePublishCanvas(c)
}

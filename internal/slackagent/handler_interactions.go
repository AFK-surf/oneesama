package slackagent

import (
	"net/http"

	"github.com/gin-gonic/gin"
)

func (h *Handler) handleInteraction(c *gin.Context) {
	if err := c.Request.ParseForm(); err != nil {
		c.JSON(http.StatusBadRequest, AvatarCommandResponse{
			OK:           false,
			ResponseType: "ephemeral",
			Text:         "Invalid Slack interaction payload.",
		})
		return
	}

	payload, err := parseSlackInteractionPayload(c.PostForm("payload"))
	if err != nil || payload == nil {
		c.JSON(http.StatusBadRequest, AvatarCommandResponse{
			OK:           false,
			ResponseType: "ephemeral",
			Text:         "Invalid Slack interaction payload.",
		})
		return
	}

	c.JSON(http.StatusOK, h.service.HandleSlackInteraction(c.Request.Context(), *payload))
}

package slackagent

import (
	"net/http"

	"github.com/AFK-surf/oneesama/internal/httputil"
	"github.com/gin-gonic/gin"
)

func (h *Handler) handleAvatarCommand(c *gin.Context) {
	if err := c.Request.ParseForm(); err != nil {
		httputil.AbortWithError(c, httputil.InvalidRequestError("parse slash command form", gin.H{"reason": err.Error()}))
		return
	}

	response := h.service.RunAvatarCommand(c.Request.Context(), AvatarCommandInput{
		Text:        c.PostForm("text"),
		TeamID:      c.PostForm("team_id"),
		TeamDomain:  c.PostForm("team_domain"),
		ChannelID:   c.PostForm("channel_id"),
		ChannelName: c.PostForm("channel_name"),
		ThreadTS:    c.PostForm("thread_ts"),
		UserID:      c.PostForm("user_id"),
		UserName:    c.PostForm("user_name"),
		Command:     c.PostForm("command"),
	})
	c.JSON(http.StatusOK, response)
}

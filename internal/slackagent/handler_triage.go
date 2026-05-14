package slackagent

import (
	"net/http"
	"strconv"

	"github.com/gin-gonic/gin"
)

type triageRunRequest struct {
	ChannelID string                `json:"channel_id"`
	Channel   string                `json:"channel"`
	TeamID    string                `json:"team_id"`
	Team      string                `json:"team"`
	UserID    string                `json:"user_id"`
	User      string                `json:"user"`
	Text      string                `json:"text"`
	Digest    string                `json:"digest"`
	TS        string                `json:"ts"`
	ThreadTS  string                `json:"thread_ts"`
	Messages  []SlackInboundMessage `json:"messages"`
}

func (h *Handler) handleTriageStatus(c *gin.Context) {
	limit, _ := strconv.Atoi(c.Query("limit"))
	status, err := h.service.TriageStatus(c.Request.Context(), limit)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"ok": false, "error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true, "triage": status})
}

func (h *Handler) handleTriageRun(c *gin.Context) {
	var request triageRunRequest
	if err := c.ShouldBindJSON(&request); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"ok": false, "error": "invalid request body: " + err.Error()})
		return
	}
	channelID := firstNonEmpty(request.ChannelID, request.Channel, "C_TRIAGE")
	messages := request.Messages
	if len(messages) == 0 {
		messages = []SlackInboundMessage{{
			TeamID:    firstNonEmpty(request.Team, request.TeamID, "T_TRIAGE"),
			ChannelID: channelID,
			UserID:    firstNonEmpty(request.User, request.UserID, "U_TRIAGE"),
			Text:      firstNonEmpty(request.Text, request.Digest),
			TS:        firstNonEmpty(request.TS, nowRFC3339()),
			ThreadTS:  request.ThreadTS,
		}}
	}
	digest := firstNonEmpty(request.Digest, renderSlackActivityDigest(channelID, messages))
	triage, err := h.service.StartSlackTriage(c.Request.Context(), channelID, messages, digest)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"ok": false, "error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{
		"ok":      true,
		"triage":  triage,
		"status":  triage.Finalization,
		"inbound": h.service.InboundStatus(),
	})
}

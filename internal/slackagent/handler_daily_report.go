package slackagent

import (
	"net/http"
	"strconv"
	"strings"

	"github.com/gin-gonic/gin"
)

func (h *Handler) handleDailyReportStatus(c *gin.Context) {
	c.JSON(http.StatusOK, gin.H{
		"ok":           true,
		"daily_report": h.service.dailyReportStatus(),
	})
}

func (h *Handler) handleDailyReportRun(c *gin.Context) {
	var request SlackDailyReportRunRequest
	if c.Request.Body != nil && c.Request.ContentLength != 0 {
		if err := c.ShouldBindJSON(&request); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"ok": false, "error": "invalid request body: " + err.Error()})
			return
		}
	}
	if value := strings.TrimSpace(c.Query("channel_id")); value != "" {
		request.ChannelID = value
	}
	if value := strings.TrimSpace(c.Query("channel")); value != "" {
		request.ChannelID = value
	}
	if value := strings.TrimSpace(c.Query("report_date")); value != "" {
		request.ReportDate = value
	}
	if value := strings.TrimSpace(c.Query("window")); value != "" {
		request.Window = value
	}
	if value := strings.TrimSpace(c.Query("dry_run")); value != "" {
		parsed, err := strconv.ParseBool(value)
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"ok": false, "error": "invalid dry_run query"})
			return
		}
		request.DryRun = parsed
	}
	if value := strings.TrimSpace(c.Query("force")); value != "" {
		parsed, err := strconv.ParseBool(value)
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"ok": false, "error": "invalid force query"})
			return
		}
		request.Force = parsed
	}
	response, err := h.service.RunDailyReport(c.Request.Context(), request)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"ok": false, "error": err.Error(), "daily_report": response})
		return
	}
	c.JSON(http.StatusOK, response)
}

package meetingagent

import (
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
)

func (h *Handler) handleRealtimeWorkspaceTool(c *gin.Context) {
	toolName := c.Param("name")
	switch toolName {
	case "current_user_identity":
		currentUser := h.service.realtimeCurrentUser()
		h.service.logger.Info(
			"realtime current_user_identity tool",
			"name", currentUser.Name,
			"english_name", currentUser.EnglishName,
			"aliases", currentUser.Aliases,
		)
		c.JSON(http.StatusOK, gin.H{
			"ok": true,
			"current_user": gin.H{
				"name":              currentUser.Name,
				"english_name":      currentUser.EnglishName,
				"preferred_address": currentUser.Name,
				"email":             currentUser.Email,
				"linear":            currentUser.Linear,
				"github":            currentUser.GitHub,
				"role":              currentUser.Role,
				"aliases":           currentUser.Aliases,
			},
			"answer_hint_zh": "当前和你说话的人是 " + currentUser.Name + "（英文账号 " + currentUser.EnglishName + "；别名 " + strings.Join(currentUser.Aliases, " / ") + "）。",
		})
	case "now":
		loc, err := time.LoadLocation("Asia/Shanghai")
		if err != nil {
			loc = time.FixedZone("Asia/Shanghai", 8*60*60)
		}
		now := time.Now().In(loc)
		c.JSON(http.StatusOK, gin.H{
			"ok":       true,
			"timezone": loc.String(),
			"now":      now.Format(time.RFC3339),
			"date":     now.Format("2006-01-02"),
			"time":     now.Format("15:04:05"),
		})
	default:
		c.JSON(http.StatusNotImplemented, gin.H{
			"ok":    false,
			"error": "workspace_tool_unavailable",
			"tool":  toolName,
			"note":  "This Go meeting-agent live build has not wired this workspace tool yet.",
		})
	}
}

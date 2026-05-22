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
		spokenName := realtimeCurrentUserSpokenName(currentUser)
		identity := h.service.resolveSpeakerIdentity(c.Request.Context(), resolveSpeakerIdentityInput{
			DisplayName: spokenName,
			Source:      "manual",
		})
		preferredAddress := firstNonEmpty(spokenName, stringFromAny(identity["preferred_name"]), currentUser.Name)
		h.service.logger.Info(
			"realtime current_user_identity tool",
			"name", currentUser.Name,
			"english_name", currentUser.EnglishName,
			"aliases", currentUser.Aliases,
			"preferred_address", preferredAddress,
		)
		c.JSON(http.StatusOK, gin.H{
			"ok": true,
			"current_user": gin.H{
				"name":              currentUser.Name,
				"english_name":      currentUser.EnglishName,
				"preferred_address": preferredAddress,
				"email":             currentUser.Email,
				"linear":            currentUser.Linear,
				"github":            currentUser.GitHub,
				"role":              currentUser.Role,
				"aliases":           currentUser.Aliases,
				"identity":          identity,
			},
			"answer_hint_zh": "当前和你说话的人是 " + preferredAddress + "（英文账号 " + currentUser.EnglishName + "；别名 " + strings.Join(currentUser.Aliases, " / ") + "）。",
		})
	case "resolve_speaker_identity":
		var input resolveSpeakerIdentityInput
		if err := c.ShouldBindJSON(&input); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{
				"ok":    false,
				"error": "invalid_json",
			})
			return
		}
		identity := h.service.resolveSpeakerIdentity(c.Request.Context(), input)
		h.service.logger.Info(
			"realtime resolve_speaker_identity tool",
			"display_name", input.DisplayName,
			"source", input.Source,
			"canonical_name", identity["canonical_name"],
			"role", identity["role"],
			"confidence", identity["confidence"],
			"is_current_user", identity["is_current_user"],
		)
		c.JSON(http.StatusOK, gin.H{
			"ok":       true,
			"identity": identity,
		})
	case "calendar_attendees":
		var input struct {
			MeetURL string `json:"meet_url"`
		}
		_ = c.ShouldBindJSON(&input)
		attendees := h.service.calendarAttendeesForMeet(c.Request.Context(), input.MeetURL)
		c.JSON(http.StatusOK, gin.H{
			"ok":        true,
			"meet_url":  strings.TrimSpace(input.MeetURL),
			"attendees": attendees,
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
	case "start_demo_surface":
		var input RealtimeDemoSurfaceStartRequest
		if err := c.ShouldBindJSON(&input); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{
				"ok":    false,
				"error": "invalid_json",
			})
			return
		}
		result, err := h.service.StartRealtimeDemoSurface(c.Request.Context(), input)
		if err != nil {
			c.JSON(realtimeDemoBridgeHTTPStatus(err), result)
			return
		}
		c.JSON(http.StatusOK, result)
	case "control_demo_surface":
		var input RealtimeDemoSurfaceControlRequest
		if err := c.ShouldBindJSON(&input); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{
				"ok":    false,
				"error": "invalid_json",
			})
			return
		}
		result, err := h.service.ControlRealtimeDemoSurface(c.Request.Context(), input)
		if err != nil {
			c.JSON(realtimeDemoBridgeHTTPStatus(err), result)
			return
		}
		c.JSON(http.StatusOK, result)
	case "cancel_demo_surface":
		var input RealtimeDemoSurfaceCancelRequest
		if err := c.ShouldBindJSON(&input); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{
				"ok":    false,
				"error": "invalid_json",
			})
			return
		}
		result, err := h.service.CancelRealtimeDemoSurface(c.Request.Context(), input)
		if err != nil {
			c.JSON(realtimeDemoBridgeHTTPStatus(err), result)
			return
		}
		c.JSON(http.StatusOK, result)
	default:
		c.JSON(http.StatusNotImplemented, gin.H{
			"ok":    false,
			"error": "workspace_tool_unavailable",
			"tool":  toolName,
			"note":  "This Go meeting-agent live build has not wired this workspace tool yet.",
		})
	}
}

func realtimeCurrentUserSpokenName(currentUser RealtimeCurrentUser) string {
	return firstNonEmpty(currentUser.EnglishName, currentUser.English, currentUser.Name)
}

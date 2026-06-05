package meetingagent

import (
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
)

func isRealtimeDemoSurfaceTool(toolName string) bool {
	switch toolName {
	case "open_shared_browser_surface",
		"create_shared_workspace",
		"control_shared_browser_surface",
		"stop_shared_browser_surface":
		return true
	default:
		return false
	}
}

func isDeprecatedRealtimeDemoSurfaceTool(toolName string) bool {
	switch toolName {
	case "start_demo_surface", "start_demo_execution", "control_demo_surface", "cancel_demo_surface":
		return true
	default:
		return false
	}
}

func (h *Handler) rejectDeprecatedRealtimeDemoSurfaceTool(c *gin.Context, toolName string) bool {
	if !isDeprecatedRealtimeDemoSurfaceTool(toolName) {
		return false
	}
	c.JSON(http.StatusGone, gin.H{
		"ok":     false,
		"error":  "deprecated_demo_surface_tool",
		"tool":   toolName,
		"reason": "use_current_browser_surface_tool_name",
	})
	return true
}

func (h *Handler) rejectHiddenRealtimeDemoSurfaceTool(c *gin.Context, toolName string) bool {
	if !isRealtimeDemoSurfaceTool(toolName) || h.service.realtimeDemoSurfaceToolsExposed() {
		return false
	}
	c.JSON(http.StatusServiceUnavailable, gin.H{
		"ok":     false,
		"error":  "demo_surface_tool_not_exposed",
		"tool":   toolName,
		"reason": "realtime_demo_surface_tool_hidden",
	})
	return true
}

func (h *Handler) handleRealtimeWorkspaceTool(c *gin.Context) {
	toolName := c.Param("name")
	if h.rejectDeprecatedRealtimeDemoSurfaceTool(c, toolName) {
		return
	}
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
		identityHint := "The person speaking to you is " + preferredAddress + "."
		if strings.TrimSpace(currentUser.EnglishName) != "" && currentUser.EnglishName != preferredAddress {
			identityHint += " Their English account name is " + currentUser.EnglishName + "."
		}
		if len(currentUser.Aliases) > 0 {
			identityHint += " Aliases: " + strings.Join(currentUser.Aliases, " / ") + "."
		}
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
			"answer_hint_en": identityHint,
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
	case "open_shared_browser_surface":
		if h.rejectHiddenRealtimeDemoSurfaceTool(c, toolName) {
			return
		}
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
	case "create_shared_workspace":
		if h.rejectHiddenRealtimeDemoSurfaceTool(c, toolName) {
			return
		}
		var input RealtimeDemoExecutionStartRequest
		if err := c.ShouldBindJSON(&input); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{
				"ok":    false,
				"error": "invalid_json",
			})
			return
		}
		result, err := h.service.StartRealtimeDemoExecution(c.Request.Context(), input)
		if err != nil {
			c.JSON(realtimeDemoBridgeHTTPStatus(err), result)
			return
		}
		c.JSON(http.StatusOK, result)
	case "control_shared_browser_surface":
		if h.rejectHiddenRealtimeDemoSurfaceTool(c, toolName) {
			return
		}
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
	case "kwwk_computer_use":
		var input RealtimeSharedAppControlRequest
		if err := c.ShouldBindJSON(&input); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{
				"ok":    false,
				"error": "invalid_json",
			})
			return
		}
		input.ExecutionMode = appControlExecutionModeDirect
		c.JSON(http.StatusOK, h.service.ControlRealtimeSharedApp(c.Request.Context(), input))
	case "stop_shared_browser_surface":
		if h.rejectHiddenRealtimeDemoSurfaceTool(c, toolName) {
			return
		}
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

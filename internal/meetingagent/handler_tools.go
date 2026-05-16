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
	case "resolve_speaker_identity":
		var input struct {
			DisplayName string `json:"display_name"`
			Source      string `json:"source"`
			Channel     string `json:"channel"`
			Workspace   string `json:"workspace"`
		}
		if err := c.ShouldBindJSON(&input); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{
				"ok":    false,
				"error": "invalid_json",
			})
			return
		}
		identity := h.service.resolveSpeakerIdentity(input.DisplayName, input.Source)
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

func (s *Service) resolveSpeakerIdentity(displayName string, source string) gin.H {
	name := strings.TrimSpace(displayName)
	if name == "" {
		return gin.H{
			"display_name":     "",
			"canonical_name":   "",
			"preferred_name":   "",
			"role":             "unknown",
			"aliases":          []string{},
			"confidence":       "low",
			"evidence":         []string{"missing_display_name"},
			"is_current_user":  false,
			"source":           strings.TrimSpace(source),
			"resolver":         "workspace_current_user",
			"privacy_context":  "safe_for_prompt",
			"pii_fields_used":  []string{},
			"pii_fields_shown": []string{},
		}
	}
	currentUser := s.realtimeCurrentUser()
	aliases := compactCurrentUserAliases(currentUser.Aliases, currentUser.Name, currentUser.EnglishName, currentUser.English)
	normalizedName := normalizeSpeakerIdentityText(name)
	for _, alias := range aliases {
		if normalizeSpeakerIdentityText(alias) == normalizedName {
			canonical := firstNonEmpty(currentUser.Name, currentUser.EnglishName, alias)
			preferred := preferredSpeakerAddress(aliases, canonical)
			return gin.H{
				"display_name":     name,
				"canonical_name":   canonical,
				"preferred_name":   preferred,
				"role":             "current_user",
				"aliases":          aliases,
				"confidence":       "high",
				"evidence":         []string{"exact_alias:" + alias},
				"is_current_user":  true,
				"source":           strings.TrimSpace(source),
				"resolver":         "workspace_current_user",
				"privacy_context":  "safe_for_prompt",
				"pii_fields_used":  []string{"display_name", "configured_aliases"},
				"pii_fields_shown": []string{},
			}
		}
	}
	return gin.H{
		"display_name":     name,
		"canonical_name":   name,
		"preferred_name":   name,
		"role":             "external",
		"aliases":          []string{},
		"confidence":       "low",
		"evidence":         []string{"fallback:display_name"},
		"is_current_user":  false,
		"source":           strings.TrimSpace(source),
		"resolver":         "workspace_current_user",
		"privacy_context":  "safe_for_prompt",
		"pii_fields_used":  []string{"display_name"},
		"pii_fields_shown": []string{},
	}
}

func normalizeSpeakerIdentityText(value string) string {
	return strings.Join(strings.Fields(strings.ToLower(strings.TrimSpace(strings.NewReplacer("·", " ", "・", " ").Replace(value)))), " ")
}

func preferredSpeakerAddress(aliases []string, fallback string) string {
	for _, alias := range aliases {
		for _, r := range alias {
			if r >= '\u4e00' && r <= '\u9fff' {
				return alias
			}
		}
	}
	return fallback
}

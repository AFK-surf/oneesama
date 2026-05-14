package meetingagent

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
)

func (h *Handler) registerMeetdRoutes(routes *gin.RouterGroup) {
	routes.POST("", h.handleMeetdCreateMeeting)
	routes.GET("", h.handleMeetdListMeetings)
	routes.GET("/runtime/status", h.handleMeetdRuntimeStatus)
	routes.POST("/runtime/tick", h.handleMeetdRuntimeTick)
	routes.POST("/:id/chat", h.handleMeetdSendChat)
	routes.GET("/:id/captions", h.handleMeetdGetCaptions)
	routes.POST("/:id/cancel", h.handleMeetdCancelMeeting)
	routes.POST("/:id/redeliver", h.handleMeetdRedeliverMeeting)
	routes.POST("/:id/resummarize", h.handleMeetdResummarizeMeeting)
	routes.GET("/:id/artifacts/*name", h.handleMeetdGetArtifact)
	routes.GET("/:id", h.handleMeetdGetMeeting)
}

func (h *Handler) handleMeetdCreateMeeting(c *gin.Context) {
	var brief MeetdMeetingBrief
	if err := c.ShouldBindJSON(&brief); err != nil {
		meetdJSONError(c, http.StatusBadRequest, "invalid request body: "+err.Error())
		return
	}
	if brief.MeetURL == "" && brief.EventID == "" {
		meetdJSONError(c, http.StatusBadRequest, "meet_url or event_id is required")
		return
	}
	if brief.StartAt == "" || brief.EndAt == "" {
		meetdJSONError(c, http.StatusBadRequest, "start_at and end_at are required")
		return
	}
	id, err := h.service.ScheduleMeetdMeeting(c.Request.Context(), brief)
	if err != nil {
		meetdJSONError(c, http.StatusInternalServerError, "schedule meeting: "+err.Error())
		return
	}
	c.JSON(http.StatusOK, gin.H{"meeting_id": id})
}

func (h *Handler) handleMeetdListMeetings(c *gin.Context) {
	meetings, err := h.service.ListMeetdMeetings(c.Request.Context(), c.Query("status"))
	if err != nil {
		meetdJSONError(c, http.StatusInternalServerError, "list meetings: "+err.Error())
		return
	}
	items := make([]gin.H, 0, len(meetings))
	for _, meeting := range meetings {
		items = append(items, meetdMeetingResponse(meeting))
	}
	c.JSON(http.StatusOK, gin.H{"meetings": items})
}

func (h *Handler) handleMeetdGetMeeting(c *gin.Context) {
	meeting, ok := h.meetdMeetingOrError(c)
	if !ok {
		return
	}
	response := meetdMeetingResponse(*meeting)
	result, err := h.service.LoadStoredMeetdMeetingResult(c.Request.Context(), *meeting)
	if err != nil {
		meetdJSONError(c, http.StatusInternalServerError, "load meeting result: "+err.Error())
		return
	}
	if result != nil {
		response["result"] = result
	}
	c.JSON(http.StatusOK, response)
}

func (h *Handler) handleMeetdCancelMeeting(c *gin.Context) {
	meeting, ok := h.meetdMeetingOrError(c)
	if !ok {
		return
	}
	if meeting.Status != "pending" {
		meetdJSONError(c, http.StatusConflict, fmt.Sprintf("cannot cancel meeting in %q state", meeting.Status))
		return
	}
	if _, err := h.service.CancelMeetdMeeting(c.Request.Context(), meeting.ID); err != nil {
		meetdJSONError(c, http.StatusInternalServerError, err.Error())
		return
	}
	c.JSON(http.StatusOK, gin.H{"status": "cancelled"})
}

func (h *Handler) handleMeetdSendChat(c *gin.Context) {
	meetingID, ok := h.meetdMeetingIDOrError(c)
	if !ok {
		return
	}
	var request struct {
		Text string `json:"text"`
	}
	if err := json.NewDecoder(c.Request.Body).Decode(&request); err != nil {
		meetdJSONError(c, http.StatusBadRequest, "invalid request body: "+err.Error())
		return
	}
	if request.Text == "" {
		meetdJSONError(c, http.StatusBadRequest, "text is required")
		return
	}
	ok, err := h.service.SendMeetdChat(c.Request.Context(), meetingID, request.Text)
	if errors.Is(err, errMeetdNoActiveJoiner) {
		meetdJSONError(c, http.StatusNotFound, "no active joiner for this meeting")
		return
	}
	if err != nil {
		c.JSON(http.StatusOK, gin.H{"success": false, "error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"success": ok})
}

func (h *Handler) handleMeetdGetCaptions(c *gin.Context) {
	meeting, ok := h.meetdMeetingOrError(c)
	if !ok {
		return
	}
	limit := 50
	if raw := c.Query("limit"); raw != "" {
		if parsed, err := strconv.Atoi(raw); err == nil && parsed > 0 {
			limit = parsed
		}
	}
	if limit > 200 {
		limit = 200
	}

	source, err := parseMeetdCaptionSource(c.Query("source"))
	if err != nil {
		meetdJSONError(c, http.StatusBadRequest, err.Error())
		return
	}
	allCaptions, err := h.service.ListMeetdCaptions(c.Request.Context(), meeting.ID, source)
	if err != nil {
		meetdJSONError(c, http.StatusInternalServerError, "list captions: "+err.Error())
		return
	}
	captions := allCaptions
	if len(captions) > limit {
		captions = captions[len(captions)-limit:]
	}
	c.JSON(http.StatusOK, gin.H{
		"meeting_id":        meeting.ID,
		"status":            meeting.Status,
		"title":             meeting.Title,
		"source":            source,
		"total_captions":    len(allCaptions),
		"returned_captions": len(captions),
		"speakers":          meetdCaptionSpeakers(allCaptions),
		"captions":          meetdCaptionItems(captions, meetdCaptionOrigin(allCaptions, meeting.StartTime)),
	})
}

func (h *Handler) meetdMeetingOrError(c *gin.Context) (*MeetdMeetingRecord, bool) {
	id, ok := h.meetdMeetingIDOrError(c)
	if !ok {
		return nil, false
	}
	meeting, err := h.service.GetMeetdMeeting(c.Request.Context(), id)
	if err != nil {
		meetdJSONError(c, http.StatusInternalServerError, err.Error())
		return nil, false
	}
	if meeting == nil {
		meetdJSONError(c, http.StatusNotFound, "meeting not found")
		return nil, false
	}
	return meeting, true
}

func (h *Handler) meetdMeetingIDOrError(c *gin.Context) (int64, bool) {
	id, err := strconv.ParseInt(strings.TrimSpace(c.Param("id")), 10, 64)
	if err != nil || id <= 0 {
		meetdJSONError(c, http.StatusBadRequest, "invalid meeting id")
		return 0, false
	}
	return id, true
}

func meetdMeetingResponse(meeting MeetdMeetingRecord) gin.H {
	return gin.H{
		"id":         meeting.ID,
		"event_id":   meeting.CalendarEventID,
		"meet_url":   meeting.MeetURL,
		"title":      meeting.Title,
		"start_time": meeting.StartTime,
		"end_time":   meeting.EndTime,
		"status":     meeting.Status,
		"error":      meeting.ErrorMessage,
	}
}

func meetdJSONError(c *gin.Context, code int, message string) {
	c.JSON(code, gin.H{"error": message})
}

func parseMeetdCaptionSource(raw string) (string, error) {
	switch strings.TrimSpace(strings.ToLower(raw)) {
	case "", "live", "live_caption":
		return "live_caption", nil
	case "asr":
		return "asr", nil
	case "all":
		return "all", nil
	default:
		return "", fmt.Errorf("invalid caption source %q", raw)
	}
}

func meetdCaptionItems(captions []MeetdCaptionRecord, origin time.Time) []gin.H {
	captions = dedupeMeetdCaptionsForTranscript(captions)
	items := make([]gin.H, len(captions))
	for i, caption := range captions {
		items[i] = gin.H{
			"speaker":   normalizeMeetdSpeakerName(caption.Speaker),
			"text":      caption.Text,
			"timestamp": formatMeetdRelativeTimestamp(caption.Timestamp, origin),
		}
	}
	return items
}

func meetdCaptionOrigin(captions []MeetdCaptionRecord, fallback time.Time) time.Time {
	origin := fallback
	for _, caption := range captions {
		if caption.Timestamp.IsZero() {
			continue
		}
		if origin.IsZero() || caption.Timestamp.Before(origin) {
			origin = caption.Timestamp
		}
	}
	return origin
}

func meetdCaptionSpeakers(captions []MeetdCaptionRecord) []string {
	seen := map[string]bool{}
	speakers := make([]string, 0)
	for _, caption := range captions {
		speaker := normalizeMeetdSpeakerName(caption.Speaker)
		if speaker != "" && speaker != "Unknown" && !seen[speaker] {
			seen[speaker] = true
			speakers = append(speakers, speaker)
		}
	}
	return speakers
}

func formatMeetdRelativeTimestamp(ts, origin time.Time) string {
	if ts.IsZero() {
		return "00:00:00"
	}
	if origin.IsZero() || ts.Before(origin) {
		origin = ts
	}
	totalSeconds := int(ts.Sub(origin) / time.Second)
	if totalSeconds < 0 {
		totalSeconds = 0
	}
	hours := totalSeconds / 3600
	minutes := (totalSeconds % 3600) / 60
	seconds := totalSeconds % 60
	return fmt.Sprintf("%02d:%02d:%02d", hours, minutes, seconds)
}

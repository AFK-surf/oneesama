package meetingagent

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
)

func (h *Handler) handleMeetdRedeliverMeeting(c *gin.Context) {
	if h.service.meetdWebhook == nil {
		meetdJSONError(c, http.StatusNotImplemented, "webhook sender not configured")
		return
	}
	meetingID, ok := h.meetdMeetingIDOrError(c)
	if !ok {
		return
	}
	meeting, err := h.service.GetMeetdMeeting(c.Request.Context(), meetingID)
	if err != nil {
		meetdJSONError(c, http.StatusInternalServerError, err.Error())
		return
	}
	if meeting == nil {
		if err := h.service.RedeliverJoinSessionBySyntheticMeetingID(c.Request.Context(), meetingID); err != nil {
			switch {
			case errors.Is(err, errJoinSessionNotFound):
				meetdJSONError(c, http.StatusNotFound, "meeting not found")
			case errors.Is(err, errJoinSessionNotRedeliverable):
				meetdJSONError(c, http.StatusConflict, err.Error())
			default:
				meetdJSONError(c, http.StatusInternalServerError, "redeliver join session: "+err.Error())
			}
			return
		}
		c.JSON(http.StatusOK, gin.H{"status": "redelivered"})
		return
	}
	if meeting.Status != "done" && meeting.Status != "failed" {
		meetdJSONError(c, http.StatusConflict, fmt.Sprintf("meeting %d is in %q state, cannot redeliver", meeting.ID, meeting.Status))
		return
	}
	result, err := h.service.LoadStoredMeetdMeetingResult(c.Request.Context(), *meeting)
	if err != nil {
		meetdJSONError(c, http.StatusInternalServerError, "load meeting result: "+err.Error())
		return
	}
	if result == nil {
		result = &MeetdMeetingResult{MeetingID: fmt.Sprint(meeting.ID), Status: meeting.Status}
	}
	result.ForceDelivery = true
	populateMeetdResultArtifacts(result, *meeting)
	if err := h.service.meetdWebhook(c.Request.Context(), *meeting, *result); err != nil {
		meetdJSONError(c, http.StatusInternalServerError, "redeliver webhook: "+err.Error())
		return
	}
	c.JSON(http.StatusOK, gin.H{"status": "redelivered"})
}

func (h *Handler) handleMeetdResummarizeMeeting(c *gin.Context) {
	meeting, ok := h.meetdMeetingOrError(c)
	if !ok {
		return
	}
	switch meeting.Status {
	case "done", "failed":
	case "processing":
		if !meetdProcessingLooksStuck(*meeting, time.Now()) {
			meetdJSONError(c, http.StatusConflict, fmt.Sprintf(
				"meeting %d is still actively processing (updated %s); try again if it stays stuck",
				meeting.ID,
				time.Since(meeting.UpdatedAt).Round(time.Second),
			))
			return
		}
	default:
		meetdJSONError(c, http.StatusConflict, fmt.Sprintf("meeting %d is in %q state, cannot resummarize", meeting.ID, meeting.Status))
		return
	}
	go h.service.ProcessMeetdMeetingEnd(context.WithoutCancel(c.Request.Context()), *meeting, true)
	c.JSON(http.StatusOK, gin.H{"status": "resummarizing"})
}

func meetdProcessingLooksStuck(meeting MeetdMeetingRecord, now time.Time) bool {
	if meeting.Status != "processing" {
		return false
	}
	if meeting.UpdatedAt.IsZero() {
		return true
	}
	return now.Sub(meeting.UpdatedAt) >= processingResummarizeMinAge
}

func (h *Handler) handleMeetdGetArtifact(c *gin.Context) {
	meeting, ok := h.meetdMeetingOrError(c)
	if !ok {
		return
	}
	path, contentType, filename, err := resolveMeetdArtifactPath(*meeting, c.Param("name"))
	if err != nil {
		meetdJSONError(c, http.StatusNotFound, err.Error())
		return
	}
	c.Header("Content-Type", contentType)
	c.Header("Content-Disposition", fmt.Sprintf("attachment; filename=%q", filename))
	http.ServeFile(c.Writer, c.Request, path)
}

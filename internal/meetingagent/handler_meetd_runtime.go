package meetingagent

import (
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
)

type meetdRuntimeTickRequest struct {
	Now          string `json:"now,omitempty"`
	At           string `json:"at,omitempty"`
	StaleMS      int64  `json:"stale_ms,omitempty"`
	StaleMs      int64  `json:"staleMs,omitempty"`
	DryRunJoiner bool   `json:"dry_run_joiner,omitempty"`
}

func (h *Handler) handleMeetdRuntimeStatus(c *gin.Context) {
	counts := map[string]int{}
	for _, status := range meetdListStatuses {
		meetings, err := h.service.ListMeetdMeetings(c.Request.Context(), status)
		if err != nil {
			meetdJSONError(c, http.StatusInternalServerError, "list meetings: "+err.Error())
			return
		}
		counts[status] = len(meetings)
	}
	all, err := h.service.ListMeetdMeetings(c.Request.Context(), "")
	if err != nil {
		meetdJSONError(c, http.StatusInternalServerError, "list meetings: "+err.Error())
		return
	}
	items := make([]gin.H, 0, len(all))
	for _, meeting := range all {
		items = append(items, meetdMeetingResponse(meeting))
	}
	c.JSON(http.StatusOK, gin.H{"ok": true, "counts": counts, "meetings": items})
}

func (h *Handler) handleMeetdRuntimeTick(c *gin.Context) {
	var request meetdRuntimeTickRequest
	if c.Request.ContentLength != 0 {
		if err := c.ShouldBindJSON(&request); err != nil {
			meetdJSONError(c, http.StatusBadRequest, "invalid request body: "+err.Error())
			return
		}
	}
	opts := MeetdRuntimeTickOptions{
		Now:          parseMeetdTickTime(firstNonEmpty(request.Now, request.At)),
		DryRunJoiner: request.DryRunJoiner,
	}
	if request.StaleMS > 0 {
		opts.StaleAfter = time.Duration(request.StaleMS) * time.Millisecond
	} else if request.StaleMs > 0 {
		opts.StaleAfter = time.Duration(request.StaleMs) * time.Millisecond
	}
	result, err := h.service.TickMeetdRuntime(c.Request.Context(), opts)
	if err != nil {
		meetdJSONError(c, http.StatusInternalServerError, err.Error())
		return
	}
	c.JSON(http.StatusOK, result)
}

func parseMeetdTickTime(value string) time.Time {
	if value == "" {
		return time.Now().UTC()
	}
	if parsed, err := time.Parse(time.RFC3339Nano, value); err == nil {
		return parsed
	}
	if parsed, err := time.Parse(time.RFC3339, value); err == nil {
		return parsed
	}
	return time.Now().UTC()
}

package meetingagent

import (
	"errors"
	"io"
	"net/http"

	"github.com/AFK-surf/oneesama/internal/agentrunner"
	"github.com/AFK-surf/oneesama/internal/httputil"
	"github.com/gin-gonic/gin"
)

func (h *Handler) handleWorkerReport(c *gin.Context) {
	var input WorkerReportInput
	if err := c.ShouldBindJSON(&input); err != nil {
		httputil.AbortWithError(c, httputil.InvalidRequestError("parse worker report", gin.H{"reason": err.Error()}))
		return
	}
	report, err := h.service.createWorkerReport(c.Request.Context(), input)
	if err != nil {
		httputil.AbortWithError(c, httputil.InternalServerError("save worker report failed", gin.H{"reason": err.Error()}))
		return
	}
	delivery, deliveredReport := h.service.deliverWorkerReportRealtime(c.Request.Context(), report)
	if deliveredReport != nil {
		report = *deliveredReport
	}
	c.JSON(http.StatusOK, gin.H{
		"ok":                true,
		"job":               report,
		"realtimeDelivery":  delivery,
		"realtime_delivery": delivery,
	})
}

func (h *Handler) handleWorkerDelegate(c *gin.Context) {
	var input WorkerDelegateRequest
	if err := c.ShouldBindJSON(&input); err != nil && !errors.Is(err, io.EOF) {
		httputil.AbortWithError(c, httputil.InvalidRequestError("parse worker delegate", gin.H{"reason": err.Error()}))
		return
	}
	if h.service.runner == nil {
		c.JSON(http.StatusOK, WorkerDelegateResponse{OK: false, Error: runnerErrorText(h.service.runnerErr)})
		return
	}
	startInput := agentrunner.WithSessionCapabilities(agentrunner.StartInput{
		Task: input.Task, Context: input.Context, Mode: input.Mode, AllowCodeChanges: input.AllowCodeChanges,
	}, agentrunner.SessionKindMeetingCopilot)
	job, err := h.service.runner.StartTask(c.Request.Context(), startInput)
	if err != nil {
		c.JSON(http.StatusOK, WorkerDelegateResponse{OK: false, Error: err.Error()})
		return
	}
	report := h.service.ReportFinishedWorkerJob(c.Request.Context(), job)
	c.JSON(http.StatusOK, WorkerDelegateResponse{OK: true, Job: job, Report: report})
}

func (h *Handler) handleWorkerStatus(c *gin.Context) {
	var input WorkerStatusRequest
	if err := c.ShouldBindJSON(&input); err != nil && !errors.Is(err, io.EOF) {
		httputil.AbortWithError(c, httputil.InvalidRequestError("parse worker status", gin.H{"reason": err.Error()}))
		return
	}
	jobID := firstNonEmpty(input.JobID, input.JobIDSnake, input.ID)
	if jobID == "" {
		reports, err := h.service.listWorkerReports(c.Request.Context())
		if err != nil {
			httputil.AbortWithError(c, httputil.InternalServerError("list worker reports failed", gin.H{"reason": err.Error()}))
			return
		}
		c.JSON(http.StatusOK, gin.H{"ok": true, "job": nil, "jobs": reports})
		return
	}
	if h.service.runner != nil {
		if job, found, err := h.service.runner.GetJob(c.Request.Context(), jobID); err == nil && found {
			c.JSON(http.StatusOK, gin.H{"ok": true, "job": job, "jobs": []agentrunner.Job{job}})
			return
		}
	}
	report, found, err := h.service.getWorkerReport(c.Request.Context(), jobID)
	if err != nil {
		httputil.AbortWithError(c, httputil.InternalServerError("load worker report failed", gin.H{"reason": err.Error()}))
		return
	}
	if !found {
		c.JSON(http.StatusOK, gin.H{"ok": true, "job": nil, "jobs": []WorkerReport{}})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true, "job": report, "jobs": []WorkerReport{report}})
}

func (h *Handler) handleWorkerJobs(c *gin.Context) {
	reports, err := h.service.listWorkerReports(c.Request.Context())
	if err != nil {
		httputil.AbortWithError(c, httputil.InternalServerError("list worker reports failed", gin.H{"reason": err.Error()}))
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true, "jobs": reports})
}

func (h *Handler) handleWorkerPollRealtime(c *gin.Context) {
	h.handleWorkerPoll(c, true)
}

func (h *Handler) handleWorkerPollSlack(c *gin.Context) {
	h.handleWorkerPoll(c, false)
}

func (h *Handler) handleWorkerPoll(c *gin.Context, realtime bool) {
	var input WorkerPollRequest
	if err := c.ShouldBindJSON(&input); err != nil && !errors.Is(err, io.EOF) {
		httputil.AbortWithError(c, httputil.InvalidRequestError("parse worker poll", gin.H{"reason": err.Error()}))
		return
	}
	jobs, err := h.service.pollReadyWorkerReports(c.Request.Context(), realtime, input)
	if err != nil {
		httputil.AbortWithError(c, httputil.InternalServerError("poll worker reports failed", gin.H{"reason": err.Error()}))
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true, "jobs": jobs})
}

func (h *Handler) handleWorkerMarkSlackDelivered(c *gin.Context) {
	var input WorkerMarkSlackDeliveredRequest
	if err := c.ShouldBindJSON(&input); err != nil {
		httputil.AbortWithError(c, httputil.InvalidRequestError("parse worker delivery marker", gin.H{"reason": err.Error()}))
		return
	}
	jobID := firstNonEmpty(input.JobID, input.JobIDSnake, input.ID)
	report, err := h.service.markWorkerDelivered(c.Request.Context(), jobID, false, DeliveryMeta{
		Channel: input.Channel, ThreadTS: firstNonEmpty(input.ThreadTS, input.ThreadTSSnake),
		TS: input.TS, DedupKey: firstNonEmpty(input.DedupKey, input.DedupKeySnake), Mock: input.Mock,
	})
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"ok": false, "job": nil})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true, "job": report})
}

func runnerErrorText(err error) string {
	if err == nil {
		return "agent runner is unavailable"
	}
	return err.Error()
}

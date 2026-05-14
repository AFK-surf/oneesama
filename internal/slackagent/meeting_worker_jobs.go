package slackagent

import (
	"context"
	"fmt"
	"strings"
)

type meetingWorkerJob struct {
	ID     string `json:"id,omitempty"`
	Status string `json:"status,omitempty"`
	Task   string `json:"task,omitempty"`
	Result string `json:"result,omitempty"`
	Error  string `json:"error,omitempty"`
}

type meetingWorkerJobsResponse struct {
	OK   bool               `json:"ok,omitempty"`
	Jobs []meetingWorkerJob `json:"jobs,omitempty"`
}

type meetingWorkerPollRequest struct {
	Limit         int  `json:"limit,omitempty"`
	MarkDelivered bool `json:"mark_delivered"`
}

type meetingWorkerPollResponse struct {
	OK       bool               `json:"ok,omitempty"`
	Jobs     []meetingWorkerJob `json:"jobs,omitempty"`
	Text     string             `json:"text,omitempty"`
	Messages []string           `json:"messages,omitempty"`
}

func (s *Service) getMeetingWorkerJobs(ctx context.Context) ([]meetingWorkerJob, error) {
	var result meetingWorkerJobsResponse
	if err := s.getMeetingAgentJSON(ctx, "/worker/jobs", &result); err != nil {
		return nil, err
	}
	return result.Jobs, nil
}

func (s *Service) pollMeetingWorkerResults(ctx context.Context, limit int, markDelivered bool) (meetingWorkerPollResponse, error) {
	var result meetingWorkerPollResponse
	if err := s.postMeetingAgentJSON(ctx, "/worker/poll-slack", meetingWorkerPollRequest{
		Limit:         limit,
		MarkDelivered: markDelivered,
	}, &result); err != nil {
		return meetingWorkerPollResponse{}, err
	}
	if len(result.Messages) == 0 {
		for _, job := range result.Jobs {
			result.Messages = append(result.Messages, formatMeetingWorkerJobForSlack(job))
		}
	}
	if strings.TrimSpace(result.Text) == "" {
		if len(result.Messages) > 0 {
			result.Text = strings.Join(result.Messages, "\n\n")
		} else {
			result.Text = "No completed meeting worker jobs ready for Slack."
		}
	}
	return result, nil
}

func formatMeetingWorkerJobForSlack(job meetingWorkerJob) string {
	statusLabel := job.Status
	if statusLabel == "completed" {
		statusLabel = "completed"
	}
	detail := firstNonEmpty(job.Result, job.Error, "(no detail)")
	if job.Status == "completed" && strings.TrimSpace(job.Result) == "" {
		detail = "(no result)"
	}
	return fmt.Sprintf("Worker %s %s: %s\n%s", firstNonEmpty(job.ID, "worker"), statusLabel, firstNonEmpty(job.Task, "(untitled task)"), detail)
}

package meetingagent

import (
	"context"
	"encoding/json"
	"errors"
	"strings"

	"github.com/AFK-surf/oneesama/internal/agentrunner"
)

const (
	realtimeDemoExecutionStatusStarted   = "started"
	realtimeDemoExecutionStatusCompleted = "completed"
	realtimeDemoExecutionStatusFailed    = "failed"
)

var (
	errDemoExecutionMissingTask    = errors.New("demo_execution_task_required")
	errDemoExecutionRunnerRequired = errors.New("demo_execution_runner_required")
)

type RealtimeDemoExecutionStartRequest struct {
	MeetingSessionID  string `json:"session_id,omitempty"`
	DemoSessionID     string `json:"demo_session_id,omitempty"`
	Task              string `json:"task,omitempty"`
	TaskURL           string `json:"task_url,omitempty"`
	DemoURL           string `json:"demo_url,omitempty"`
	Title             string `json:"title,omitempty"`
	IssueID           string `json:"issue_id,omitempty"`
	IssueURL          string `json:"issue_url,omitempty"`
	RequestIssueClose bool   `json:"request_issue_close,omitempty"`
	Mode              string `json:"mode,omitempty"`
	AllowCodeChanges  *bool  `json:"allow_code_changes,omitempty"`
	Actor             string `json:"actor,omitempty"`
	Surface           string `json:"surface,omitempty"`
	ChannelID         string `json:"channel_id,omitempty"`
	ThreadTS          string `json:"thread_ts,omitempty"`
	UserInstruction   string `json:"user_instruction,omitempty"`
	WorkerInstruction string `json:"worker_instruction,omitempty"`
}

type RealtimeDemoExecutionResult struct {
	OK                 bool                       `json:"ok"`
	Status             string                     `json:"status"`
	Job                *agentrunner.Job           `json:"job,omitempty"`
	Report             *WorkerReport              `json:"report,omitempty"`
	Demo               *RealtimeDemoBridgeResult  `json:"demo,omitempty"`
	CompletionDemo     *RealtimeDemoBridgeResult  `json:"completion_demo,omitempty"`
	UserPreferences    map[string]any             `json:"user_preferences,omitempty"`
	Approval           *DemoExecutionApprovalGate `json:"approval,omitempty"`
	FeedbackText       string                     `json:"feedback_text,omitempty"`
	ShouldSpeak        bool                       `json:"should_speak,omitempty"`
	ObservationContext string                     `json:"observation_context,omitempty"`
	Error              string                     `json:"error,omitempty"`
}

type DemoExecutionApprovalGate struct {
	Required  bool   `json:"required"`
	Operation string `json:"operation,omitempty"`
	Target    string `json:"target,omitempty"`
	Reason    string `json:"reason,omitempty"`
}

func (s *Service) StartRealtimeDemoExecution(ctx context.Context, input RealtimeDemoExecutionStartRequest) (RealtimeDemoExecutionResult, error) {
	task := strings.TrimSpace(input.Task)
	if task == "" {
		return RealtimeDemoExecutionResult{OK: false, Status: realtimeDemoExecutionStatusFailed, Error: errDemoExecutionMissingTask.Error()}, errDemoExecutionMissingTask
	}
	if s.runner == nil {
		errText := runnerErrorText(s.runnerErr)
		return RealtimeDemoExecutionResult{OK: false, Status: realtimeDemoExecutionStatusFailed, Error: errText}, errDemoExecutionRunnerRequired
	}

	demoURL := firstNonEmpty(strings.TrimSpace(input.DemoURL), strings.TrimSpace(input.TaskURL))
	demoID := firstNonEmpty(strings.TrimSpace(input.DemoSessionID), "demo_exec_"+safeDemoExecutionIDPart(task))
	demo, err := s.StartRealtimeDemoSurface(ctx, RealtimeDemoSurfaceStartRequest{
		MeetingSessionID: strings.TrimSpace(input.MeetingSessionID),
		DemoSessionID:    demoID,
		URL:              demoURL,
		Goal:             task,
		Instruction:      firstNonEmpty(strings.TrimSpace(input.UserInstruction), strings.TrimSpace(input.WorkerInstruction), "show progress for the current demo execution task"),
		Title:            firstNonEmpty(strings.TrimSpace(input.Title), "Demo execution"),
		Subtitle:         "Working surface",
		Actor:            strings.TrimSpace(input.Actor),
		Surface:          strings.TrimSpace(input.Surface),
		ChannelID:        strings.TrimSpace(input.ChannelID),
		ThreadTS:         strings.TrimSpace(input.ThreadTS),
	})
	if err != nil {
		return RealtimeDemoExecutionResult{OK: false, Status: realtimeDemoExecutionStatusFailed, Demo: &demo, Error: err.Error()}, err
	}

	preferences := s.demoExecutionUserPreferenceSnapshot()
	allowCodeChanges := true
	if input.AllowCodeChanges != nil {
		allowCodeChanges = *input.AllowCodeChanges
	}
	startInput := agentrunner.WithSessionCapabilities(agentrunner.StartInput{
		Task:             buildDemoExecutionWorkerTask(input, demo.SessionID),
		Context:          demoExecutionWorkerContext(input, demo, preferences),
		Mode:             firstNonEmpty(strings.TrimSpace(input.Mode), "code"),
		AllowCodeChanges: allowCodeChanges,
		Sandbox:          "workspace-write",
	}, agentrunner.SessionKindDemoExecution)
	job, err := s.runner.StartTask(ctx, startInput)
	if err != nil {
		_, _ = s.CancelRealtimeDemoSurface(ctx, RealtimeDemoSurfaceCancelRequest{
			MeetingSessionID: strings.TrimSpace(input.MeetingSessionID),
			DemoSessionID:    demo.SessionID,
			Reason:           "demo_execution_worker_start_failed",
		})
		return RealtimeDemoExecutionResult{OK: false, Status: realtimeDemoExecutionStatusFailed, Demo: &demo, Error: err.Error()}, err
	}

	result := RealtimeDemoExecutionResult{
		OK:                 true,
		Status:             realtimeDemoExecutionStatusStarted,
		Job:                &job,
		Demo:               &demo,
		UserPreferences:    preferences,
		Approval:           demoExecutionApprovalGate(input),
		FeedbackText:       "我开始做，进度看屏幕。",
		ShouldSpeak:        true,
		ObservationContext: demo.ObservationContext,
	}
	if report := s.ReportFinishedWorkerJob(ctx, job); report != nil {
		result.Report = report
		if job.Status == agentrunner.StatusCompleted {
			result.Status = realtimeDemoExecutionStatusCompleted
			if completionURL := demoExecutionDemoURLFromWorkerResult(job.Result); completionURL != "" {
				completion, _ := s.ControlRealtimeDemoSurface(ctx, RealtimeDemoSurfaceControlRequest{
					MeetingSessionID: strings.TrimSpace(input.MeetingSessionID),
					DemoSessionID:    demo.SessionID,
					Action:           DemoActionOpenURL,
					URL:              completionURL,
					Instruction:      "open completed demo result for presentation",
				})
				result.CompletionDemo = &completion
				result.ObservationContext = firstNonEmpty(completion.ObservationContext, result.ObservationContext)
			}
		}
		if job.Status == agentrunner.StatusFailed || job.Status == agentrunner.StatusTimeout {
			result.OK = false
			result.Status = realtimeDemoExecutionStatusFailed
			result.Error = firstNonEmpty(strings.TrimSpace(job.Error), string(job.Status))
			result.FeedbackText = "执行卡住了，我需要你看一下 blocker。"
		}
	}
	return result, nil
}

func buildDemoExecutionWorkerTask(input RealtimeDemoExecutionStartRequest, demoSessionID string) string {
	parts := []string{
		"You are the execution worker for Oneesama's live meeting demo.",
		"Do the requested task; do not return a plan-only answer.",
		"Keep progress suitable for a visual demo surface. Do not send Meet or Slack messages.",
		"Return exactly one JSON object when done: {\"status\":\"completed|blocked\",\"summary\":\"...\",\"demo_url\":\"https://...\",\"files_changed\":[],\"needs_approval\":[]}.",
		"If the user asks to close a Linear/issue/task, do not perform the external write. Put it in needs_approval instead.",
		"Demo session id: " + strings.TrimSpace(demoSessionID),
		"Task: " + strings.TrimSpace(input.Task),
	}
	if value := strings.TrimSpace(input.TaskURL); value != "" {
		parts = append(parts, "Task URL: "+value)
	}
	if value := strings.TrimSpace(input.UserInstruction); value != "" {
		parts = append(parts, "User instruction: "+value)
	}
	if value := strings.TrimSpace(input.WorkerInstruction); value != "" {
		parts = append(parts, "Worker instruction: "+value)
	}
	return strings.Join(parts, "\n\n")
}

func demoExecutionWorkerContext(input RealtimeDemoExecutionStartRequest, demo RealtimeDemoBridgeResult, preferences map[string]any) map[string]any {
	return map[string]any{
		"source":              "meeting_realtime_demo_execution",
		"task_url":            strings.TrimSpace(input.TaskURL),
		"issue_id":            strings.TrimSpace(input.IssueID),
		"issue_url":           strings.TrimSpace(input.IssueURL),
		"demo_session_id":     strings.TrimSpace(demo.SessionID),
		"meeting_session_id":  strings.TrimSpace(input.MeetingSessionID),
		"demo_observation":    strings.TrimSpace(demo.ObservationContext),
		"user_preferences":    cloneMap(preferences),
		"progress_contract":   "visual_demo_surface_primary_speech_only_on_start_failure_completion",
		"completion_contract": "return_json_with_demo_url_or_blocker",
		"external_write_policy": map[string]any{
			"issue_close_requires_approval": true,
		},
	}
}

func (s *Service) demoExecutionUserPreferenceSnapshot() map[string]any {
	currentUser := s.realtimeCurrentUser()
	return map[string]any{
		"no_planning":            true,
		"concise":                true,
		"progress_channel":       "demo_surface",
		"spoken_progress_policy": "state_transitions_only",
		"preferred_spoken_name":  realtimeCurrentUserSpokenName(currentUser),
	}
}

func demoExecutionApprovalGate(input RealtimeDemoExecutionStartRequest) *DemoExecutionApprovalGate {
	if !input.RequestIssueClose {
		return nil
	}
	return &DemoExecutionApprovalGate{
		Required:  true,
		Operation: "close_issue",
		Target:    firstNonEmpty(strings.TrimSpace(input.IssueURL), strings.TrimSpace(input.IssueID)),
		Reason:    "external_write_approval_required",
	}
}

func demoExecutionDemoURLFromWorkerResult(raw string) string {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return ""
	}
	for _, candidate := range demoCodexJSONCandidates(raw) {
		var payload struct {
			DemoURL string `json:"demo_url"`
			DemoUrl string `json:"demoUrl"`
			URL     string `json:"url"`
		}
		if err := json.Unmarshal([]byte(candidate), &payload); err != nil {
			continue
		}
		return firstNonEmpty(strings.TrimSpace(payload.DemoURL), strings.TrimSpace(payload.DemoUrl), strings.TrimSpace(payload.URL))
	}
	return ""
}

func safeDemoExecutionIDPart(raw string) string {
	raw = strings.ToLower(strings.TrimSpace(raw))
	if raw == "" {
		return newSessionID()
	}
	var b strings.Builder
	lastUnderscore := false
	for _, r := range raw {
		if b.Len() >= 24 {
			break
		}
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') {
			b.WriteRune(r)
			lastUnderscore = false
			continue
		}
		if b.Len() > 0 && !lastUnderscore {
			b.WriteByte('_')
			lastUnderscore = true
		}
	}
	out := strings.Trim(b.String(), "_")
	if out == "" {
		return newSessionID()
	}
	return out
}

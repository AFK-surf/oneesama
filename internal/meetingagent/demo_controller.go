package meetingagent

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"
)

var errDemoControllerMissingClient = errors.New("demo_controller_missing_kwwk_client")

type DemoIntent struct {
	Session     DemoKWWKSessionRef `json:"session"`
	Kind        DemoActionKind     `json:"kind"`
	URL         string             `json:"url,omitempty"`
	Instruction string             `json:"instruction,omitempty"`
	Direction   string             `json:"direction,omitempty"`
	Amount      int                `json:"amount,omitempty"`
	Rect        DemoKWWKRect       `json:"rect,omitempty"`
	Text        string             `json:"text,omitempty"`
	Sequence    int                `json:"sequence,omitempty"`
	Cancel      *DemoCancelToken   `json:"-"`
}

type DemoController struct {
	Client DemoKWWKClient
	Safety DemoSafetyPolicy
	Now    func() time.Time
}

type DemoControllerResult struct {
	Intent      DemoIntent        `json:"intent"`
	Verdict     DemoActionVerdict `json:"verdict"`
	Observation DemoObservation   `json:"observation"`
}

func (c DemoController) RunIntent(ctx context.Context, intent DemoIntent) (DemoControllerResult, error) {
	verdict := c.Safety.Decide(DemoActionRequest{
		Kind:   intent.Kind,
		URL:    intent.URL,
		Cancel: intent.Cancel,
	})
	result := DemoControllerResult{
		Intent:  intent,
		Verdict: verdict,
	}
	if verdict.Decision == DemoActionDecisionBlock {
		result.Observation = c.blockedObservation(intent, verdict)
		return result, nil
	}
	if c.Client == nil {
		err := errDemoControllerMissingClient
		result.Observation = c.failedObservation(intent, "adapter_missing")
		return result, err
	}

	kwwkResult, err := c.Client.DoDemoAction(ctx, DemoKWWKActionRequest{
		Session:     intent.Session,
		Kind:        intent.Kind,
		URL:         intent.URL,
		Instruction: intent.Instruction,
		Direction:   intent.Direction,
		Amount:      intent.Amount,
		Rect:        intent.Rect,
		Text:        intent.Text,
		DryRun:      verdict.Decision == DemoActionDecisionDryRun,
		Sequence:    intent.Sequence,
	})
	if err != nil {
		result.Observation = c.failedObservation(intent, "adapter_failed")
		return result, err
	}
	result.Observation = demoObservationFromKWWKResult(intent, kwwkResult)
	return result, nil
}

func (c DemoController) blockedObservation(intent DemoIntent, verdict DemoActionVerdict) DemoObservation {
	reason := strings.TrimSpace(verdict.Reason)
	if reason == "" {
		reason = "blocked"
	}
	return DemoObservation{
		SessionID:  intent.Session.SessionID,
		Sequence:   intent.Sequence,
		Source:     demoKWWKObservationSource,
		Kind:       demoObservationKindBlocked,
		Summary:    "demo action blocked: " + reason,
		Confidence: 1,
		CreatedAt:  c.timestamp(),
	}
}

func (c DemoController) failedObservation(intent DemoIntent, reason string) DemoObservation {
	reason = strings.TrimSpace(reason)
	if reason == "" {
		reason = "unknown"
	}
	return DemoObservation{
		SessionID:  intent.Session.SessionID,
		Sequence:   intent.Sequence,
		Source:     demoKWWKObservationSource,
		Kind:       demoObservationKindFailed,
		Summary:    "demo action failed: " + reason,
		Confidence: 1,
		CreatedAt:  c.timestamp(),
	}
}

func (c DemoController) timestamp() time.Time {
	if c.Now == nil {
		return time.Now()
	}
	return c.Now()
}

func demoObservationFromKWWKResult(intent DemoIntent, result DemoKWWKActionResult) DemoObservation {
	sequence := result.Sequence
	if sequence <= 0 {
		sequence = intent.Sequence
	}
	createdAt := result.CreatedAt
	if createdAt.IsZero() {
		createdAt = time.Now()
	}
	return DemoObservation{
		SessionID:  firstNonEmpty(result.SessionID, intent.Session.SessionID),
		Sequence:   sequence,
		Source:     firstNonEmpty(result.Source, demoKWWKObservationSource),
		Kind:       demoObservationKindForAction(intent.Kind),
		Summary:    strings.TrimSpace(result.Summary),
		Confidence: result.Confidence,
		FramePath:  strings.TrimSpace(result.FramePath),
		CreatedAt:  createdAt,
	}
}

func demoObservationKindForAction(action DemoActionKind) string {
	switch action {
	case DemoActionOpenURL:
		return demoObservationKindOpened
	case DemoActionCapture:
		return demoObservationKindScreenshot
	case DemoActionScroll:
		return demoObservationKindScrolled
	case DemoActionHighlight, DemoActionClick, DemoActionType:
		return demoObservationKindStep
	default:
		return fmt.Sprintf("action_%s", strings.TrimSpace(string(action)))
	}
}

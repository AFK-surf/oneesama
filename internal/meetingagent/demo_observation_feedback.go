package meetingagent

import (
	"regexp"
	"strings"
	"time"
)

// DemoObservation is the on-the-wire observation the KWWK/CU adapter emits
// to the demo surface bus. Field shape mirrors the JSON example in
// notes/rfc/kwwk-cu-demo-surface-poc-rfc-2026-05-21.md (DemoObservationBus
// section). Task #310.
type DemoObservation struct {
	SessionID  string    `json:"session_id"`
	Sequence   int       `json:"sequence"`
	Source     string    `json:"source"`
	Kind       string    `json:"kind"`
	Summary    string    `json:"summary"`
	Confidence float64   `json:"confidence"`
	FramePath  string    `json:"frame_path,omitempty"`
	CreatedAt  time.Time `json:"created_at"`
}

// DemoFeedbackKind is the three-state classification the RFC requires the
// renderer to distinguish so the avatar can speak honestly about what the
// adapter actually did.
type DemoFeedbackKind string

const (
	// DemoFeedbackOpened — adapter has at least one confident observation
	// of the requested surface (e.g. the page loaded, the dashboard
	// rendered).
	DemoFeedbackOpened DemoFeedbackKind = "opened"
	// DemoFeedbackStillLooking — adapter is mid-step and has not yet
	// reached a confident observation; speech should be a holding line.
	DemoFeedbackStillLooking DemoFeedbackKind = "still_looking"
	// DemoFeedbackCannotVerify — adapter ran but cannot honestly say it
	// saw the requested surface (failure, low confidence, blocked, or
	// only leaked debug noise).
	DemoFeedbackCannotVerify DemoFeedbackKind = "cannot_verify"
)

// DemoFeedback is the rendered output. Spoken is the meeting-safe utterance
// the realtime bridge may speak; AuditDetail is the long-form internal
// reason that goes into the audit trail only and must never be voiced.
// ShouldSpeak is false when the caller should stay silent rather than
// emit a canned filler line — silence > made-up text.
type DemoFeedback struct {
	Kind        DemoFeedbackKind
	Spoken      string
	ShouldSpeak bool
	AuditDetail string
}

// DemoFeedbackRenderer turns DemoObservation values into DemoFeedback. It
// has no realtime/Slack/Meet dependency; the caller owns delivery.
type DemoFeedbackRenderer struct {
	// ConfidenceFloor is the minimum confidence for an observation to be
	// rendered as DemoFeedbackOpened. Below it the renderer downgrades to
	// DemoFeedbackStillLooking (mid-step) or DemoFeedbackCannotVerify
	// (terminal kinds). Zero means "use the default 0.5".
	ConfidenceFloor float64
	// MaxSpokenChars caps the spoken utterance length. Zero means "use
	// the default 200". Truncation appends an ellipsis so the avatar
	// doesn't drone on about a wall of text.
	MaxSpokenChars int
}

const (
	defaultDemoFeedbackConfidenceFloor = 0.5
	defaultDemoFeedbackMaxSpokenChars  = 200
)

// Demo observation Kind values the renderer recognises. The full enum is
// owned by the adapter contract (304-B); the renderer just classifies kinds
// into terminal vs mid-step so it can pick the right feedback bucket.
const (
	demoObservationKindScreenshot = "screenshot_observation"
	demoObservationKindOpened     = "surface_opened"
	demoObservationKindScrolled   = "surface_scrolled"
	demoObservationKindStep       = "step_observation"
	demoObservationKindFailed     = "surface_failed"
	demoObservationKindBlocked    = "surface_blocked"
)

// toolTraceLeakPatterns are debug/log markers the renderer treats as
// "this summary is just internal noise". A summary that contains any of
// these is never spoken — it is downgraded to a silent
// DemoFeedbackCannotVerify with the leaked marker recorded in AuditDetail.
// Add a marker here when a new tool/runtime leaks into observations.
var toolTraceLeakPatterns = []string{
	"tool_call_id=",
	"trace_id=",
	"panic:",
	"goroutine ",
	"traceback",
	"stack trace",
	"errors.New(",
	"fmt.Errorf(",
	"\\u0000",
	"DEBUG ",
	"http://localhost",
	"file:///",
}

var collapseWhitespace = regexp.MustCompile(`\s+`)

// Render maps a single observation to a meeting-safe feedback. It never
// errors; degenerate input (empty summary, leaked debug noise, low
// confidence) returns ShouldSpeak=false so the caller stays silent.
func (r DemoFeedbackRenderer) Render(obs DemoObservation) DemoFeedback {
	cleaned := strings.TrimSpace(obs.Summary)
	if cleaned == "" {
		return DemoFeedback{
			Kind:        DemoFeedbackCannotVerify,
			ShouldSpeak: false,
			AuditDetail: "summary_empty",
		}
	}
	if leak, ok := matchToolTraceLeak(cleaned); ok {
		return DemoFeedback{
			Kind:        DemoFeedbackCannotVerify,
			ShouldSpeak: false,
			AuditDetail: "tool_trace_leak:" + leak,
		}
	}

	cleaned = collapseWhitespace.ReplaceAllString(cleaned, " ")
	spoken := truncateForSpeech(cleaned, r.maxSpokenChars())

	floor := r.confidenceFloor()
	switch obs.Kind {
	case demoObservationKindFailed, demoObservationKindBlocked:
		return DemoFeedback{
			Kind:        DemoFeedbackCannotVerify,
			Spoken:      spoken,
			ShouldSpeak: true,
			AuditDetail: "terminal_kind:" + obs.Kind,
		}
	case demoObservationKindOpened, demoObservationKindScreenshot:
		if obs.Confidence < floor {
			return DemoFeedback{
				Kind:        DemoFeedbackCannotVerify,
				Spoken:      spoken,
				ShouldSpeak: true,
				AuditDetail: "confidence_below_floor",
			}
		}
		return DemoFeedback{
			Kind:        DemoFeedbackOpened,
			Spoken:      spoken,
			ShouldSpeak: true,
			AuditDetail: "confident_open",
		}
	case demoObservationKindScrolled, demoObservationKindStep, "":
		if obs.Confidence < floor {
			return DemoFeedback{
				Kind:        DemoFeedbackStillLooking,
				ShouldSpeak: false,
				AuditDetail: "mid_step_low_confidence",
			}
		}
		return DemoFeedback{
			Kind:        DemoFeedbackStillLooking,
			Spoken:      spoken,
			ShouldSpeak: true,
			AuditDetail: "mid_step_confident",
		}
	default:
		return DemoFeedback{
			Kind:        DemoFeedbackCannotVerify,
			ShouldSpeak: false,
			AuditDetail: "unknown_observation_kind:" + obs.Kind,
		}
	}
}

func (r DemoFeedbackRenderer) confidenceFloor() float64 {
	if r.ConfidenceFloor <= 0 {
		return defaultDemoFeedbackConfidenceFloor
	}
	return r.ConfidenceFloor
}

func (r DemoFeedbackRenderer) maxSpokenChars() int {
	if r.MaxSpokenChars <= 0 {
		return defaultDemoFeedbackMaxSpokenChars
	}
	return r.MaxSpokenChars
}

func matchToolTraceLeak(summary string) (string, bool) {
	lower := strings.ToLower(summary)
	for _, marker := range toolTraceLeakPatterns {
		if strings.Contains(lower, strings.ToLower(marker)) {
			return marker, true
		}
	}
	return "", false
}

func truncateForSpeech(s string, maxChars int) string {
	if maxChars <= 0 {
		return s
	}
	runes := []rune(s)
	if len(runes) <= maxChars {
		return s
	}
	return strings.TrimRight(string(runes[:maxChars]), " ") + "…"
}

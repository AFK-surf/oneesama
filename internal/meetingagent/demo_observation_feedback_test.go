package meetingagent

import (
	"strings"
	"testing"
	"time"
)

// TestDemoFeedbackRendererMatrix pins the observation → feedback
// classification matrix. If a row changes intentionally, update the
// RFC ObservationFeedbackRenderer section and this matrix together.
// Task #310.
func TestDemoFeedbackRendererMatrix(t *testing.T) {
	cases := []struct {
		name            string
		renderer        DemoFeedbackRenderer
		obs             DemoObservation
		wantKind        DemoFeedbackKind
		wantShouldSpeak bool
		wantSpokenSub   string
		wantAuditSub    string
	}{
		{
			name:            "empty_summary_silent",
			renderer:        DemoFeedbackRenderer{},
			obs:             DemoObservation{Kind: demoObservationKindOpened, Confidence: 0.9},
			wantKind:        DemoFeedbackCannotVerify,
			wantShouldSpeak: false,
			wantAuditSub:    "summary_empty",
		},
		{
			name:     "opened_high_confidence_speaks",
			renderer: DemoFeedbackRenderer{},
			obs: DemoObservation{
				Kind:       demoObservationKindOpened,
				Summary:    "The PR diff shows a new nil check in service_triage.go.",
				Confidence: 0.85,
			},
			wantKind:        DemoFeedbackOpened,
			wantShouldSpeak: true,
			wantSpokenSub:   "PR diff",
			wantAuditSub:    "confident_open",
		},
		{
			name:     "screenshot_high_confidence_speaks_as_opened",
			renderer: DemoFeedbackRenderer{},
			obs: DemoObservation{
				Kind:       demoObservationKindScreenshot,
				Summary:    "Dashboard is rendered; latency graph in red.",
				Confidence: 0.8,
			},
			wantKind:        DemoFeedbackOpened,
			wantShouldSpeak: true,
			wantSpokenSub:   "Dashboard",
			wantAuditSub:    "confident_open",
		},
		{
			name:     "opened_low_confidence_downgrades_to_cannot_verify_but_still_speaks",
			renderer: DemoFeedbackRenderer{ConfidenceFloor: 0.7},
			obs: DemoObservation{
				Kind:       demoObservationKindOpened,
				Summary:    "Page loaded but layout looks unfamiliar.",
				Confidence: 0.4,
			},
			wantKind:        DemoFeedbackCannotVerify,
			wantShouldSpeak: true,
			wantSpokenSub:   "unfamiliar",
			wantAuditSub:    "confidence_below_floor",
		},
		{
			name:     "scrolled_high_confidence_speaks_as_still_looking",
			renderer: DemoFeedbackRenderer{},
			obs: DemoObservation{
				Kind:       demoObservationKindScrolled,
				Summary:    "Scrolled past the test plan section.",
				Confidence: 0.9,
			},
			wantKind:        DemoFeedbackStillLooking,
			wantShouldSpeak: true,
			wantSpokenSub:   "Scrolled",
			wantAuditSub:    "mid_step_confident",
		},
		{
			name:     "scrolled_low_confidence_silent_mid_step",
			renderer: DemoFeedbackRenderer{},
			obs: DemoObservation{
				Kind:       demoObservationKindScrolled,
				Summary:    "Scrolled but cannot identify section.",
				Confidence: 0.1,
			},
			wantKind:        DemoFeedbackStillLooking,
			wantShouldSpeak: false,
			wantAuditSub:    "mid_step_low_confidence",
		},
		{
			name:     "step_kind_treated_as_mid_step",
			renderer: DemoFeedbackRenderer{},
			obs: DemoObservation{
				Kind:       demoObservationKindStep,
				Summary:    "Clicked the diff tab.",
				Confidence: 0.9,
			},
			wantKind:        DemoFeedbackStillLooking,
			wantShouldSpeak: true,
			wantAuditSub:    "mid_step_confident",
		},
		{
			name:     "empty_kind_treated_as_mid_step",
			renderer: DemoFeedbackRenderer{},
			obs: DemoObservation{
				Summary:    "Adapter heartbeat.",
				Confidence: 0.9,
			},
			wantKind:        DemoFeedbackStillLooking,
			wantShouldSpeak: true,
			wantAuditSub:    "mid_step_confident",
		},
		{
			name:     "failed_kind_speaks_cannot_verify_regardless_of_confidence",
			renderer: DemoFeedbackRenderer{},
			obs: DemoObservation{
				Kind:       demoObservationKindFailed,
				Summary:    "Browser launch returned exit code 1.",
				Confidence: 0.95,
			},
			wantKind:        DemoFeedbackCannotVerify,
			wantShouldSpeak: true,
			wantSpokenSub:   "Browser",
			wantAuditSub:    "terminal_kind:" + demoObservationKindFailed,
		},
		{
			name:     "blocked_kind_speaks_cannot_verify",
			renderer: DemoFeedbackRenderer{},
			obs: DemoObservation{
				Kind:       demoObservationKindBlocked,
				Summary:    "URL not on allowlist.",
				Confidence: 0.99,
			},
			wantKind:        DemoFeedbackCannotVerify,
			wantShouldSpeak: true,
			wantSpokenSub:   "allowlist",
			wantAuditSub:    "terminal_kind:" + demoObservationKindBlocked,
		},
		{
			name:     "unknown_kind_silent",
			renderer: DemoFeedbackRenderer{},
			obs: DemoObservation{
				Kind:       "future_kind_we_dont_know_yet",
				Summary:    "Some data the renderer cannot classify.",
				Confidence: 0.9,
			},
			wantKind:        DemoFeedbackCannotVerify,
			wantShouldSpeak: false,
			wantAuditSub:    "unknown_observation_kind:future_kind_we_dont_know_yet",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := tc.renderer.Render(tc.obs)
			if got.Kind != tc.wantKind {
				t.Fatalf("Kind = %q, want %q (audit=%q)", got.Kind, tc.wantKind, got.AuditDetail)
			}
			if got.ShouldSpeak != tc.wantShouldSpeak {
				t.Fatalf("ShouldSpeak = %v, want %v (spoken=%q audit=%q)", got.ShouldSpeak, tc.wantShouldSpeak, got.Spoken, got.AuditDetail)
			}
			if tc.wantSpokenSub != "" && !strings.Contains(got.Spoken, tc.wantSpokenSub) {
				t.Fatalf("Spoken %q missing substring %q", got.Spoken, tc.wantSpokenSub)
			}
			if !tc.wantShouldSpeak && got.Spoken != "" {
				t.Fatalf("ShouldSpeak=false but Spoken=%q — silent verdicts must not carry spoken text", got.Spoken)
			}
			if tc.wantAuditSub != "" && !strings.Contains(got.AuditDetail, tc.wantAuditSub) {
				t.Fatalf("AuditDetail = %q, want substring %q", got.AuditDetail, tc.wantAuditSub)
			}
		})
	}
}

// TestDemoFeedbackRendererStripsToolTraceLeak pins that any of the known
// tool-trace / debug markers in a summary force a silent verdict. The
// renderer must never voice internal debug text to the meeting; the leak
// is recorded in AuditDetail only so the operator can find it.
func TestDemoFeedbackRendererStripsToolTraceLeak(t *testing.T) {
	cases := []struct {
		name    string
		summary string
		wantSub string
	}{
		{"tool_call_id", "Opened the page. tool_call_id=abc-123 reply.", "tool_call_id="},
		{"panic_marker", "Visited the URL. panic: nil dereference at frame 0", "panic:"},
		{"goroutine_marker", "Adapter dump: goroutine 42 [running]", "goroutine "},
		{"traceback_marker", "Click failed: Traceback (most recent call last)", "traceback"},
		{"stack_trace_marker", "Hit stack trace overflow", "stack trace"},
		{"fmt_errorf_marker", `Wrapped: fmt.Errorf("open failed: %w", err)`, "fmt.Errorf("},
		{"errors_new_marker", `errors.New("bad state") from adapter`, "errors.New("},
		{"debug_marker", "DEBUG observation pipeline tick 47", "DEBUG "},
		{"localhost_leak", "Resolved via http://localhost:9000/adapter", "http://localhost"},
		{"file_leak", "Frame stored at file:///tmp/x.png", "file:///"},
		{"trace_id_leak", "Saw the page. trace_id=01HQ", "trace_id="},
	}
	r := DemoFeedbackRenderer{}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			fb := r.Render(DemoObservation{
				Kind:       demoObservationKindOpened,
				Summary:    tc.summary,
				Confidence: 0.99,
			})
			if fb.ShouldSpeak {
				t.Fatalf("leaked summary spoke aloud: %q", fb.Spoken)
			}
			if fb.Kind != DemoFeedbackCannotVerify {
				t.Fatalf("Kind = %q, want cannot_verify", fb.Kind)
			}
			if !strings.HasPrefix(fb.AuditDetail, "tool_trace_leak:") {
				t.Fatalf("AuditDetail = %q, want prefix tool_trace_leak:", fb.AuditDetail)
			}
			if !strings.Contains(fb.AuditDetail, tc.wantSub) {
				t.Fatalf("AuditDetail = %q, want substring %q", fb.AuditDetail, tc.wantSub)
			}
		})
	}
}

// TestDemoFeedbackRendererTruncatesLongSummary pins that the renderer caps
// the spoken length so a verbose adapter cannot make the avatar monologue.
// Truncation appends an ellipsis so the operator can tell from the audit
// that the spoken form was clipped.
func TestDemoFeedbackRendererTruncatesLongSummary(t *testing.T) {
	long := strings.Repeat("ABCDEFGHIJ", 30) // 300 chars, > default 200
	r := DemoFeedbackRenderer{}
	fb := r.Render(DemoObservation{
		Kind:       demoObservationKindOpened,
		Summary:    long,
		Confidence: 0.9,
		CreatedAt:  time.Now(),
	})
	if !fb.ShouldSpeak {
		t.Fatalf("ShouldSpeak = false, want true")
	}
	if len([]rune(fb.Spoken)) > defaultDemoFeedbackMaxSpokenChars+1 {
		t.Fatalf("Spoken length %d exceeds cap %d", len([]rune(fb.Spoken)), defaultDemoFeedbackMaxSpokenChars+1)
	}
	if !strings.HasSuffix(fb.Spoken, "…") {
		t.Fatalf("Spoken missing ellipsis: %q", fb.Spoken)
	}
}

// TestDemoFeedbackRendererCustomLimitsHonored pins the configurable
// ConfidenceFloor + MaxSpokenChars knobs so an operator can tighten them
// per session without forking the renderer.
func TestDemoFeedbackRendererCustomLimitsHonored(t *testing.T) {
	r := DemoFeedbackRenderer{ConfidenceFloor: 0.95, MaxSpokenChars: 12}
	fb := r.Render(DemoObservation{
		Kind:       demoObservationKindOpened,
		Summary:    "Mostly there but not quite",
		Confidence: 0.9, // below custom floor
	})
	if fb.Kind != DemoFeedbackCannotVerify {
		t.Fatalf("Kind = %q, want cannot_verify (custom floor 0.95)", fb.Kind)
	}
	if len([]rune(fb.Spoken)) > 13 {
		t.Fatalf("Spoken length %d exceeds custom cap 12 (+ellipsis)", len([]rune(fb.Spoken)))
	}
	if !strings.HasSuffix(fb.Spoken, "…") {
		t.Fatalf("Spoken missing ellipsis on custom-cap truncation: %q", fb.Spoken)
	}
}

// TestDemoFeedbackRendererCollapsesWhitespace pins that the renderer
// normalizes leaked formatting (tabs, double spaces, newlines) so the
// avatar speaks fluent text instead of "uh ... uh ... uh".
func TestDemoFeedbackRendererCollapsesWhitespace(t *testing.T) {
	r := DemoFeedbackRenderer{}
	fb := r.Render(DemoObservation{
		Kind:       demoObservationKindOpened,
		Summary:    "Opened\tthe\n\npage.\n\nDashboard  visible.",
		Confidence: 0.9,
	})
	if !fb.ShouldSpeak {
		t.Fatalf("ShouldSpeak = false, want true")
	}
	if strings.Contains(fb.Spoken, "\n") || strings.Contains(fb.Spoken, "\t") || strings.Contains(fb.Spoken, "  ") {
		t.Fatalf("Spoken still contains raw whitespace: %q", fb.Spoken)
	}
}

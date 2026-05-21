package meetingagent

import (
	"errors"
	"testing"
)

// TestDemoSafetyPolicyDecideMatrix pins the per-action × per-flag verdict
// matrix the host-run POC depends on. If a row changes intentionally,
// update the matrix here AND the AllowlistAndSafetyPolicy section of
// notes/rfc/kwwk-cu-demo-surface-poc-rfc-2026-05-21.md together. Task #311.
func TestDemoSafetyPolicyDecideMatrix(t *testing.T) {
	cases := []struct {
		name         string
		policy       DemoSafetyPolicy
		req          DemoActionRequest
		wantDecision DemoActionDecision
		wantReason   string
	}{
		// open_url — allowlist matching.
		{
			name:         "open_url_empty_blocked",
			policy:       DemoSafetyPolicy{URLAllowlistPatterns: []string{"https://github.com/"}},
			req:          DemoActionRequest{Kind: DemoActionOpenURL, URL: ""},
			wantDecision: DemoActionDecisionBlock,
			wantReason:   "url_empty",
		},
		{
			name:         "open_url_unparseable_blocked",
			policy:       DemoSafetyPolicy{URLAllowlistPatterns: []string{"https://github.com/"}},
			req:          DemoActionRequest{Kind: DemoActionOpenURL, URL: "ht!tp://%%bad"},
			wantDecision: DemoActionDecisionBlock,
			wantReason:   "url_unparseable",
		},
		{
			name:         "open_url_file_scheme_blocked",
			policy:       DemoSafetyPolicy{URLAllowlistPatterns: []string{"https://github.com/"}},
			req:          DemoActionRequest{Kind: DemoActionOpenURL, URL: "file:///etc/passwd"},
			wantDecision: DemoActionDecisionBlock,
			wantReason:   "url_scheme_blocked",
		},
		{
			name:         "open_url_javascript_scheme_blocked",
			policy:       DemoSafetyPolicy{URLAllowlistPatterns: []string{"https://github.com/"}},
			req:          DemoActionRequest{Kind: DemoActionOpenURL, URL: "javascript:alert(1)"},
			wantDecision: DemoActionDecisionBlock,
			wantReason:   "url_scheme_blocked",
		},
		{
			name:         "open_url_missing_host_blocked",
			policy:       DemoSafetyPolicy{URLAllowlistPatterns: []string{"https://github.com/"}},
			req:          DemoActionRequest{Kind: DemoActionOpenURL, URL: "https:///path"},
			wantDecision: DemoActionDecisionBlock,
			wantReason:   "url_host_missing",
		},
		{
			name:         "open_url_allowlist_host_prefix_allowed",
			policy:       DemoSafetyPolicy{URLAllowlistPatterns: []string{"https://github.com/"}},
			req:          DemoActionRequest{Kind: DemoActionOpenURL, URL: "https://github.com/anthropics/claude-code/pull/42"},
			wantDecision: DemoActionDecisionAllow,
			wantReason:   "url_allowlisted",
		},
		{
			name:         "open_url_allowlist_repo_prefix_allowed",
			policy:       DemoSafetyPolicy{URLAllowlistPatterns: []string{"https://github.com/anthropics/"}},
			req:          DemoActionRequest{Kind: DemoActionOpenURL, URL: "https://github.com/anthropics/claude-code"},
			wantDecision: DemoActionDecisionAllow,
			wantReason:   "url_allowlisted",
		},
		{
			name:         "open_url_allowlist_other_repo_blocked",
			policy:       DemoSafetyPolicy{URLAllowlistPatterns: []string{"https://github.com/anthropics/"}},
			req:          DemoActionRequest{Kind: DemoActionOpenURL, URL: "https://github.com/openai/codex"},
			wantDecision: DemoActionDecisionBlock,
			wantReason:   "url_not_allowlisted",
		},
		{
			name:         "open_url_other_host_blocked",
			policy:       DemoSafetyPolicy{URLAllowlistPatterns: []string{"https://github.com/"}},
			req:          DemoActionRequest{Kind: DemoActionOpenURL, URL: "https://evil.example.com/"},
			wantDecision: DemoActionDecisionBlock,
			wantReason:   "url_not_allowlisted",
		},
		{
			name:         "open_url_session_approved_overrides_missing_allowlist",
			policy:       DemoSafetyPolicy{ApprovedSessionURLs: []string{"https://linear.app/team/issue/ENG-42"}},
			req:          DemoActionRequest{Kind: DemoActionOpenURL, URL: "https://linear.app/team/issue/ENG-42"},
			wantDecision: DemoActionDecisionAllow,
			wantReason:   "url_session_approved",
		},
		{
			name:         "open_url_session_approved_differs_blocked",
			policy:       DemoSafetyPolicy{ApprovedSessionURLs: []string{"https://linear.app/team/issue/ENG-42"}},
			req:          DemoActionRequest{Kind: DemoActionOpenURL, URL: "https://linear.app/team/issue/ENG-99"},
			wantDecision: DemoActionDecisionBlock,
			wantReason:   "url_not_allowlisted",
		},
		// Loopback hosts must go through ApprovedSessionURLs, never the
		// static allowlist — driver #305 callout to avoid bot-owned profile
		// being tricked into reading user's local files via a permissive
		// pattern.
		{
			name:         "open_url_localhost_not_via_static_allowlist",
			policy:       DemoSafetyPolicy{URLAllowlistPatterns: []string{"http://"}},
			req:          DemoActionRequest{Kind: DemoActionOpenURL, URL: "http://localhost:8080/admin"},
			wantDecision: DemoActionDecisionBlock,
			wantReason:   "url_loopback_requires_session_approval",
		},
		{
			name:         "open_url_127_0_0_1_not_via_static_allowlist",
			policy:       DemoSafetyPolicy{URLAllowlistPatterns: []string{"http://127.0.0.1/"}},
			req:          DemoActionRequest{Kind: DemoActionOpenURL, URL: "http://127.0.0.1:9000/"},
			wantDecision: DemoActionDecisionBlock,
			wantReason:   "url_loopback_requires_session_approval",
		},
		{
			name:         "open_url_localhost_via_session_approval_allowed",
			policy:       DemoSafetyPolicy{ApprovedSessionURLs: []string{"http://localhost:3000/dashboard"}},
			req:          DemoActionRequest{Kind: DemoActionOpenURL, URL: "http://localhost:3000/dashboard"},
			wantDecision: DemoActionDecisionAllow,
			wantReason:   "url_session_approved",
		},
		// capture is always allowed — read-only.
		{
			name:         "capture_default_allowed",
			policy:       DemoSafetyPolicy{},
			req:          DemoActionRequest{Kind: DemoActionCapture},
			wantDecision: DemoActionDecisionAllow,
			wantReason:   "read_only_action",
		},
		{
			name:         "capture_dry_run_still_allowed",
			policy:       DemoSafetyPolicy{DryRun: true},
			req:          DemoActionRequest{Kind: DemoActionCapture},
			wantDecision: DemoActionDecisionAllow,
			wantReason:   "read_only_action",
		},
		// scroll/highlight — passive mutation: allow unless dry-run.
		// AllowActiveControl=false must NOT block these (driver feedback).
		{
			name:         "scroll_default_allowed_even_without_active_control",
			policy:       DemoSafetyPolicy{},
			req:          DemoActionRequest{Kind: DemoActionScroll},
			wantDecision: DemoActionDecisionAllow,
			wantReason:   "passive_mutation_allowed",
		},
		{
			name:         "highlight_default_allowed_even_without_active_control",
			policy:       DemoSafetyPolicy{},
			req:          DemoActionRequest{Kind: DemoActionHighlight},
			wantDecision: DemoActionDecisionAllow,
			wantReason:   "passive_mutation_allowed",
		},
		{
			name:         "scroll_dry_run_returns_dry_run",
			policy:       DemoSafetyPolicy{DryRun: true},
			req:          DemoActionRequest{Kind: DemoActionScroll},
			wantDecision: DemoActionDecisionDryRun,
			wantReason:   "dry_run_passive_mutation",
		},
		{
			name:         "highlight_dry_run_returns_dry_run",
			policy:       DemoSafetyPolicy{DryRun: true},
			req:          DemoActionRequest{Kind: DemoActionHighlight},
			wantDecision: DemoActionDecisionDryRun,
			wantReason:   "dry_run_passive_mutation",
		},
		// click/type — gated by AllowActiveControl; block by default
		// even when DryRun=true (block wins over dry-run for the
		// active-control gate so the POC can't accidentally exercise
		// click/type pre-approval).
		{
			name:         "click_default_blocked",
			policy:       DemoSafetyPolicy{},
			req:          DemoActionRequest{Kind: DemoActionClick},
			wantDecision: DemoActionDecisionBlock,
			wantReason:   "active_control_disabled",
		},
		{
			name:         "type_default_blocked",
			policy:       DemoSafetyPolicy{},
			req:          DemoActionRequest{Kind: DemoActionType},
			wantDecision: DemoActionDecisionBlock,
			wantReason:   "active_control_disabled",
		},
		{
			name:         "click_dry_run_without_active_control_still_blocked",
			policy:       DemoSafetyPolicy{DryRun: true},
			req:          DemoActionRequest{Kind: DemoActionClick},
			wantDecision: DemoActionDecisionBlock,
			wantReason:   "active_control_disabled",
		},
		{
			name:         "click_active_control_allowed",
			policy:       DemoSafetyPolicy{AllowActiveControl: true},
			req:          DemoActionRequest{Kind: DemoActionClick},
			wantDecision: DemoActionDecisionAllow,
			wantReason:   "active_control_approved",
		},
		{
			name:         "type_active_control_allowed",
			policy:       DemoSafetyPolicy{AllowActiveControl: true},
			req:          DemoActionRequest{Kind: DemoActionType},
			wantDecision: DemoActionDecisionAllow,
			wantReason:   "active_control_approved",
		},
		{
			name:         "click_active_control_dry_run_returns_dry_run",
			policy:       DemoSafetyPolicy{AllowActiveControl: true, DryRun: true},
			req:          DemoActionRequest{Kind: DemoActionClick},
			wantDecision: DemoActionDecisionDryRun,
			wantReason:   "dry_run_active_control",
		},
		// Unknown action kind — defensive, since the controller could
		// hand us a typo from a future schema change.
		{
			name:         "unknown_kind_blocked",
			policy:       DemoSafetyPolicy{AllowActiveControl: true},
			req:          DemoActionRequest{Kind: DemoActionKind("hover")},
			wantDecision: DemoActionDecisionBlock,
			wantReason:   "unknown_action_kind",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := tc.policy.Decide(tc.req)
			if got.Action != tc.req.Kind {
				t.Fatalf("Action = %q, want %q", got.Action, tc.req.Kind)
			}
			if got.Decision != tc.wantDecision {
				t.Fatalf("Decision = %q, want %q (reason=%q)", got.Decision, tc.wantDecision, got.Reason)
			}
			if got.Reason != tc.wantReason {
				t.Fatalf("Reason = %q, want %q", got.Reason, tc.wantReason)
			}
		})
	}
}

// TestDemoSafetyPolicyCancelShortCircuits pins that a cancelled token wins
// over every other check, so a single token can stop the demo even mid-step
// before any allowlist work runs. Reason must be `demo_cancelled` so the
// realtime bridge can route stop utterances through one consistent audit
// code.
func TestDemoSafetyPolicyCancelShortCircuits(t *testing.T) {
	token := NewDemoCancelToken()
	token.Cancel("user_said_stop")

	policy := DemoSafetyPolicy{
		URLAllowlistPatterns: []string{"https://github.com/"},
		AllowActiveControl:   true,
	}
	cases := []DemoActionRequest{
		{Kind: DemoActionOpenURL, URL: "https://github.com/anthropics/claude-code", Cancel: token},
		{Kind: DemoActionCapture, Cancel: token},
		{Kind: DemoActionScroll, Cancel: token},
		{Kind: DemoActionHighlight, Cancel: token},
		{Kind: DemoActionClick, Cancel: token},
		{Kind: DemoActionType, Cancel: token},
	}
	for _, req := range cases {
		t.Run(string(req.Kind), func(t *testing.T) {
			v := policy.Decide(req)
			if v.Decision != DemoActionDecisionBlock {
				t.Fatalf("cancelled token Decision = %q, want block", v.Decision)
			}
			if v.Reason != "demo_cancelled" {
				t.Fatalf("cancelled token Reason = %q, want demo_cancelled", v.Reason)
			}
		})
	}
}

// TestDemoSafetyPolicyDecideIgnoresUnsetCancel covers the common case where
// the controller hasn't wired a token yet — the policy must still produce a
// normal verdict instead of panicking on a nil dereference.
func TestDemoSafetyPolicyDecideIgnoresUnsetCancel(t *testing.T) {
	policy := DemoSafetyPolicy{URLAllowlistPatterns: []string{"https://github.com/"}}
	v := policy.Decide(DemoActionRequest{Kind: DemoActionOpenURL, URL: "https://github.com/foo"})
	if v.Decision != DemoActionDecisionAllow {
		t.Fatalf("Decision = %q, want allow (reason=%q)", v.Decision, v.Reason)
	}
}

// TestDemoCancelTokenFirstReasonWins covers the audit-trail invariant: the
// first Cancel call's reason is kept, later calls are no-ops. This lets the
// controller call Cancel(...) defensively without overwriting why the
// session actually stopped.
func TestDemoCancelTokenFirstReasonWins(t *testing.T) {
	token := NewDemoCancelToken()
	if cancelled, _ := token.Cancelled(); cancelled {
		t.Fatalf("fresh token should not be cancelled")
	}
	if err := token.Err(); err != nil {
		t.Fatalf("fresh token Err = %v, want nil", err)
	}
	token.Cancel("user_said_stop")
	token.Cancel("controller_timeout")

	cancelled, reason := token.Cancelled()
	if !cancelled {
		t.Fatalf("token should be cancelled after Cancel")
	}
	if reason != "user_said_stop" {
		t.Fatalf("Cancelled reason = %q, want user_said_stop", reason)
	}
	if err := token.Err(); !errors.Is(err, errDemoSafetyCancelled) {
		t.Fatalf("Err = %v, want errDemoSafetyCancelled", err)
	}
}

// TestDemoCancelTokenEmptyReasonDefaults pins the fallback reason used when
// the caller passes an empty cancel reason — keeps the audit trail
// non-empty.
func TestDemoCancelTokenEmptyReasonDefaults(t *testing.T) {
	token := NewDemoCancelToken()
	token.Cancel("")
	_, reason := token.Cancelled()
	if reason != "cancelled_no_reason" {
		t.Fatalf("empty Cancel reason = %q, want cancelled_no_reason", reason)
	}
}

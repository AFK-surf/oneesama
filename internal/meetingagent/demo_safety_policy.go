package meetingagent

import (
	"errors"
	"net"
	"net/url"
	"strings"
	"sync"
)

// DemoActionKind enumerates the bounded set of Computer Use demo actions the
// host-run POC may attempt. Anything outside this set is rejected at the
// policy boundary so the realtime/controller layers cannot smuggle in raw CU
// steps. Task #311 / RFC AllowlistAndSafetyPolicy.
type DemoActionKind string

const (
	DemoActionOpenURL   DemoActionKind = "open_url"
	DemoActionCapture   DemoActionKind = "capture"
	DemoActionScroll    DemoActionKind = "scroll"
	DemoActionHighlight DemoActionKind = "highlight"
	DemoActionClick     DemoActionKind = "click"
	DemoActionType      DemoActionKind = "type"
)

// DemoActionDecision is the three-valued policy verdict. `dry_run` exists so
// active operations can run end-to-end against the host browser without side
// effects while the approval gate is still missing.
type DemoActionDecision string

const (
	DemoActionDecisionAllow  DemoActionDecision = "allow"
	DemoActionDecisionBlock  DemoActionDecision = "block"
	DemoActionDecisionDryRun DemoActionDecision = "dry_run"
)

var errDemoSafetyCancelled = errors.New("demo_safety_cancelled")

// DemoSafetyPolicy is the host-run POC safety boundary. It is a pure decision
// module: it does not call the browser, the meeting, realtime, or Slack. The
// caller is responsible for honoring the verdict (run / dry-run / skip) and
// for routing the reason code into the session audit trail.
type DemoSafetyPolicy struct {
	// URLAllowlistPatterns are static prefixes the policy will always allow
	// for `open_url`. They are matched after URL normalization (scheme +
	// host + path prefix) so an entry like "https://github.com/" allows any
	// page under that host. Patterns must include scheme to avoid
	// http/https confusion. Loopback hosts (localhost / 127.0.0.1 / ::1)
	// are never matched here, only via ApprovedSessionURLs.
	URLAllowlistPatterns []string
	// ApprovedSessionURLs are exact URLs an operator/meeting flow has
	// explicitly approved for this session (e.g. links mentioned in the
	// thread). They bypass the static allowlist but still must pass scheme
	// validation. This is the only path to loopback URLs.
	ApprovedSessionURLs []string
	// DryRun forces operations that mutate page state (scroll, highlight,
	// click, type) to return `dry_run` instead of `allow`. Read-only
	// operations (open_url, capture) are unaffected. Use during host-run
	// POC bring-up when the adapter is wired but should not yet drive the
	// page.
	DryRun bool
	// AllowActiveControl unlocks `click` and `type`. When false (the POC
	// default) those actions are always blocked, regardless of DryRun.
	// Flipping this to true requires the approval gate that 304-G defers
	// to a follow-up task.
	AllowActiveControl bool
}

// DemoActionRequest is the input to Decide. URL is only consulted for
// `open_url`; other action kinds ignore it. Cancel is optional — when set
// and cancelled, the verdict short-circuits to block / demo_cancelled
// before any other check, so a single token can stop the whole session.
type DemoActionRequest struct {
	Kind   DemoActionKind
	URL    string
	Cancel *DemoCancelToken
}

// DemoActionVerdict is the audit-friendly output. Reason is a snake_case
// code suitable for logging into the session audit trail; callers should not
// rewrite it into a user-facing string here. The presenter/feedback layers
// own the meeting-visible phrasing.
type DemoActionVerdict struct {
	Action   DemoActionKind
	Decision DemoActionDecision
	Reason   string
}

// Decide returns the verdict for a single action request. It never errors;
// failures are encoded as `block` with a snake_case reason.
func (p DemoSafetyPolicy) Decide(req DemoActionRequest) DemoActionVerdict {
	v := DemoActionVerdict{Action: req.Kind}
	if req.Cancel != nil {
		if cancelled, _ := req.Cancel.Cancelled(); cancelled {
			v.Decision = DemoActionDecisionBlock
			v.Reason = "demo_cancelled"
			return v
		}
	}
	switch req.Kind {
	case DemoActionOpenURL:
		v.Decision, v.Reason = p.decideOpenURL(req.URL)
	case DemoActionCapture:
		v.Decision = DemoActionDecisionAllow
		v.Reason = "read_only_action"
	case DemoActionScroll, DemoActionHighlight:
		if p.DryRun {
			v.Decision = DemoActionDecisionDryRun
			v.Reason = "dry_run_passive_mutation"
		} else {
			v.Decision = DemoActionDecisionAllow
			v.Reason = "passive_mutation_allowed"
		}
	case DemoActionClick, DemoActionType:
		if !p.AllowActiveControl {
			v.Decision = DemoActionDecisionBlock
			v.Reason = "active_control_disabled"
			return v
		}
		if p.DryRun {
			v.Decision = DemoActionDecisionDryRun
			v.Reason = "dry_run_active_control"
		} else {
			v.Decision = DemoActionDecisionAllow
			v.Reason = "active_control_approved"
		}
	default:
		v.Decision = DemoActionDecisionBlock
		v.Reason = "unknown_action_kind"
	}
	return v
}

func (p DemoSafetyPolicy) decideOpenURL(raw string) (DemoActionDecision, string) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return DemoActionDecisionBlock, "url_empty"
	}
	parsed, err := url.Parse(trimmed)
	if err != nil {
		return DemoActionDecisionBlock, "url_unparseable"
	}
	scheme := strings.ToLower(parsed.Scheme)
	if scheme != "http" && scheme != "https" {
		return DemoActionDecisionBlock, "url_scheme_blocked"
	}
	if parsed.Host == "" {
		return DemoActionDecisionBlock, "url_host_missing"
	}
	normalized := normalizeDemoURL(parsed)
	for _, exact := range p.ApprovedSessionURLs {
		if normalizeDemoURLString(exact) == normalized {
			return DemoActionDecisionAllow, "url_session_approved"
		}
	}
	if isLoopbackHost(parsed.Hostname()) {
		return DemoActionDecisionBlock, "url_loopback_requires_session_approval"
	}
	for _, pattern := range p.URLAllowlistPatterns {
		if matchesDemoURLPrefix(pattern, normalized) {
			return DemoActionDecisionAllow, "url_allowlisted"
		}
	}
	return DemoActionDecisionBlock, "url_not_allowlisted"
}

func normalizeDemoURL(u *url.URL) string {
	scheme := strings.ToLower(u.Scheme)
	host := strings.ToLower(u.Host)
	path := u.Path
	if path == "" {
		path = "/"
	}
	return scheme + "://" + host + path
}

func normalizeDemoURLString(raw string) string {
	parsed, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || parsed.Host == "" {
		return strings.TrimSpace(raw)
	}
	return normalizeDemoURL(parsed)
}

func matchesDemoURLPrefix(pattern, normalized string) bool {
	pattern = strings.TrimSpace(pattern)
	if pattern == "" {
		return false
	}
	parsed, err := url.Parse(pattern)
	if err != nil || parsed.Host == "" {
		return false
	}
	prefix := normalizeDemoURL(parsed)
	return strings.HasPrefix(normalized, prefix)
}

func isLoopbackHost(host string) bool {
	host = strings.ToLower(strings.TrimSpace(host))
	if host == "" {
		return false
	}
	if host == "localhost" {
		return true
	}
	if ip := net.ParseIP(host); ip != nil && ip.IsLoopback() {
		return true
	}
	return false
}

// DemoCancelToken is the explicit stop/cancel interrupt described by the RFC.
// It is independent from DemoSafetyPolicy so a single token can govern the
// whole demo session while policy can be re-evaluated per action. The token
// is safe to share across goroutines.
type DemoCancelToken struct {
	mu        sync.RWMutex
	cancelled bool
	reason    string
}

// NewDemoCancelToken returns a fresh, uncancelled token.
func NewDemoCancelToken() *DemoCancelToken {
	return &DemoCancelToken{}
}

// Cancel flips the token. Reason is recorded for the first cancel only;
// later calls are no-ops so the audit trail keeps the original trigger.
func (t *DemoCancelToken) Cancel(reason string) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.cancelled {
		return
	}
	t.cancelled = true
	t.reason = strings.TrimSpace(reason)
	if t.reason == "" {
		t.reason = "cancelled_no_reason"
	}
}

// Cancelled reports whether the token has been cancelled, plus the recorded
// reason if so.
func (t *DemoCancelToken) Cancelled() (bool, string) {
	t.mu.RLock()
	defer t.mu.RUnlock()
	return t.cancelled, t.reason
}

// Err returns a sentinel error if the token has been cancelled, suitable for
// short-circuiting controller loops with `errors.Is(err, ...)` patterns.
func (t *DemoCancelToken) Err() error {
	cancelled, _ := t.Cancelled()
	if !cancelled {
		return nil
	}
	return errDemoSafetyCancelled
}

package slackagent

import (
	"context"
	"strings"
	"testing"
)

// TestSlackToolParityReportBucketsByFourClassStatus pins the four-class
// taxonomy (`active` / `validation_only` / `registered_unavailable` /
// `product_excluded`) that the parity endpoint advertises so future spec
// edits can't quietly collapse two buckets together.
func TestSlackToolParityReportBucketsByFourClassStatus(t *testing.T) {
	svc := &Service{}
	report := svc.SlackToolParityReport()

	if report.OK != true {
		t.Fatalf("report.OK = %v, want true", report.OK)
	}
	if report.Schema != slackToolParitySchema {
		t.Fatalf("report.Schema = %q, want %q", report.Schema, slackToolParitySchema)
	}

	got := make(map[string]string, len(report.Tools))
	for _, spec := range report.Tools {
		got[spec.Name] = spec.Status
	}

	wantStatus := map[string]string{
		"slack_api":            "active",
		"read_doc":             "active",
		"person_memory":        "active",
		"followup_memory":      "active",
		"suggest_action":       "active",
		"runtime_status":       "active",
		"heartbeat_log":        "active",
		"memory_search":        "active",
		"memory_get":           "active",
		"memory_write":         "active",
		"exa_search":           "active",
		"exa_contents":         "active",
		"manage_schedule":      "active",
		"notify_meeting_slack": "active",
		"usage_api":            "validation_only",
		"send_meeting_chat":    "product_excluded",
		"image_generation":     "product_excluded",
		"audio_generation":     "product_excluded",
		"linear_api":           "product_excluded",
		"notion_api":           "product_excluded",
		"google_calendar_api":  "product_excluded",
		"figma_api":            "product_excluded",
	}
	for name, want := range wantStatus {
		if got[name] != want {
			t.Errorf("tool %q status = %q, want %q", name, got[name], want)
		}
	}

	if contains(report.ActiveTools, "usage_api") {
		t.Error("usage_api must NOT appear in ActiveTools because it is validation_only")
	}
	if !contains(report.ValidationOnlyTools, "usage_api") {
		t.Errorf("ValidationOnlyTools = %v, want to include usage_api", report.ValidationOnlyTools)
	}
	if !contains(report.ExcludedTools, "linear_api") {
		t.Errorf("ExcludedTools = %v, want to include linear_api", report.ExcludedTools)
	}
	if contains(report.ActiveTools, "linear_api") {
		t.Error("product_excluded tools must not be in ActiveTools")
	}

	// Every advertised tool must show up in exactly one of the canonical buckets.
	canonical := map[string]bool{}
	for _, name := range report.ActiveTools {
		canonical[name] = true
	}
	for _, name := range report.ValidationOnlyTools {
		canonical[name] = true
	}
	for _, name := range report.RegisteredUnavailableTools {
		canonical[name] = true
	}
	for _, name := range report.ExcludedTools {
		canonical[name] = true
	}
	for _, spec := range report.Tools {
		if !canonical[spec.Name] {
			t.Errorf("tool %q (status=%q) missing from all canonical buckets", spec.Name, spec.Status)
		}
	}
}

// TestSlackAPIMethodParityBucketsRegisteredUnavailable confirms the slack_api
// method matrix flags the Canvas / DM / image methods as
// `registered_unavailable` so the parity surface stays honest about what the
// Go runtime can actually call into.
func TestSlackAPIMethodParityBucketsRegisteredUnavailable(t *testing.T) {
	svc := &Service{}
	report := svc.SlackToolParityReport()

	methodStatus := make(map[string]string, len(report.SlackAPIMethods))
	for _, m := range report.SlackAPIMethods {
		methodStatus[m.Action] = m.Status
	}

	wantUnavailable := []string{"fetch_image", "fetch_canvas", "create_canvas", "edit_canvas", "send_dm"}
	for _, action := range wantUnavailable {
		if methodStatus[action] != "registered_unavailable" {
			t.Errorf("action %q status = %q, want registered_unavailable", action, methodStatus[action])
		}
	}

	wantActive := []string{"post_message", "post_thread_reply", "fetch_thread", "fetch_channel_history", "upload_file", "add_reaction"}
	for _, action := range wantActive {
		if methodStatus[action] != "active" {
			t.Errorf("action %q status = %q, want active", action, methodStatus[action])
		}
	}

	if len(report.RegisteredUnavailableSlackAPIMethods) == 0 {
		t.Fatalf("RegisteredUnavailableSlackAPIMethods is empty, want Canvas/DM/image methods")
	}
}

// TestSlackAPIToolRegisteredUnavailableActionReturnsTruthfulError asserts that
// the runtime behavior of an unavailable Slack action matches what the parity
// report advertises — calling a `registered_unavailable` action returns a
// clear "not available" message instead of silently succeeding or failing
// generically.
func TestSlackAPIToolRegisteredUnavailableActionReturnsTruthfulError(t *testing.T) {
	tool := &slackAPITool{
		role:   slackAPIRolePlanner,
		apiURL: "https://slack.example",
		token:  "xoxb-test",
	}

	cases := []string{"fetch_canvas", "create_canvas", "edit_canvas", "send_dm", "fetch_image"}
	for _, action := range cases {
		result, err := tool.Execute(context.Background(), map[string]any{
			"action": action,
			"params": map[string]any{"channel": "C123"},
		})
		if err != nil {
			t.Fatalf("Execute(%q) returned error: %v", action, err)
		}
		if result.Success {
			t.Fatalf("Execute(%q) succeeded unexpectedly: %q", action, result.Text)
		}
		if !containsCI(result.Text, "registered") || !containsCI(result.Text, "not available") {
			t.Errorf("Execute(%q) text = %q, want unavailable-action message", action, result.Text)
		}
	}
}

// TestExecuteSlackToolProductExcludedRejectedAtGateway verifies the runtime
// gateway rejects `product_excluded` tools by name before dispatching, so the
// parity advertised status matches the actual call path.
func TestExecuteSlackToolProductExcludedRejectedAtGateway(t *testing.T) {
	svc := &Service{}
	for _, name := range []string{"linear_api", "notion_api", "google_calendar_api", "figma_api", "send_meeting_chat", "image_generation", "audio_generation"} {
		resp, err := svc.ExecuteSlackTool(context.Background(), SlackToolCallRequest{Tool: name})
		if err != nil {
			t.Fatalf("ExecuteSlackTool(%q) returned error: %v", name, err)
		}
		if resp.OK {
			t.Errorf("ExecuteSlackTool(%q) reported ok=true, want excluded rejection", name)
		}
		if resp.Error != "product_excluded" {
			t.Errorf("ExecuteSlackTool(%q) error = %q, want %q", name, resp.Error, "product_excluded")
		}
	}
}

func contains(slice []string, want string) bool {
	for _, v := range slice {
		if v == want {
			return true
		}
	}
	return false
}

func containsCI(haystack, needle string) bool {
	return strings.Contains(strings.ToLower(haystack), strings.ToLower(needle))
}

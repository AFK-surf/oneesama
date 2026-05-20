package slackagent

import (
	"os"
	"path/filepath"
	"slices"
	"testing"
)

func TestAppMentionFreshSearchUsesKeywordTemplateOverride(t *testing.T) {
	dir := t.TempDir()
	writeTriageKeywordOverride(t, dir, "app_mention_fresh_search_keywords.en.tmpl", "fresh-special\n")
	t.Setenv("ONEESAMA_TRIAGE_TEMPLATE_DIR", dir)

	mention := &SlackAppMentionContext{MentionText: "<@U_BOT> fresh-special Deno Deploy"}
	if !shouldSearchFreshAppMentionEvidence(mention, SlackRelatedMemorySearchResult{}, appMentionFreshSearchQuery(mention)) {
		t.Fatal("expected fresh-search override keyword to trigger evidence search")
	}
}

func TestAppMentionMediaEvidenceUsesKeywordTemplateOverride(t *testing.T) {
	dir := t.TempDir()
	writeTriageKeywordOverride(t, dir, "app_mention_media_request_keywords.en.tmpl", "visual-inventory\n")
	t.Setenv("ONEESAMA_TRIAGE_TEMPLATE_DIR", dir)

	_, ok := collectAppMentionMediaEvidence(&SlackAppMentionContext{
		MentionText: "visual-inventory 这一批",
		Files: []SlackThreadFile{{
			ID:       "F1",
			Name:     "clip.mp4",
			Filetype: "mp4",
			Mimetype: "video/mp4",
		}},
	})
	if !ok {
		t.Fatal("expected media-request override keyword to trigger file-context evidence")
	}
}

func TestAppMentionWorkflowSignalsUseKeywordTemplateOverrides(t *testing.T) {
	dir := t.TempDir()
	writeTriageKeywordOverride(t, dir, "app_mention_workflow_review_keywords.en.tmpl", "shipit-owner\n")
	writeTriageKeywordOverride(t, dir, "app_mention_workflow_review_target_keywords.en.tmpl", "release-ticket\n")
	t.Setenv("ONEESAMA_TRIAGE_TEMPLATE_DIR", dir)

	signals := appMentionWorkflowSignals("shipit-owner release-ticket", nil)
	if !slices.Contains(signals, "review_or_delivery_request") {
		t.Fatalf("signals = %#v, want review_or_delivery_request from override conjunction", signals)
	}
}

func TestAppMentionWorkflowReviewPRTargetKeepsWordBoundary(t *testing.T) {
	if signals := appMentionWorkflowSignals("please approve this", nil); slices.Contains(signals, "review_or_delivery_request") {
		t.Fatalf("signals = %#v, want no review signal without a target", signals)
	}
	if signals := appMentionWorkflowSignals("please review pr when you can", nil); !slices.Contains(signals, "review_or_delivery_request") {
		t.Fatalf("signals = %#v, want boundary-preserved pr target to trigger review signal", signals)
	}
}

func writeTriageKeywordOverride(t *testing.T, dir string, filename string, content string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(dir, filename), []byte(content), 0o600); err != nil {
		t.Fatalf("write keyword override %s: %v", filename, err)
	}
}

package slackagent

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	appconfig "github.com/AFK-surf/oneesama/pkg/config"
)

func TestAppMentionMediaEvidenceWritesSearchableMultimodalMemory(t *testing.T) {
	t.Parallel()

	workspaceDir := t.TempDir()
	service := NewService(Config{
		Slack: appconfig.SlackConfig{
			WorkspaceDir: workspaceDir,
			Memory:       appconfig.SlackMemoryConfig{Enabled: true},
		},
	})
	rich := &SlackAppMentionContext{
		ChannelID:      "CVIDEO",
		ThreadTS:       "1779166071.849179",
		UserID:         "UASK",
		MentionText:    "你看一下这个 channel 里哪些视频可以当作素材库整理起来用",
		RawMentionText: "<@UBOT> 你看一下这个 channel 里哪些视频可以当作素材库整理起来用",
		Files: []SlackThreadFile{
			{ID: "FVID", Name: "bridge_cold_open_montage_v15.mp4", Filetype: "mp4", Mimetype: "video/mp4", Size: 123, Permalink: "https://slack.example/FVID"},
			{ID: "FPDF", Name: "bridge_assets_brief.pdf", Filetype: "pdf", Mimetype: "application/pdf", Size: 456, Permalink: "https://slack.example/FPDF"},
		},
		Prompt: "Thread context:\n你看一下这个 channel 里哪些视频可以当作素材库整理起来用",
	}

	_ = service.buildAgentRunnerContext(context.Background(), AvatarCommandInput{
		ChannelName:       "bridge-social-media",
		UserName:          "peng",
		RichThreadContext: rich,
	}, parsedAvatarCommand{Action: "work"}, nil)

	paths := multimodalCandidatePaths(t, workspaceDir)
	if len(paths) != 1 {
		t.Fatalf("multimodal candidate files = %#v, want one", paths)
	}
	body := readWorkspaceFile(t, workspaceDir, paths[0])
	for _, want := range []string{
		"oneesama.multimodal-memory-candidate.v1",
		"bridge_cold_open_montage_v15.mp4",
		"bridge_assets_brief.pdf",
		"video/binary contents are not decoded",
		"Do not claim to have watched videos",
	} {
		if !strings.Contains(body, want) {
			t.Fatalf("multimodal memory body missing %q:\n%s", want, body)
		}
	}

	result := service.SearchRelatedMemory("bridge_cold_open_montage 素材库", SlackRelatedMemorySearchOptions{Limit: 5})
	record := firstRelatedMemoryKind(result.Results, "multimodal_memory")
	if record == nil {
		t.Fatalf("SearchRelatedMemory = %#v, want multimodal_memory evidence", result.Results)
	}
	if !strings.Contains(record.Content, "bridge_cold_open_montage_v15.mp4") {
		t.Fatalf("multimodal search record missing file reference:\n%#v", record)
	}
	// Task #272: multimodal records are now produced by the workspace scanner
	// (provider Search is a no-op), and pick up the relevance signal via
	// relatedMemoryFamilyBoost instead of the provider's old "+0.16" inline boost.
	if !relatedMemoryReasonsContain(record.Reasons, "family_boost:multimodal_memory") {
		t.Fatalf("multimodal record reasons = %#v, want family_boost:multimodal_memory", record.Reasons)
	}
}

func TestMultimodalMemoryCandidateScrubsInlineImagePayload(t *testing.T) {
	t.Parallel()

	workspaceDir := t.TempDir()
	service := NewService(Config{
		Slack: appconfig.SlackConfig{
			WorkspaceDir: workspaceDir,
			Memory:       appconfig.SlackMemoryConfig{Enabled: true},
		},
	})
	mention := &SlackAppMentionContext{
		ChannelID:   "CIMG",
		ThreadTS:    "1779166071.849179",
		MentionText: "这张截图里有什么？",
		Files:       []SlackThreadFile{{ID: "FIMG", Name: "poster.png", Filetype: "png", Mimetype: "image/png", Size: 12}},
	}
	evidence := []SlackAppMentionToolEvidence{{
		Tool:    "slack_api",
		Args:    map[string]any{"method": "slack.fetchImage", "params": map[string]any{"file_id": "FIMG"}},
		OK:      true,
		Summary: `{"ok":true,"file_id":"FIMG","base64":"QUJDREVGRw==","mime_data_url":"data:image/png;base64,QUJDREVGRw==","title":"poster.png"}`,
	}}

	path := service.recordAppMentionMultimodalMemory(context.Background(), mention, evidence, "worker_tool_bridge")
	if path == "" {
		t.Fatal("recordAppMentionMultimodalMemory returned empty path")
	}
	body := readWorkspaceFile(t, workspaceDir, path)
	for _, banned := range []string{"QUJDREVGRw==", "data:image/png;base64"} {
		if strings.Contains(body, banned) {
			t.Fatalf("multimodal memory leaked inline payload %q:\n%s", banned, body)
		}
	}
	for _, want := range []string{"\"base64\":\"<redacted>\"", "\"mime_data_url\":\"<redacted>\"", "poster.png"} {
		if !strings.Contains(body, want) {
			t.Fatalf("multimodal memory missing scrubbed anchor %q:\n%s", want, body)
		}
	}
}

func TestAppMentionFileMetadataDoesNotWriteMultimodalMemoryWithoutMediaIntent(t *testing.T) {
	t.Parallel()

	workspaceDir := t.TempDir()
	service := NewService(Config{
		Slack: appconfig.SlackConfig{
			WorkspaceDir: workspaceDir,
			Memory:       appconfig.SlackMemoryConfig{Enabled: true},
		},
	})
	rich := &SlackAppMentionContext{
		ChannelID:      "CVIDEO",
		ThreadTS:       "1779166071.849179",
		UserID:         "UASK",
		MentionText:    "谢谢，先这样",
		RawMentionText: "<@UBOT> 谢谢，先这样",
		Files:          []SlackThreadFile{{ID: "FVID", Name: "bridge_cold_open_montage_v15.mp4", Filetype: "mp4", Mimetype: "video/mp4", Size: 123}},
		Prompt:         "Thread context:\n谢谢，先这样",
	}

	_ = service.buildAgentRunnerContext(context.Background(), AvatarCommandInput{
		ChannelName:       "bridge-social-media",
		UserName:          "peng",
		RichThreadContext: rich,
	}, parsedAvatarCommand{Action: "work"}, nil)

	if paths := multimodalCandidatePaths(t, workspaceDir); len(paths) != 0 {
		t.Fatalf("multimodal candidate files = %#v, want none without media intent", paths)
	}
}

func multimodalCandidatePaths(t *testing.T, workspaceDir string) []string {
	t.Helper()
	var paths []string
	for _, rel := range listDirectWorkspaceMemoryFiles(workspaceDir) {
		if strings.HasPrefix(filepath.ToSlash(rel), "memory/multimodal/") {
			paths = append(paths, rel)
		}
	}
	return paths
}

func readWorkspaceFile(t *testing.T, workspaceDir string, rel string) string {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(workspaceDir, filepath.FromSlash(rel)))
	if err != nil {
		t.Fatalf("read %s: %v", rel, err)
	}
	return string(raw)
}

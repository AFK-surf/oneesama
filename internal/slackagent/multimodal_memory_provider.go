package slackagent

import (
	"context"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	appconfig "github.com/AFK-surf/oneesama/pkg/config"
)

const multimodalMemoryProviderName = "multimodal_memory"

var (
	multimodalDataURLRE       = regexp.MustCompile(`data:[^\s"']+`)
	multimodalJSONBase64RE    = regexp.MustCompile(`(?i)"(?:base64|mime_data_url)"\s*:\s*"[^"]*"`)
	multimodalMarkdownImageRE = regexp.MustCompile(`!\[[^\]]*\]\([^)]+\)`)
)

type multimodalMemoryProvider struct {
	SlackMemoryNoopProvider
	enabled      bool
	workspaceDir string
}

func newMultimodalMemoryProvider(cfg appconfig.SlackMemoryConfig) SlackMemoryProvider {
	return &multimodalMemoryProvider{enabled: cfg.Enabled}
}

func (p *multimodalMemoryProvider) Name() string { return multimodalMemoryProviderName }

func (p *multimodalMemoryProvider) Available() bool {
	return p != nil && p.enabled
}

func (p *multimodalMemoryProvider) Initialize(_ context.Context, init SlackMemoryProviderInit) error {
	if p == nil || !p.enabled {
		return nil
	}
	p.workspaceDir = strings.TrimSpace(init.WorkspaceDir)
	return nil
}

// Search intentionally returns no records. The workspace scanner in
// related_memory.go already walks files under memory/multimodal/ and emits
// them with kind=multimodal_memory; emitting them here again would double-
// index the same content under a different Source string, bloating the
// top-N. The previously-provider-only "+0.16" relevance boost is now applied
// by relatedMemoryFamilyBoost so scanner records get the same treatment.
// Anchor: task #272 (Memory provider + evidence ranking cleanup).
func (p *multimodalMemoryProvider) Search(_ context.Context, request SlackMemoryProviderSearchRequest) (SlackMemoryProviderSearchResult, error) {
	result := SlackMemoryProviderSearchResult{Provider: multimodalMemoryProviderName, Status: "no_relevant_memory"}
	if p == nil || !p.enabled {
		result.Status = "disabled"
	}
	return result, nil
}

func (s *Service) recordAppMentionMultimodalMemory(ctx context.Context, mention *SlackAppMentionContext, evidence []SlackAppMentionToolEvidence, origin string) string {
	if s == nil || mention == nil || strings.TrimSpace(s.workspaceDir) == "" {
		return ""
	}
	relevant := multimodalRelevantEvidence(evidence)
	if len(relevant) == 0 && !appMentionRequestsMediaInspection(mention) {
		return ""
	}
	if len(relevant) == 0 && len(mention.Files) == 0 && len(mention.CanvasFiles) == 0 {
		return ""
	}
	body := renderMultimodalMemoryCandidate(mention, relevant, origin)
	if strings.TrimSpace(body) == "" {
		return ""
	}
	key := sha256sum([]byte(strings.Join([]string{
		origin,
		mention.ChannelID,
		mention.ThreadTS,
		mention.MentionText,
		body,
	}, "\n")))
	day := timeNow().UTC().Format("2006-01-02")
	rel := filepath.ToSlash(filepath.Join("memory", "multimodal", "candidates", day, "slack-file-"+key+".md"))
	if err := writeWorkspaceMemoryFile(s.workspaceDir, rel, body); err != nil {
		if s.logger != nil {
			s.logger.Warn("write multimodal memory candidate failed", "path", rel, "error", err)
		}
		return ""
	}
	s.notifyMemoryProvidersWrite(ctx, SlackMemoryProviderWriteEvent{
		Action:  "write",
		Target:  "multimodal_memory_candidate",
		Path:    rel,
		Content: body,
		Source:  "memory_provider:" + multimodalMemoryProviderName,
		Metadata: map[string]any{
			"origin":     origin,
			"channel_id": mention.ChannelID,
			"thread_ts":  mention.ThreadTS,
			"files":      len(mention.Files),
		},
	})
	return rel
}

func multimodalRelevantEvidence(evidence []SlackAppMentionToolEvidence) []SlackAppMentionToolEvidence {
	var out []SlackAppMentionToolEvidence
	for _, item := range evidence {
		if multimodalToolEvidenceRelevant(item) {
			out = append(out, item)
		}
	}
	return out
}

func multimodalToolEvidenceRelevant(item SlackAppMentionToolEvidence) bool {
	tool := strings.ToLower(strings.TrimSpace(item.Tool))
	switch tool {
	case "slack_file_context":
		return true
	case "slack_api":
		action := stringFromAny(item.Args["action"])
		method := stringFromAny(item.Args["method"])
		resolved, _, err := resolveSlackAPIOperation(action, method)
		if err == nil {
			switch resolved {
			case "fetch_image", "fetch_file", "fetch_canvas":
				return true
			}
		}
	}
	return false
}

func renderMultimodalMemoryCandidate(mention *SlackAppMentionContext, evidence []SlackAppMentionToolEvidence, origin string) string {
	if mention == nil {
		return ""
	}
	var b strings.Builder
	b.WriteString("# Multimodal Memory Candidate\n\n")
	legacySlackWriteBullet(&b, "Schema", "oneesama.multimodal-memory-candidate.v1")
	legacySlackWriteBullet(&b, "Status", "review_candidate")
	legacySlackWriteBullet(&b, "Source", "memory_provider:"+multimodalMemoryProviderName)
	legacySlackWriteBullet(&b, "Origin", origin)
	legacySlackWriteBullet(&b, "Channel", mention.ChannelID)
	legacySlackWriteBullet(&b, "Thread", mention.ThreadTS)
	legacySlackWriteBullet(&b, "User", firstNonEmpty(mention.ParentInfo.UserName, mention.UserID))
	legacySlackWriteBullet(&b, "Created at", timeNow().UTC().Format(time.RFC3339Nano))
	b.WriteString("\n## Request\n\n")
	b.WriteString(multimodalMemoryText(firstNonEmpty(mention.MentionText, mention.RawMentionText)))
	b.WriteString("\n\n## Slack Files\n\n")
	files := dedupeSlackThreadFiles(append(append([]SlackThreadFile{}, mention.Files...), mention.CanvasFiles...))
	if len(files) == 0 {
		b.WriteString("No Slack file metadata was attached to this memory candidate.\n")
	} else {
		for _, file := range files {
			b.WriteString("- ")
			b.WriteString(formatSlackFileLine(file))
			b.WriteString("\n")
		}
	}
	if len(evidence) > 0 {
		b.WriteString("\n## Reader Evidence\n\n")
		for _, item := range evidence {
			b.WriteString("### ")
			b.WriteString(firstNonEmpty(item.Tool, "tool"))
			b.WriteString("\n\n")
			if len(item.Args) > 0 {
				b.WriteString("- Args: ")
				b.WriteString(formatSlackToolEvidenceArgs(item.Args))
				b.WriteString("\n")
			}
			if item.Error != "" {
				b.WriteString("- Error: ")
				b.WriteString(multimodalMemoryText(item.Error))
				b.WriteString("\n")
			}
			if item.Summary != "" {
				b.WriteString(multimodalMemoryText(item.Summary))
				b.WriteString("\n")
			} else if item.Text != "" {
				b.WriteString(multimodalMemoryText(item.Text))
				b.WriteString("\n")
			}
			b.WriteString("\n")
		}
	}
	b.WriteString("## Review Guidance\n\n")
	b.WriteString("This is a searchable, reviewable multimodal Memory candidate. Image/canvas reader outputs may be used when present; video, audio, PDF, and binary contents remain metadata-only unless a separate reader result is attached. Do not claim visual or binary content was inspected without reader evidence.\n")
	return strings.TrimSpace(b.String())
}

func multimodalMemoryText(text string) string {
	text = strings.TrimSpace(text)
	if text == "" {
		return ""
	}
	text, _ = redactSlockWorkspaceSecrets(text)
	text = multimodalJSONBase64RE.ReplaceAllStringFunc(text, func(match string) string {
		if strings.Contains(strings.ToLower(match), "mime_data_url") {
			return `"mime_data_url":"<redacted>"`
		}
		return `"base64":"<redacted>"`
	})
	text = multimodalDataURLRE.ReplaceAllString(text, "data:<redacted>")
	text = multimodalMarkdownImageRE.ReplaceAllString(text, "![image](<redacted>)")
	return truncateSlackContextText(text, 2200)
}

func slackAppMentionFromContextMap(contextMap map[string]any) *SlackAppMentionContext {
	if len(contextMap) == 0 {
		return nil
	}
	switch typed := contextMap["slackAppMention"].(type) {
	case *SlackAppMentionContext:
		return typed
	case SlackAppMentionContext:
		copied := typed
		return &copied
	case map[string]any:
		return &SlackAppMentionContext{
			ChannelID:      stringFromAny(typed["channelId"]),
			ThreadTS:       stringFromAny(typed["threadTs"]),
			UserID:         stringFromAny(typed["userId"]),
			MentionText:    stringFromAny(typed["mentionText"]),
			RawMentionText: stringFromAny(typed["rawMentionText"]),
			Files:          slackThreadFilesFromAny(typed["files"]),
			CanvasFiles:    slackThreadFilesFromAny(typed["canvasFiles"]),
		}
	case map[string]string:
		return &SlackAppMentionContext{
			ChannelID:      typed["channelId"],
			ThreadTS:       typed["threadTs"],
			UserID:         typed["userId"],
			MentionText:    typed["mentionText"],
			RawMentionText: typed["rawMentionText"],
		}
	default:
		return nil
	}
}

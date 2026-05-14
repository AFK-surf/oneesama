package postmeeting

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"time"

	"github.com/google/uuid"
)

const defaultArtifactsRootDir = "./runtime/meeting-artifacts"

type Pipeline struct {
	rootDir string
}

func NewPipeline(rootDir string) *Pipeline {
	if firstNonEmpty(rootDir) == "" {
		rootDir = defaultArtifactsRootDir
	}
	return &Pipeline{rootDir: rootDir}
}

func (p *Pipeline) RootDir() string {
	return p.rootDir
}

func (p *Pipeline) PostProcess(_ context.Context, input PostProcessInput) (PostProcessResult, error) {
	artifactID := firstNonEmpty(input.ArtifactID, input.ID, "meeting-"+uuid.NewString()[:8])
	dir := filepath.Join(firstNonEmpty(input.RootDir, p.rootDir), artifactID)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return PostProcessResult{}, fmt.Errorf("create artifact dir: %w", err)
	}

	createdAt := time.Now().UTC().Format(time.RFC3339Nano)
	segments := normalizeSegments(input)
	transcriptText := joinSegmentText(segments)
	participants := participantList(input, segments)
	chatMessages := normalizeChatMessages(input)
	chatLinks := collectChatLinks(chatMessages)
	summary := buildFallbackSummary(input, segments, participants)

	files := ArtifactFiles{
		Transcript:     filepath.Join(dir, "transcript.json"),
		TranscriptText: filepath.Join(dir, "transcript.txt"),
		Summary:        filepath.Join(dir, "summary.md"),
		Manifest:       filepath.Join(dir, "manifest.json"),
		Chat:           filepath.Join(dir, "chat.json"),
		Audio:          firstNonEmpty(input.AudioPath),
	}

	transcript := TranscriptArtifact{
		Schema:       "oneesama.transcript.v1",
		ID:           artifactID,
		Provider:     "caption",
		OK:           true,
		Text:         transcriptText,
		Segments:     segments,
		SegmentCount: len(segments),
		CreatedAt:    createdAt,
	}
	chat := ChatArtifact{
		Schema:       "oneesama.meet-chat.v1",
		ID:           artifactID,
		MeetingID:    input.MeetingID,
		SessionID:    input.SessionID,
		MeetURL:      input.MeetURL,
		MessageCount: len(chatMessages),
		LinkCount:    len(chatLinks),
		Links:        chatLinks,
		Messages:     chatMessages,
		CreatedAt:    createdAt,
	}

	manifest := ArtifactManifest{
		Schema:    "oneesama.meeting-artifact.v1",
		ID:        artifactID,
		Title:     firstNonEmpty(input.Title, summary.Title, "Meeting summary"),
		MeetingID: input.MeetingID,
		SessionID: input.SessionID,
		MeetURL:   input.MeetURL,
		Dir:       dir,
		CreatedAt: createdAt,
		UpdatedAt: createdAt,
		Files:     files,
		Source:    firstNonEmpty(input.Source, "post-meeting"),
	}
	manifest.Transcript.Provider = transcript.Provider
	manifest.Transcript.SegmentCount = len(segments)
	manifest.Transcript.TextLength = len(transcriptText)
	manifest.Chat.MessageCount = len(chatMessages)
	manifest.Chat.LinkCount = len(chatLinks)
	if len(chatMessages) > 0 {
		manifest.Chat.LatestAt = chatMessages[len(chatMessages)-1].Timestamp
	}
	manifest.Summary.Highlights = summary.Highlights
	manifest.Summary.Decisions = summary.Decisions
	manifest.Summary.ActionItems = summary.ActionItems

	if err := writeJSONFile(files.Transcript, transcript); err != nil {
		return PostProcessResult{}, err
	}
	if err := os.WriteFile(files.TranscriptText, []byte(renderTranscriptText(segments)), 0o644); err != nil {
		return PostProcessResult{}, fmt.Errorf("write transcript text: %w", err)
	}
	if err := writeJSONFile(files.Chat, chat); err != nil {
		return PostProcessResult{}, err
	}
	if err := os.WriteFile(files.Summary, []byte(renderSummaryMarkdown(summary, manifest)), 0o644); err != nil {
		return PostProcessResult{}, fmt.Errorf("write summary markdown: %w", err)
	}
	if err := writeJSONFile(files.Manifest, manifest); err != nil {
		return PostProcessResult{}, err
	}

	return PostProcessResult{
		OK:         true,
		Artifact:   manifest,
		Transcript: transcript,
		Summary:    summary,
		Chat:       chat,
	}, nil
}

func (p *Pipeline) GetArtifact(id string) (*ArtifactManifest, error) {
	if firstNonEmpty(id) == "" {
		return nil, nil
	}
	path := filepath.Join(p.rootDir, id, "manifest.json")
	raw, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, fmt.Errorf("read artifact manifest: %w", err)
	}
	var manifest ArtifactManifest
	if err := json.Unmarshal(raw, &manifest); err != nil {
		return nil, fmt.Errorf("decode artifact manifest: %w", err)
	}
	return &manifest, nil
}

func (p *Pipeline) GetArtifactChat(id string) (*ChatArtifact, error) {
	manifest, err := p.GetArtifact(id)
	if err != nil || manifest == nil {
		return nil, err
	}
	raw, err := os.ReadFile(manifest.Files.Chat)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, fmt.Errorf("read artifact chat: %w", err)
	}
	var chat ChatArtifact
	if err := json.Unmarshal(raw, &chat); err != nil {
		return nil, fmt.Errorf("decode artifact chat: %w", err)
	}
	return &chat, nil
}

func (p *Pipeline) ListArtifacts() ([]ArtifactManifest, error) {
	entries, err := os.ReadDir(p.rootDir)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, fmt.Errorf("read artifacts dir: %w", err)
	}

	artifacts := make([]ArtifactManifest, 0)
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		manifest, err := p.GetArtifact(entry.Name())
		if err != nil || manifest == nil {
			if err != nil {
				return nil, err
			}
			continue
		}
		artifacts = append(artifacts, *manifest)
	}

	sort.SliceStable(artifacts, func(i, j int) bool {
		if artifacts[i].CreatedAt == artifacts[j].CreatedAt {
			return artifacts[i].ID < artifacts[j].ID
		}
		return artifacts[i].CreatedAt < artifacts[j].CreatedAt
	})
	return artifacts, nil
}

func joinSegmentText(segments []NormalizedSegment) string {
	lines := make([]string, 0, len(segments))
	for _, segment := range segments {
		if text := firstNonEmpty(segment.Text); text != "" {
			lines = append(lines, text)
		}
	}
	return stringsJoin(lines, "\n")
}

func renderTranscriptText(segments []NormalizedSegment) string {
	lines := make([]string, 0, len(segments))
	for _, segment := range segments {
		text := firstNonEmpty(segment.Text)
		if text == "" {
			continue
		}
		if speaker := firstNonEmpty(segment.Speaker); speaker != "" {
			text = speaker + ": " + text
		}
		lines = append(lines, text)
	}
	if len(lines) == 0 {
		return ""
	}
	return stringsJoin(lines, "\n") + "\n"
}

func collectChatLinks(messages []NormalizedChatMessage) []string {
	links := make([]string, 0)
	for _, message := range messages {
		links = append(links, message.Links...)
	}
	return dedupeStrings(links)
}

func writeJSONFile(path string, value any) error {
	payload, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return fmt.Errorf("marshal json %s: %w", path, err)
	}
	if err := os.WriteFile(path, append(payload, '\n'), 0o644); err != nil {
		return fmt.Errorf("write json %s: %w", path, err)
	}
	return nil
}

func stringsJoin(values []string, separator string) string {
	if len(values) == 0 {
		return ""
	}
	result := values[0]
	for _, value := range values[1:] {
		result += separator + value
	}
	return result
}

package slackagent

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"strings"

	"github.com/google/uuid"
)

const defaultCanvasOutDir = "./runtime/canvases"

type CanvasArtifact struct {
	ID      string                 `json:"id,omitempty"`
	Title   string                 `json:"title,omitempty"`
	MeetURL string                 `json:"meet_url,omitempty"`
	Files   *CanvasArtifactFiles   `json:"files,omitempty"`
	Summary *CanvasArtifactSummary `json:"summary,omitempty"`
}

type CanvasArtifactFiles struct {
	Transcript string `json:"transcript,omitempty"`
	Audio      string `json:"audio,omitempty"`
	Summary    string `json:"summary,omitempty"`
}

type CanvasArtifactSummary struct {
	Highlights       []string `json:"highlights,omitempty"`
	Decisions        []string `json:"decisions,omitempty"`
	ActionItems      []string `json:"action_items,omitempty"`
	Attendees        []string `json:"attendees,omitempty"`
	DurationMinutes  int      `json:"duration_minutes,omitempty"`
	DurationMinutes2 int      `json:"durationMinutes,omitempty"`
}

type CanvasPublisherConfig struct {
	Provider   string
	OutDir     string
	Channel    string
	ThreadTS   string
	BotToken   string
	APIBaseURL string
	Client     *http.Client
	Poster     *Poster
}

type CanvasPublishInput struct {
	Artifact         CanvasArtifact
	ArtifactID       string
	ID               string
	Title            string
	SummaryMarkdown  string
	SummaryPath      string
	NotificationText string
	Destination      string
	Channel          string
	ThreadTS         string
	DedupKey         string
	CanvasID         string
	Operation        string
	SectionID        string
	ForceSlackCanvas bool
}

type PublishedCanvasManifest struct {
	ID           string                `json:"id"`
	Provider     string                `json:"provider"`
	Surface      string                `json:"surface"`
	ArtifactID   string                `json:"artifact_id"`
	MarkdownPath string                `json:"markdown_path"`
	ManifestPath string                `json:"manifest_path"`
	CreatedAt    string                `json:"created_at"`
	OK           bool                  `json:"ok"`
	Destination  string                `json:"destination"`
	Slack        *PostMessageResult    `json:"slack,omitempty"`
	Canvas       *SlackCanvasAPIResult `json:"canvas,omitempty"`
}

type CanvasPublisher struct {
	provider   string
	outDir     string
	channel    string
	threadTS   string
	botToken   string
	apiBaseURL string
	client     *http.Client
	poster     *Poster
}

func NewCanvasPublisher(config CanvasPublisherConfig) (*CanvasPublisher, error) {
	outDir := strings.TrimSpace(config.OutDir)
	if outDir == "" {
		outDir = defaultCanvasOutDir
	}
	if err := os.MkdirAll(outDir, 0o755); err != nil {
		return nil, fmt.Errorf("create canvas out dir: %w", err)
	}

	provider := normalizeCanvasProvider(config.Provider)
	poster := config.Poster
	if poster == nil {
		poster = NewPoster(PosterConfig{
			BotToken: config.BotToken,
			Mock:     strings.TrimSpace(config.BotToken) == "",
			Client:   config.Client,
		})
	}

	return &CanvasPublisher{
		provider:   provider,
		outDir:     outDir,
		channel:    strings.TrimSpace(config.Channel),
		threadTS:   strings.TrimSpace(config.ThreadTS),
		botToken:   strings.TrimSpace(config.BotToken),
		apiBaseURL: strings.TrimSpace(config.APIBaseURL),
		client:     config.Client,
		poster:     poster,
	}, nil
}

func (p *CanvasPublisher) Publish(ctx context.Context, input CanvasPublishInput) (PublishedCanvasManifest, error) {
	artifactID := firstNonEmpty(input.ArtifactID, input.Artifact.ID, "meeting-"+uuid.NewString()[:8])
	id := firstNonEmpty(input.ID, "canvas-"+sanitizeCanvasID(artifactID)+"-"+uuid.NewString()[:8])
	createdAt := nowRFC3339()
	markdown, err := renderCanvasMarkdown(input)
	if err != nil {
		return PublishedCanvasManifest{}, err
	}

	markdownPath := filepath.Join(p.outDir, id+".md")
	manifestPath := filepath.Join(p.outDir, id+".json")
	if err := os.WriteFile(markdownPath, []byte(markdown), 0o644); err != nil {
		return PublishedCanvasManifest{}, fmt.Errorf("write canvas markdown: %w", err)
	}

	result := PublishedCanvasManifest{
		ID:           id,
		Provider:     p.provider,
		Surface:      p.provider,
		ArtifactID:   artifactID,
		MarkdownPath: markdownPath,
		ManifestPath: manifestPath,
		CreatedAt:    createdAt,
		OK:           true,
		Destination:  strings.TrimSpace(input.Destination),
	}

	switch {
	case p.provider == "slack-canvas" || input.ForceSlackCanvas:
		canvasResult := p.publishSlackCanvas(ctx, markdown, input)
		result.OK = canvasResult.OK
		result.Surface = "slack-canvas"
		result.Canvas = &canvasResult
		postChannel := firstNonEmpty(input.Channel, p.channel)
		if canvasResult.OK && postChannel != "" && strings.TrimSpace(input.NotificationText) != "" {
			postResult := p.poster.PostMessage(ctx, PostMessageInput{
				Channel:  postChannel,
				ThreadTS: firstNonEmpty(input.ThreadTS, p.threadTS),
				Text:     strings.ReplaceAll(input.NotificationText, "{{canvas_link}}", slackCanvasMarkdownLink(canvasResult)),
				DedupKey: firstNonEmpty(input.DedupKey, defaultCanvasDedupKey(artifactID, firstNonEmpty(input.Channel, p.channel), firstNonEmpty(input.ThreadTS, p.threadTS))),
			})
			result.Slack = &postResult
			result.OK = result.OK && postResult.OK
		}
	case p.provider == "slack-thread" || strings.TrimSpace(input.Channel) != "":
		postResult := p.poster.PostMessage(ctx, PostMessageInput{
			Channel:  firstNonEmpty(input.Channel, p.channel),
			ThreadTS: firstNonEmpty(input.ThreadTS, p.threadTS),
			Text:     truncateSlackText(markdown),
			DedupKey: firstNonEmpty(input.DedupKey, defaultCanvasDedupKey(artifactID, firstNonEmpty(input.Channel, p.channel), firstNonEmpty(input.ThreadTS, p.threadTS))),
		})
		result.OK = postResult.OK
		if postResult.Mock {
			result.Surface = "mock-slack-thread"
		} else {
			result.Surface = "slack-thread"
		}
		result.Slack = &postResult
	}

	if err := writeJSONFile(manifestPath, result); err != nil {
		return PublishedCanvasManifest{}, err
	}
	return result, nil
}

func (p *CanvasPublisher) ListPublished() ([]PublishedCanvasManifest, error) {
	entries, err := os.ReadDir(p.outDir)
	if err != nil {
		return nil, fmt.Errorf("read canvas out dir: %w", err)
	}

	manifests := make([]PublishedCanvasManifest, 0)
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}
		raw, err := os.ReadFile(filepath.Join(p.outDir, entry.Name()))
		if err != nil {
			return nil, fmt.Errorf("read canvas manifest: %w", err)
		}
		var manifest PublishedCanvasManifest
		if err := json.Unmarshal(raw, &manifest); err != nil {
			return nil, fmt.Errorf("parse canvas manifest: %w", err)
		}
		manifests = append(manifests, manifest)
	}

	slices.SortFunc(manifests, func(a, b PublishedCanvasManifest) int {
		return strings.Compare(a.CreatedAt, b.CreatedAt)
	})
	return manifests, nil
}

func (p *CanvasPublisher) publishSlackCanvas(ctx context.Context, markdown string, input CanvasPublishInput) SlackCanvasAPIResult {
	if strings.TrimSpace(input.CanvasID) != "" {
		return EditSlackCanvas(
			ctx,
			p.client,
			p.botToken,
			p.apiBaseURL,
			input.CanvasID,
			markdown,
			input.Operation,
			input.SectionID,
		)
	}
	channel := firstNonEmpty(input.Channel, p.channel)
	if input.ForceSlackCanvas {
		channel = ""
	}
	result := CreateSlackCanvas(
		ctx,
		p.client,
		p.botToken,
		p.apiBaseURL,
		firstNonEmpty(input.Title, input.Artifact.Title, "Meeting summary"),
		markdown,
		channel,
	)
	if result.OK && strings.TrimSpace(result.CanvasID) != "" {
		auth := SlackAuthTest(ctx, p.client, p.botToken, p.apiBaseURL)
		result.TeamID = auth.TeamID
		result.Permalink = slackCanvasPermalink(auth.TeamID, result.CanvasID)
	}
	return result
}

func normalizeCanvasProvider(provider string) string {
	normalized := strings.NewReplacer("_", "-", " ", "-").Replace(strings.ToLower(strings.TrimSpace(provider)))
	if normalized == "" {
		return "file"
	}
	return normalized
}

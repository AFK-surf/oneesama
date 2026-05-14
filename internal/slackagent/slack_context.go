package slackagent

import (
	"context"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/AFK-surf/oneesama/internal/persistence"
	appconfig "github.com/AFK-surf/oneesama/pkg/config"
)

const slackWorkspaceContextsCollection = "slack_workspace_contexts"

type SlackContextRecord struct {
	ID              string                 `json:"id"`
	WorkspaceID     string                 `json:"workspaceId"`
	TeamDomain      string                 `json:"teamDomain,omitempty"`
	ChannelID       string                 `json:"channelId"`
	ChannelName     string                 `json:"channelName,omitempty"`
	ThreadTS        string                 `json:"threadTs"`
	LastUserID      string                 `json:"lastUserId,omitempty"`
	LastUserName    string                 `json:"lastUserName,omitempty"`
	LastAction      string                 `json:"lastAction,omitempty"`
	LastCommandText string                 `json:"lastCommandText,omitempty"`
	LastSessionID   string                 `json:"lastSessionId,omitempty"`
	LastMeetURL     string                 `json:"lastMeetUrl,omitempty"`
	LastTask        string                 `json:"lastTask,omitempty"`
	CommandCount    int                    `json:"commandCount"`
	RecentCommands  []RecentSlackCommand   `json:"recentCommands,omitempty"`
	ChannelBrain    string                 `json:"channelBrain,omitempty"`
	ThreadLedger    SlackThreadLedger      `json:"threadLedger,omitempty"`
	Source          SlackContextSource     `json:"source"`
	RawPublic       map[string]interface{} `json:"rawPublic,omitempty"`
	UpdatedAt       string                 `json:"updatedAt"`
	CreatedAt       string                 `json:"createdAt"`
}

type RecentSlackCommand struct {
	TS        string `json:"ts"`
	Action    string `json:"action"`
	Text      string `json:"text"`
	UserID    string `json:"userId,omitempty"`
	SessionID string `json:"sessionId,omitempty"`
	MeetURL   string `json:"meetUrl,omitempty"`
	Task      string `json:"task,omitempty"`
}

type SlackThreadLedger struct {
	LatestSessionID string `json:"latestSessionId,omitempty"`
	LatestMeetURL   string `json:"latestMeetUrl,omitempty"`
	LatestTask      string `json:"latestTask,omitempty"`
	UpdatedAt       string `json:"updatedAt,omitempty"`
}

type SlackContextSource struct {
	Kind string `json:"kind"`
	Note string `json:"note"`
}

type slackContextStore struct {
	logger     *slog.Logger
	collection *persistence.TypedCollection[SlackContextRecord]
}

func newSlackContextStore(cfg appconfig.PersistenceConfig, logger *slog.Logger) *slackContextStore {
	collection, err := persistence.OpenTyped[SlackContextRecord](persistence.Options{
		Provider:   persistence.NormalizeProvider(cfg.Provider),
		Collection: slackWorkspaceContextsCollection,
		DataDir:    cfg.DataDir,
		SQLitePath: cfg.SQLitePath,
	})
	if err != nil {
		logger.Warn("slack context store init failed", "error", err)
		return nil
	}
	return &slackContextStore{logger: logger, collection: collection}
}

func (s *slackContextStore) Remember(ctx context.Context, input AvatarCommandInput, parsed parsedAvatarCommand, session *meetingAgentSession) (*SlackContextRecord, error) {
	if s == nil || s.collection == nil {
		return nil, nil
	}
	id := slackContextID(input)
	previous, ok, err := s.collection.Get(ctx, id)
	if err != nil {
		return nil, fmt.Errorf("load slack context: %w", err)
	}
	now := time.Now().UTC().Format(time.RFC3339Nano)
	recent := RecentSlackCommand{
		TS:        now,
		Action:    firstNonEmpty(parsed.Action, "unknown"),
		Text:      strings.TrimSpace(input.Text),
		UserID:    input.UserID,
		SessionID: firstNonEmpty(sessionIDFromMeetingSession(session), parsed.SessionID),
		MeetURL:   firstNonEmpty(meetURLFromMeetingSession(session), parsed.MeetURL),
		Task:      parsed.Task,
	}
	record := SlackContextRecord{
		ID:              id,
		WorkspaceID:     firstNonEmpty(input.TeamID, "workspace"),
		TeamDomain:      input.TeamDomain,
		ChannelID:       firstNonEmpty(input.ChannelID, "channel"),
		ChannelName:     input.ChannelName,
		ThreadTS:        firstNonEmpty(input.ThreadTS, "channel-root"),
		LastUserID:      input.UserID,
		LastUserName:    input.UserName,
		LastAction:      recent.Action,
		LastCommandText: truncateSlackContextText(recent.Text, 4000),
		LastSessionID:   recent.SessionID,
		LastMeetURL:     recent.MeetURL,
		LastTask:        recent.Task,
		CommandCount:    1,
		RecentCommands:  []RecentSlackCommand{recent},
		ThreadLedger: SlackThreadLedger{
			LatestSessionID: recent.SessionID,
			LatestMeetURL:   recent.MeetURL,
			LatestTask:      recent.Task,
			UpdatedAt:       now,
		},
		Source: SlackContextSource{
			Kind: "slack-command",
			Note: "Derived from Slack mention/DM/command payload; private response_url/trigger_id/token fields are intentionally omitted.",
		},
		RawPublic: publicSlackCommandBody(input),
		UpdatedAt: now,
		CreatedAt: now,
	}
	if ok {
		record.CommandCount = previous.CommandCount + 1
		record.RecentCommands = append(append([]RecentSlackCommand(nil), previous.RecentCommands...), recent)
		if len(record.RecentCommands) > 12 {
			record.RecentCommands = record.RecentCommands[len(record.RecentCommands)-12:]
		}
		record.ChannelBrain = previous.ChannelBrain
		record.CreatedAt = firstNonEmpty(previous.CreatedAt, now)
		if record.ThreadLedger.LatestSessionID == "" {
			record.ThreadLedger.LatestSessionID = previous.ThreadLedger.LatestSessionID
		}
		if record.ThreadLedger.LatestMeetURL == "" {
			record.ThreadLedger.LatestMeetURL = previous.ThreadLedger.LatestMeetURL
		}
		if record.ThreadLedger.LatestTask == "" {
			record.ThreadLedger.LatestTask = previous.ThreadLedger.LatestTask
		}
	}
	if err := s.collection.Set(ctx, id, record); err != nil {
		return nil, fmt.Errorf("save slack context: %w", err)
	}
	return &record, nil
}

func slackContextID(input AvatarCommandInput) string {
	return strings.Join([]string{
		firstNonEmpty(input.TeamID, "workspace"),
		firstNonEmpty(input.ChannelID, "channel"),
		firstNonEmpty(input.ThreadTS, "channel-root"),
	}, ":")
}

func publicSlackCommandBody(input AvatarCommandInput) map[string]interface{} {
	return map[string]interface{}{
		"team_id":      input.TeamID,
		"team_domain":  input.TeamDomain,
		"channel_id":   input.ChannelID,
		"channel_name": input.ChannelName,
		"thread_ts":    input.ThreadTS,
		"reaction_ts":  input.ReactionTS,
		"user_id":      input.UserID,
		"user_name":    input.UserName,
		"command":      input.Command,
		"text":         input.Text,
	}
}

func sessionIDFromMeetingSession(session *meetingAgentSession) string {
	if session == nil {
		return ""
	}
	return session.ID
}

func meetURLFromMeetingSession(session *meetingAgentSession) string {
	if session == nil {
		return ""
	}
	return session.MeetingURL
}

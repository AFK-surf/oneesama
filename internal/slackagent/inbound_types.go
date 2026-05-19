package slackagent

type SlackInboundMessage struct {
	TeamID           string          `json:"teamId,omitempty"`
	TeamIDSnake      string          `json:"team_id,omitempty"`
	ChannelID        string          `json:"channelId"`
	ChannelIDSnake   string          `json:"channel_id,omitempty"`
	ChannelType      string          `json:"channelType,omitempty"`
	ChannelTypeSnake string          `json:"channel_type,omitempty"`
	UserID           string          `json:"userId,omitempty"`
	UserIDSnake      string          `json:"user_id,omitempty"`
	User             string          `json:"user,omitempty"`
	BotID            string          `json:"botId,omitempty"`
	BotIDSnake       string          `json:"bot_id,omitempty"`
	Subtype          string          `json:"subtype,omitempty"`
	Text             string          `json:"text"`
	TS               string          `json:"ts"`
	EventTS          string          `json:"eventTs,omitempty"`
	EventTSSnake     string          `json:"event_ts,omitempty"`
	ThreadTS         string          `json:"threadTs,omitempty"`
	ThreadTSSnake    string          `json:"thread_ts,omitempty"`
	ReplyCount       int             `json:"reply_count,omitempty"`
	ReplyUsers       []string        `json:"reply_users,omitempty"`
	Files            []SlackFile     `json:"files,omitempty"`
	Reactions        []SlackReaction `json:"reactions,omitempty"`
}

type SlackInboundChannelState struct {
	Pending       int    `json:"pending"`
	LastUpdatedAt string `json:"lastUpdatedAt,omitempty"`
	Cursor        string `json:"cursor,omitempty"`
}

type SlackEventBufferState struct {
	Enabled          bool                                `json:"enabled"`
	TriageEnabled    bool                                `json:"triageEnabled"`
	BufferedMessages int                                 `json:"bufferedMessages"`
	Flushes          int                                 `json:"flushes"`
	LastBufferedAt   string                              `json:"lastBufferedAt,omitempty"`
	LastFlushAt      string                              `json:"lastFlushAt,omitempty"`
	LastFlushChannel string                              `json:"lastFlushChannel,omitempty"`
	LastFlushCount   int                                 `json:"lastFlushCount,omitempty"`
	LastTriageJobID  string                              `json:"lastTriageJobId,omitempty"`
	LastError        string                              `json:"lastError,omitempty"`
	Channels         map[string]SlackInboundChannelState `json:"channels"`
}

type SlackInboundState struct {
	EventBuffer SlackEventBufferState `json:"eventBuffer"`
}

type SlackInboundBufferResult struct {
	Buffered  bool   `json:"buffered"`
	Ignored   bool   `json:"ignored,omitempty"`
	Reason    string `json:"reason,omitempty"`
	ChannelID string `json:"channelId,omitempty"`
	Pending   int    `json:"pending,omitempty"`
}

type SlackInboundFlushResult struct {
	ChannelID       string                    `json:"channelId"`
	Messages        []SlackInboundMessage     `json:"messages,omitempty"`
	ContextMessages []SlackInboundMessage     `json:"context_messages,omitempty"`
	Count           int                       `json:"count"`
	Digest          string                    `json:"digest,omitempty"`
	Triage          *SlackInboundTriageResult `json:"triage,omitempty"`
}

type SlackInboundTriageResult struct {
	Enabled      bool                     `json:"enabled"`
	Skipped      bool                     `json:"skipped,omitempty"`
	Reason       string                   `json:"reason,omitempty"`
	Summary      string                   `json:"summary,omitempty"`
	Run          *SlackTriageContext      `json:"run,omitempty"`
	Job          any                      `json:"job,omitempty"`
	Finalization *SlackTriageFinalization `json:"finalization,omitempty"`
}

type SlackScannerSweepRequest struct {
	WorkspaceID      string                `json:"workspaceId,omitempty"`
	WorkspaceIDSnake string                `json:"workspace_id,omitempty"`
	TeamID           string                `json:"team_id,omitempty"`
	Channel          string                `json:"channel,omitempty"`
	ChannelID        string                `json:"channel_id,omitempty"`
	Channels         []SlackScannerChannel `json:"channels,omitempty"`
	Messages         []SlackInboundMessage `json:"messages,omitempty"`
	Flush            *bool                 `json:"flush,omitempty"`
}

type SlackScannerChannel struct {
	ID              string                `json:"id"`
	Name            string                `json:"name,omitempty"`
	Type            string                `json:"type,omitempty"`
	Messages        []SlackInboundMessage `json:"messages,omitempty"`
	ContextMessages []SlackInboundMessage `json:"context_messages,omitempty"`
}

type SlackScannerSweepResult struct {
	OK          bool                        `json:"ok"`
	WorkspaceID string                      `json:"workspaceId,omitempty"`
	Error       string                      `json:"error,omitempty"`
	Sweeps      []SlackScannerChannelResult `json:"sweeps,omitempty"`
	Inbound     SlackInboundState           `json:"inbound"`
}

type SlackScannerChannelResult struct {
	ChannelID           string                   `json:"channelId"`
	OK                  bool                     `json:"ok"`
	Source              string                   `json:"source,omitempty"`
	Error               string                   `json:"error,omitempty"`
	PreviousCursor      string                   `json:"previousCursor,omitempty"`
	NextCursor          string                   `json:"nextCursor,omitempty"`
	Scanned             int                      `json:"scanned"`
	Buffered            int                      `json:"buffered"`
	MentionReconciled   int                      `json:"mentionReconciled,omitempty"`
	MentionSkipped      int                      `json:"mentionSkipped,omitempty"`
	MentionReconcileErr string                   `json:"mentionReconcileError,omitempty"`
	Flushed             *SlackInboundFlushResult `json:"flushed,omitempty"`
}

type SlackScannerReconcileResult struct {
	ChannelID       string `json:"channelId"`
	PendingCursor   string `json:"pendingCursor,omitempty"`
	CommittedCursor string `json:"committedCursor,omitempty"`
	HistoryCount    int    `json:"historyCount"`
	MissedCount     int    `json:"missedCount"`
}

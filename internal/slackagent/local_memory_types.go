package slackagent

type SlackMemorySummary struct {
	Enabled      bool                   `json:"enabled"`
	RootDir      string                 `json:"rootDir"`
	WorkspaceDir string                 `json:"workspaceDir"`
	Manifest     map[string]any         `json:"manifest,omitempty"`
	FileCount    int                    `json:"fileCount"`
	Seed         SlackMemorySeedSummary `json:"seed"`
}

type SlackMemorySeedSummary struct {
	OK              bool `json:"ok"`
	ChannelBrain    int  `json:"channelBrain"`
	ThreadLedger    int  `json:"threadLedger"`
	Channels        int  `json:"channels"`
	FeedbackEntries int  `json:"feedbackEntries"`
	TriageRuns      int  `json:"triageRuns"`
}

type SlackMemoryResult struct {
	Kind    string         `json:"kind"`
	Source  string         `json:"source"`
	Score   float64        `json:"score"`
	Content string         `json:"content"`
	Row     map[string]any `json:"row,omitempty"`
}

type SlackMemoryAgentContext struct {
	Enabled     bool                `json:"enabled"`
	Provenance  string              `json:"provenance,omitempty"`
	Query       string              `json:"query,omitempty"`
	ResultCount int                 `json:"resultCount,omitempty"`
	Results     []SlackMemoryResult `json:"results,omitempty"`
}

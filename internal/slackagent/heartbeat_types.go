package slackagent

type SlackHeartbeatFollowup struct {
	ID             int64          `json:"id"`
	Kind           string         `json:"kind"`
	Title          string         `json:"title"`
	Summary        string         `json:"summary"`
	SourceKind     string         `json:"source_kind"`
	ChannelID      string         `json:"channel_id"`
	ThreadTS       string         `json:"thread_ts"`
	SourceRef      string         `json:"source_ref"`
	Status         string         `json:"status"`
	Priority       string         `json:"priority"`
	DueAt          string         `json:"due_at,omitempty"`
	NextCheckAt    string         `json:"next_check_at,omitempty"`
	LastSurfacedAt string         `json:"last_surfaced_at,omitempty"`
	CreatedAt      string         `json:"created_at"`
	UpdatedAt      string         `json:"updated_at"`
	Metadata       map[string]any `json:"metadata,omitempty"`
}

type SlackHeartbeatSurface struct {
	ID               int64  `json:"id"`
	FollowupID       int64  `json:"followup_id"`
	SessionID        string `json:"session_id"`
	Title            string `json:"title"`
	Summary          string `json:"summary"`
	RequestedSurface string `json:"requested_surface"`
	DeliveredSurface string `json:"delivered_surface"`
	ChannelID        string `json:"channel_id"`
	ThreadTS         string `json:"thread_ts"`
	Status           string `json:"status"`
	BlockReason      string `json:"block_reason,omitempty"`
	Error            string `json:"error,omitempty"`
	CreatedAt        string `json:"created_at"`
}

type SlackThreadRecommendation struct {
	ID                 int64  `json:"id"`
	ChannelID          string `json:"channel_id"`
	ThreadTS           string `json:"thread_ts"`
	RecommendationType string `json:"recommendation_type"`
	Status             string `json:"status"`
	CardTS             string `json:"card_ts,omitempty"`
	CreatedAt          string `json:"created_at"`
	UpdatedAt          string `json:"updated_at"`
}

type SlackOutboundAction struct {
	ID         int64  `json:"id"`
	ActionType string `json:"action_type"`
	Target     string `json:"target"`
	Reference  string `json:"reference"`
	SessionID  string `json:"session_id"`
	Summary    string `json:"summary"`
	Status     string `json:"status"`
	CreatedAt  string `json:"created_at"`
	UpdatedAt  string `json:"updated_at"`
}

type SlackFollowupStatus struct {
	OK                    bool                        `json:"ok"`
	OutboundActions       []SlackOutboundAction       `json:"outboundActions"`
	ThreadRecommendations []SlackThreadRecommendation `json:"threadRecommendations"`
	HeartbeatFollowups    []SlackHeartbeatFollowup    `json:"heartbeatFollowups"`
	HeartbeatSurfaces     []SlackHeartbeatSurface     `json:"heartbeatSurfaces"`
}

type SlackFollowupCreateRequest struct {
	ChannelID               string         `json:"channel_id"`
	Channel                 string         `json:"channel"`
	ThreadTS                string         `json:"thread_ts"`
	ThreadTSAlt             string         `json:"threadTs"`
	SessionID               string         `json:"session_id"`
	SessionIDAlt            string         `json:"sessionId"`
	Kind                    string         `json:"kind"`
	Title                   string         `json:"title"`
	Summary                 string         `json:"summary"`
	SourceKind              string         `json:"source_kind"`
	SourceKindAlt           string         `json:"sourceKind"`
	SourceRef               string         `json:"source_ref"`
	SourceRefAlt            string         `json:"sourceRef"`
	Priority                string         `json:"priority"`
	DueAt                   string         `json:"due_at"`
	DueAtAlt                string         `json:"dueAt"`
	NextCheckAt             string         `json:"next_check_at"`
	NextCheckAtAlt          string         `json:"nextCheckAt"`
	Metadata                map[string]any `json:"metadata"`
	RequestedSurface        string         `json:"requested_surface"`
	RequestedSurfaceAlt     string         `json:"requestedSurface"`
	DeliveredSurface        string         `json:"delivered_surface"`
	DeliveredSurfaceAlt     string         `json:"deliveredSurface"`
	SurfaceStatus           string         `json:"surface_status"`
	SurfaceStatusAlt        string         `json:"surfaceStatus"`
	BlockReason             string         `json:"block_reason"`
	BlockReasonAlt          string         `json:"blockReason"`
	Error                   string         `json:"error"`
	FollowupStatus          string         `json:"followup_status"`
	FollowupStatusAlt       string         `json:"followupStatus"`
	RecommendationType      string         `json:"recommendation_type"`
	RecommendationTypeAlt   string         `json:"recommendationType"`
	RecommendationStatus    string         `json:"recommendation_status"`
	RecommendationStatusAlt string         `json:"recommendationStatus"`
	CardTS                  string         `json:"card_ts"`
	CardTSAlt               string         `json:"cardTs"`
	OutboundActionType      string         `json:"outbound_action_type"`
	OutboundActionTypeAlt   string         `json:"outboundActionType"`
	Target                  string         `json:"target"`
	Reference               string         `json:"reference"`
	OutboundStatus          string         `json:"outbound_status"`
	OutboundStatusAlt       string         `json:"outboundStatus"`
	Limit                   any            `json:"limit"`
}

type SlackFollowupCreateResponse struct {
	OK             bool                       `json:"ok"`
	Error          string                     `json:"error,omitempty"`
	Followup       *SlackHeartbeatFollowup    `json:"followup,omitempty"`
	Surface        *SlackHeartbeatSurface     `json:"surface,omitempty"`
	Recommendation *SlackThreadRecommendation `json:"recommendation,omitempty"`
	Outbound       *SlackOutboundAction       `json:"outbound,omitempty"`
	Status         SlackFollowupStatus        `json:"status"`
}

type SlackFollowupSurfaceRequest struct {
	FollowupID int64  `json:"followup_id"`
	Limit      int    `json:"limit"`
	Surface    string `json:"surface"`
}

type SlackFollowupSurfaceResponse struct {
	OK      bool                    `json:"ok"`
	Posted  []SlackHeartbeatSurface `json:"posted"`
	Skipped []SlackHeartbeatSurface `json:"skipped,omitempty"`
	Error   string                  `json:"error,omitempty"`
}

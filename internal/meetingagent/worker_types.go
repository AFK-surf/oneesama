package meetingagent

import "github.com/AFK-surf/oneesama/internal/agentrunner"

type WorkerReport struct {
	ID                  string                            `json:"id"`
	Status              string                            `json:"status"`
	Provider            string                            `json:"provider,omitempty"`
	Mode                string                            `json:"mode,omitempty"`
	Task                string                            `json:"task,omitempty"`
	Context             map[string]any                    `json:"context,omitempty"`
	AllowCodeChanges    bool                              `json:"allowCodeChanges"`
	Result              string                            `json:"result,omitempty"`
	Error               string                            `json:"error,omitempty"`
	ResultEnvelope      *agentrunner.WorkerResultEnvelope `json:"resultEnvelope,omitempty"`
	CreatedAt           string                            `json:"createdAt"`
	UpdatedAt           string                            `json:"updatedAt"`
	DeliveredToRealtime bool                              `json:"deliveredToRealtime"`
	DeliveredToSlack    bool                              `json:"deliveredToSlack"`
	RealtimeDelivery    *DeliveryMeta                     `json:"realtimeDelivery,omitempty"`
	SlackDelivery       *DeliveryMeta                     `json:"slackDelivery,omitempty"`
}

type DeliveryMeta struct {
	Channel     string `json:"channel,omitempty"`
	ThreadTS    string `json:"threadTs,omitempty"`
	TS          string `json:"ts,omitempty"`
	DedupKey    string `json:"dedupKey,omitempty"`
	Mock        bool   `json:"mock,omitempty"`
	DeliveredAt string `json:"deliveredAt"`
}

type WorkerReportInput struct {
	ID                  string                            `json:"id,omitempty"`
	JobID               string                            `json:"jobId,omitempty"`
	Status              string                            `json:"status,omitempty"`
	Provider            string                            `json:"provider,omitempty"`
	Mode                string                            `json:"mode,omitempty"`
	Task                string                            `json:"task,omitempty"`
	Context             map[string]any                    `json:"context,omitempty"`
	AllowCodeChanges    bool                              `json:"allowCodeChanges,omitempty"`
	Result              any                               `json:"result,omitempty"`
	Error               string                            `json:"error,omitempty"`
	ResultEnvelope      *agentrunner.WorkerResultEnvelope `json:"resultEnvelope,omitempty"`
	ResultEnvelopeSnake *agentrunner.WorkerResultEnvelope `json:"result_envelope,omitempty"`
}

type WorkerDelegateRequest struct {
	Task             string         `json:"task,omitempty"`
	Context          map[string]any `json:"context,omitempty"`
	Mode             string         `json:"mode,omitempty"`
	AllowCodeChanges bool           `json:"allowCodeChanges,omitempty"`
}

type WorkerStatusRequest struct {
	ID         string `json:"id,omitempty"`
	JobID      string `json:"jobId,omitempty"`
	JobIDSnake string `json:"job_id,omitempty"`
}

type WorkerPollRequest struct {
	Limit              int    `json:"limit,omitempty"`
	MarkDelivered      *bool  `json:"markDelivered,omitempty"`
	MarkDeliveredSnake *bool  `json:"mark_delivered,omitempty"`
	MinCreatedAt       string `json:"minCreatedAt,omitempty"`
	MinCreatedAtSnake  string `json:"min_created_at,omitempty"`
}

type WorkerMarkSlackDeliveredRequest struct {
	ID            string `json:"id,omitempty"`
	JobID         string `json:"jobId,omitempty"`
	JobIDSnake    string `json:"job_id,omitempty"`
	Channel       string `json:"channel,omitempty"`
	ThreadTS      string `json:"threadTs,omitempty"`
	ThreadTSSnake string `json:"thread_ts,omitempty"`
	TS            string `json:"ts,omitempty"`
	DedupKey      string `json:"dedupKey,omitempty"`
	DedupKeySnake string `json:"dedup_key,omitempty"`
	Mock          bool   `json:"mock,omitempty"`
}

type WorkerDelegateResponse struct {
	OK     bool            `json:"ok"`
	Job    agentrunner.Job `json:"job"`
	Report *WorkerReport   `json:"report,omitempty"`
	Error  string          `json:"error,omitempty"`
}

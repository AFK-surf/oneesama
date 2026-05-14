package slackagent

import "encoding/json"

type SlackEventEnvelope struct {
	Type                 string            `json:"type"`
	Challenge            string            `json:"challenge,omitempty"`
	EventID              string            `json:"event_id,omitempty"`
	TeamID               string            `json:"team_id,omitempty"`
	Event                SlackEventPayload `json:"event"`
	ThreadMessages       []SlackMessage    `json:"thread_messages,omitempty"`
	ThreadMessagesCamel  []SlackMessage    `json:"threadMessages,omitempty"`
	Replies              []SlackMessage    `json:"replies,omitempty"`
	MeetingContext       string            `json:"meeting_context,omitempty"`
	MeetingContextCamel  string            `json:"meetingContext,omitempty"`
	ThreadPermalink      string            `json:"thread_permalink,omitempty"`
	ThreadPermalinkCamel string            `json:"threadPermalink,omitempty"`
}

type SlackEventPayload struct {
	Type                 string                `json:"type"`
	User                 string                `json:"user,omitempty"`
	Text                 string                `json:"text,omitempty"`
	Channel              string                `json:"channel,omitempty"`
	ChannelType          string                `json:"channel_type,omitempty"`
	ThreadTS             string                `json:"thread_ts,omitempty"`
	TS                   string                `json:"ts,omitempty"`
	EventTS              string                `json:"event_ts,omitempty"`
	BotID                string                `json:"bot_id,omitempty"`
	Subtype              string                `json:"subtype,omitempty"`
	Message              *SlackMessage         `json:"message,omitempty"`
	PreviousMessage      *SlackMessage         `json:"previous_message,omitempty"`
	LatestReply          string                `json:"latest_reply,omitempty"`
	AssistantThread      *SlackAssistantThread `json:"assistant_thread,omitempty"`
	Context              *SlackThreadContext   `json:"context,omitempty"`
	ThreadMessages       []SlackMessage        `json:"thread_messages,omitempty"`
	ThreadMessagesCamel  []SlackMessage        `json:"threadMessages,omitempty"`
	Replies              []SlackMessage        `json:"replies,omitempty"`
	MeetingContext       string                `json:"meeting_context,omitempty"`
	MeetingContextCamel  string                `json:"meetingContext,omitempty"`
	ThreadPermalink      string                `json:"thread_permalink,omitempty"`
	ThreadPermalinkCamel string                `json:"threadPermalink,omitempty"`
}

type SlackAssistantThread struct {
	Context   *SlackThreadContext `json:"context,omitempty"`
	ChannelID string              `json:"channel_id,omitempty"`
	ThreadTS  string              `json:"thread_ts,omitempty"`
	UserID    string              `json:"user_id,omitempty"`
}

type SlackThreadContext struct {
	ChannelID string `json:"channel_id,omitempty"`
}

type SlackEventHeaders struct {
	RetryNum    string
	RetryReason string
}

type SlackRetryResponse struct {
	Num    string `json:"num,omitempty"`
	Reason string `json:"reason,omitempty"`
}

type SlackEventResponse struct {
	OK               bool                      `json:"ok"`
	Handled          bool                      `json:"handled,omitempty"`
	Ignored          bool                      `json:"ignored,omitempty"`
	Mode             string                    `json:"mode,omitempty"`
	Reason           string                    `json:"reason,omitempty"`
	EventKey         string                    `json:"event_key,omitempty"`
	EventType        string                    `json:"event_type,omitempty"`
	EventID          string                    `json:"event_id,omitempty"`
	Retry            *SlackRetryResponse       `json:"retry,omitempty"`
	Response         *AvatarCommandResponse    `json:"response,omitempty"`
	Posted           *SlackPostDispatch        `json:"posted,omitempty"`
	AssistantThread  *AssistantThreadRef       `json:"assistant_thread,omitempty"`
	AssistantStatus  *AssistantAPIResult       `json:"assistant_status,omitempty"`
	SuggestedPrompts *AssistantAPIResult       `json:"suggested_prompts,omitempty"`
	Inbound          *SlackInboundBufferResult `json:"inbound,omitempty"`
}

type SlackPostDispatch struct {
	Queued   bool   `json:"queued"`
	Channel  string `json:"channel,omitempty"`
	ThreadTS string `json:"thread_ts,omitempty"`
	DedupKey string `json:"dedup_key,omitempty"`
}

type AssistantThreadRef struct {
	ChannelID  string `json:"channel_id,omitempty"`
	ThreadTS   string `json:"thread_ts,omitempty"`
	ReactionTS string `json:"reaction_ts,omitempty"`
	UserID     string `json:"user_id,omitempty"`
}

type SlackMessage struct {
	Type         string            `json:"type,omitempty"`
	TS           string            `json:"ts,omitempty"`
	Timestamp    string            `json:"timestamp,omitempty"`
	EventTS      string            `json:"event_ts,omitempty"`
	User         string            `json:"user,omitempty"`
	UserID       string            `json:"user_id,omitempty"`
	UserIDCamel  string            `json:"userId,omitempty"`
	UserName     string            `json:"user_name,omitempty"`
	Username     string            `json:"username,omitempty"`
	BotID        string            `json:"bot_id,omitempty"`
	Subtype      string            `json:"subtype,omitempty"`
	Text         string            `json:"text,omitempty"`
	Channel      string            `json:"channel,omitempty"`
	ChannelType  string            `json:"channel_type,omitempty"`
	ThreadTS     string            `json:"thread_ts,omitempty"`
	ParentUserID string            `json:"parent_user_id,omitempty"`
	ReplyCount   int               `json:"reply_count,omitempty"`
	LatestReply  string            `json:"latest_reply,omitempty"`
	Replies      []SlackMessage    `json:"replies,omitempty"`
	Permalink    string            `json:"permalink,omitempty"`
	Files        []SlackFile       `json:"files,omitempty"`
	Attachments  []SlackAttachment `json:"attachments,omitempty"`
	Reactions    []SlackReaction   `json:"reactions,omitempty"`
	Blocks       []SlackBlock      `json:"blocks,omitempty"`
}

type SlackFile struct {
	ID         string `json:"id,omitempty"`
	Name       string `json:"name,omitempty"`
	Title      string `json:"title,omitempty"`
	Filetype   string `json:"filetype,omitempty"`
	Mimetype   string `json:"mimetype,omitempty"`
	Size       int64  `json:"size,omitempty"`
	OriginalW  int    `json:"original_w,omitempty"`
	OriginalH  int    `json:"original_h,omitempty"`
	Permalink  string `json:"permalink,omitempty"`
	ImageURL   string `json:"image_url,omitempty"`
	URL        string `json:"url,omitempty"`
	URLPrivate string `json:"url_private,omitempty"`
}

type SlackAttachment struct {
	Title     string      `json:"title,omitempty"`
	TitleLink string      `json:"title_link,omitempty"`
	Text      string      `json:"text,omitempty"`
	Files     []SlackFile `json:"files,omitempty"`
}

type SlackReaction struct {
	Name  string `json:"name,omitempty"`
	Count int    `json:"count,omitempty"`
}

type SlackBlock struct {
	Type     string              `json:"type,omitempty"`
	BlockID  string              `json:"block_id,omitempty"`
	Text     *SlackBlockText     `json:"text,omitempty"`
	Elements []SlackBlockElement `json:"elements,omitempty"`
}

type SlackBlockText struct {
	Type string `json:"type,omitempty"`
	Text string `json:"text,omitempty"`
}

func (t *SlackBlockText) UnmarshalJSON(data []byte) error {
	var text string
	if err := json.Unmarshal(data, &text); err == nil {
		t.Type = ""
		t.Text = text
		return nil
	}
	type slackBlockTextAlias SlackBlockText
	var parsed slackBlockTextAlias
	if err := json.Unmarshal(data, &parsed); err != nil {
		return err
	}
	*t = SlackBlockText(parsed)
	return nil
}

type SlackBlockElement struct {
	Type string          `json:"type,omitempty"`
	Text *SlackBlockText `json:"text,omitempty"`
	URL  string          `json:"url,omitempty"`
}

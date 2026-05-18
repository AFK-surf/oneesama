package slackagent

import (
	"context"
	"fmt"
	"strings"
)

const slackSuggestRoleAssistant = "assistant"

type slackSuggestActionTool struct {
	role                  string
	latestUserText        string
	fetchThreadTranscript func(context.Context, string, string) (string, error)
}

type slackSuggestActionRequest struct {
	Channel    string
	ThreadTS   string
	ActionType string
	Title      string
	Summary    string
	Params     map[string]any
}

type slackSuggestActionValidationResult struct {
	Success bool
	Text    string
}

func (t *slackSuggestActionTool) normalizeRequest(ctx context.Context, args map[string]any) (*slackSuggestActionRequest, *slackSuggestActionValidationResult) {
	channel := stringFromAny(args["channel"])
	threadTS := firstNonEmpty(stringFromAny(args["thread_ts"]), stringFromAny(args["threadTs"]))
	actionType := stringFromAny(args["action_type"])
	title := stringFromAny(args["title"])
	summary := stringFromAny(args["summary"])
	params, _ := mapFromAny(args["params"])

	if summary == "" && title != "" {
		summary = title
	}
	if channel == "" || threadTS == "" || actionType == "" || title == "" {
		return nil, &slackSuggestActionValidationResult{Success: false, Text: "channel, thread_ts, action_type, and title are required"}
	}
	if !isSupportedSuggestActionType(actionType) {
		return nil, &slackSuggestActionValidationResult{Success: false, Text: fmt.Sprintf("unsupported action_type %q", actionType)}
	}
	if actionType != slackActionTypeJoinMeeting && params == nil {
		return nil, &slackSuggestActionValidationResult{Success: false, Text: "params is required"}
	}
	if params == nil {
		params = make(map[string]any)
	}

	switch actionType {
	case slackActionTypeCreateIssue:
		if strings.TrimSpace(stringFromAny(params["title"])) == "" {
			return nil, &slackSuggestActionValidationResult{Success: false, Text: "create_issue requires params.title"}
		}
		if t.role == slackSuggestRoleAssistant && explicitlyRequestsIssueCreation(t.latestUserText) {
			return nil, &slackSuggestActionValidationResult{Success: false, Text: "Direct issue creation was explicitly authorized in the current user message. Do not use suggest_action(create_issue); call linear_api issueCreate directly."}
		}
	case slackActionTypeAddComment:
		if strings.TrimSpace(stringFromAny(params["body"])) == "" {
			return nil, &slackSuggestActionValidationResult{Success: false, Text: "add_comment requires params.body"}
		}
		if strings.TrimSpace(firstNonEmpty(stringFromAny(params["issue_id"]), stringFromAny(params["issueIdentifier"]), stringFromAny(params["issue_identifier"]))) == "" {
			return nil, &slackSuggestActionValidationResult{Success: false, Text: "add_comment requires params.issue_id or params.issue_identifier"}
		}
	case slackActionTypeCreateEvent:
		if strings.TrimSpace(stringFromAny(params["title"])) == "" || strings.TrimSpace(stringFromAny(params["start_time"])) == "" {
			return nil, &slackSuggestActionValidationResult{Success: false, Text: "create_event requires params.title and params.start_time"}
		}
	case slackActionTypeJoinMeeting:
		if err := t.fillJoinMeetingParams(ctx, channel, threadTS, title, summary, params); err != nil {
			return nil, &slackSuggestActionValidationResult{Success: false, Text: err.Error()}
		}
	case slackActionTypeCreateChannel:
		if strings.TrimSpace(firstNonEmpty(stringFromAny(params["channel_name"]), stringFromAny(params["channelName"]))) == "" {
			return nil, &slackSuggestActionValidationResult{Success: false, Text: "create_channel requires params.channel_name"}
		}
	case slackActionTypeCreateCanvas:
		if strings.TrimSpace(stringFromAny(params["markdown"])) == "" {
			return nil, &slackSuggestActionValidationResult{Success: false, Text: "create_canvas requires params.markdown"}
		}
		if strings.TrimSpace(firstNonEmpty(stringFromAny(params["canvas_title"]), stringFromAny(params["canvasTitle"]), title)) == "" {
			return nil, &slackSuggestActionValidationResult{Success: false, Text: "create_canvas requires params.canvas_title (or top-level title) for safety dedupe"}
		}
	case slackActionTypeEditCanvas:
		if strings.TrimSpace(firstNonEmpty(stringFromAny(params["file_id"]), stringFromAny(params["fileId"]), stringFromAny(params["canvas_id"]), stringFromAny(params["canvasId"]))) == "" {
			return nil, &slackSuggestActionValidationResult{Success: false, Text: "edit_canvas requires params.file_id (Slack canvas file ID); refuse to blindly edit canvases without an explicit target"}
		}
		if strings.TrimSpace(stringFromAny(params["markdown"])) == "" {
			return nil, &slackSuggestActionValidationResult{Success: false, Text: "edit_canvas requires params.markdown"}
		}
		op := strings.TrimSpace(strings.ToLower(stringFromAny(params["op"])))
		if op == "" {
			op = "insert_at_end"
		}
		switch op {
		case "insert_at_end", "insert_at_start", "replace":
		default:
			return nil, &slackSuggestActionValidationResult{Success: false, Text: fmt.Sprintf("edit_canvas op %q is not allowed; use insert_at_end (default), insert_at_start, or replace", op)}
		}
		params["op"] = op
	}

	return &slackSuggestActionRequest{
		Channel:    channel,
		ThreadTS:   threadTS,
		ActionType: actionType,
		Title:      title,
		Summary:    summary,
		Params:     params,
	}, nil
}

func (t *slackSuggestActionTool) fillJoinMeetingParams(ctx context.Context, channel, threadTS, title, summary string, params map[string]any) error {
	meetURL := strings.TrimSpace(stringFromAny(params["meet_url"]))
	if meetURL == "" {
		for _, alias := range []string{"url", "meeting_url", "link"} {
			if aliasValue := findSlackMeetURL(stringFromAny(params[alias])); aliasValue != "" {
				meetURL = aliasValue
				break
			}
		}
	}
	if meetURL == "" {
		for _, source := range []string{title, summary} {
			if sourceURL := findSlackMeetURL(source); sourceURL != "" {
				meetURL = sourceURL
				break
			}
		}
	}
	if meetURL == "" {
		transcript, err := t.fetchTranscript(ctx, channel, threadTS)
		if err != nil {
			return fmt.Errorf("join_meeting requires params.meet_url, and fetching the thread for fallback failed: %w", err)
		}
		meetURL = findSlackMeetURL(transcript)
	}
	if meetURL == "" {
		return fmt.Errorf("join_meeting requires params.meet_url or a Google Meet URL in the thread")
	}
	params["meet_url"] = meetURL
	return nil
}

func (t *slackSuggestActionTool) fetchTranscript(ctx context.Context, channel, threadTS string) (string, error) {
	if t.fetchThreadTranscript != nil {
		return t.fetchThreadTranscript(ctx, channel, threadTS)
	}
	return "", fmt.Errorf("thread transcript fetcher not configured for %s/%s", channel, threadTS)
}

func isSupportedSuggestActionType(actionType string) bool {
	switch actionType {
	case slackActionTypeCreateIssue, slackActionTypeAddComment, slackActionTypeCreateEvent, slackActionTypeJoinMeeting, slackActionTypeCreateChannel, slackActionTypeCreateCanvas, slackActionTypeEditCanvas:
		return true
	default:
		return false
	}
}

func explicitlyRequestsIssueCreation(text string) bool {
	normalized := strings.ToLower(strings.TrimSpace(text))
	if normalized == "" {
		return false
	}

	for _, blocked := range []string{
		"不要创建",
		"别创建",
		"不用创建",
		"不需要创建",
		"不要建",
		"别建",
		"不用建",
		"先看看",
		"有没有相关 issue",
		"don't create",
		"do not create",
		"not create",
	} {
		if strings.Contains(normalized, blocked) {
			return false
		}
	}

	for _, direct := range []string{
		"创建一个",
		"创建两个",
		"创建 issue",
		"创建个 issue",
		"创建 linear issue",
		"新建一个",
		"新建 issue",
		"建一个",
		"建两个",
		"建 issue",
		"开一个 issue",
		"开个 issue",
		"直接创建",
		"明确创建",
		"create an issue",
		"create a new issue",
		"create new issue",
		"create one",
		"file an issue",
		"file a new issue",
		"open an issue",
		"open a new issue",
	} {
		if strings.Contains(normalized, direct) {
			return true
		}
	}
	if strings.Contains(normalized, "create") && (strings.Contains(normalized, "issue") || strings.Contains(normalized, "linear")) {
		return true
	}
	if strings.Contains(normalized, "open") && strings.Contains(normalized, "issue") {
		return true
	}
	if strings.Contains(normalized, "file") && strings.Contains(normalized, "issue") {
		return true
	}
	return false
}

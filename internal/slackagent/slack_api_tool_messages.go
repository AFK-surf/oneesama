package slackagent

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"
)

const (
	slackAPIRoleAssistant = "assistant"
)

type slackAPITool struct {
	role          string
	apiURL        string
	token         string
	activeThread  func(channel, threadTS string) bool
	httpTransport http.RoundTripper
}

type slackAPIToolResult struct {
	Success bool
	Text    string
}

func (r slackAPIToolResult) GetTextOutput() string {
	return r.Text
}

func (t *slackAPITool) Execute(ctx context.Context, args map[string]any) (slackAPIToolResult, error) {
	method := strings.TrimSpace(stringFromAny(args["method"]))
	action := strings.TrimSpace(stringFromAny(args["action"]))
	params, _ := args["params"].(map[string]any)
	if params == nil {
		params = map[string]any{}
	}

	resolvedAction, _, err := resolveSlackAPIOperation(action, method)
	if err != nil {
		return slackAPIToolResult{Success: false, Text: err.Error()}, nil
	}

	if resolvedAction == "post_thread_reply" && t.role == slackAPIRoleAssistant {
		return slackAPIToolResult{Success: false, Text: plannerOnlySlackActionMessage(resolvedAction, params)}, nil
	}
	if resolvedAction != "post_message" {
		return slackAPIToolResult{Success: false, Text: fmt.Sprintf("Action %q is not implemented by the current Slack API parity shim", resolvedAction)}, nil
	}
	return t.actionPostMessage(ctx, params)
}

func (t *slackAPITool) actionPostMessage(ctx context.Context, params map[string]any) (slackAPIToolResult, error) {
	channel := strings.TrimSpace(stringFromAny(params["channel"]))
	threadTS := strings.TrimSpace(stringFromAny(params["thread_ts"]))
	text := strings.TrimSpace(stringFromAny(params["text"]))

	if t.activeThread != nil && t.activeThread(channel, threadTS) {
		return slackAPIToolResult{Success: false, Text: "Cannot call chat.postMessage on the current thread. Output your response text directly — the system delivers it automatically."}, nil
	}
	if channel == "" || text == "" {
		return slackAPIToolResult{
			Success: false,
			Text: "channel and text are required for chat.postMessage. " +
				"Use chat.postMessage for scheduled tasks or assistant-initiated Slack posts, for example: " +
				slackPostMessageRetrySnippet(params) + ". " +
				"If you are replying to the current @mention thread, do NOT call slack_api; just output your reply text directly and the system will deliver it automatically.",
		}, nil
	}

	apiURL := strings.TrimRight(strings.TrimSpace(t.apiURL), "/")
	if apiURL == "" {
		apiURL = "https://slack.com/api"
	}
	form := url.Values{}
	form.Set("channel", channel)
	form.Set("text", text)
	if threadTS != "" {
		form.Set("thread_ts", threadTS)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, apiURL+"/chat.postMessage", strings.NewReader(form.Encode()))
	if err != nil {
		return slackAPIToolResult{}, err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	if token := strings.TrimSpace(t.token); token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}

	client := &http.Client{Transport: t.httpTransport}
	if client.Transport == nil {
		client.Transport = http.DefaultTransport
	}
	resp, err := client.Do(req)
	if err != nil {
		return slackAPIToolResult{Success: false, Text: "Failed to post blocks: " + err.Error()}, nil
	}
	defer resp.Body.Close()

	var body struct {
		OK      bool   `json:"ok"`
		Error   string `json:"error"`
		Channel string `json:"channel"`
		TS      string `json:"ts"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		return slackAPIToolResult{Success: false, Text: "Failed to decode Slack response: " + err.Error()}, nil
	}
	if !body.OK {
		return slackAPIToolResult{Success: false, Text: "Failed to post blocks: " + firstNonEmpty(body.Error, resp.Status)}, nil
	}
	return slackAPIToolResult{Success: true, Text: fmt.Sprintf("Message posted (ts: %s, 1 blocks)", body.TS)}, nil
}

var slackAPIMethodByAction = map[string]string{
	"post_message":      "chat.postMessage",
	"post_thread_reply": "slack.postThreadReply",
}

var slackAPIActionsByMethod = map[string]string{
	"chat.postMessage":      "post_message",
	"slack.postThreadReply": "post_thread_reply",
}

func resolveSlackAPIOperation(action, method string) (string, string, error) {
	action = strings.TrimSpace(action)
	method = strings.TrimSpace(method)

	var resolvedAction string
	var actionFromMethod string
	switch {
	case method != "":
		var ok bool
		actionFromMethod, ok = slackAPIActionsByMethod[method]
		if !ok {
			return "", "", fmt.Errorf("unknown method: %q", method)
		}
		resolvedAction = actionFromMethod
	case action != "":
		resolvedAction = action
	default:
		return "", "", fmt.Errorf("either method or action is required")
	}

	canonicalMethod, ok := slackAPIMethodByAction[resolvedAction]
	if !ok {
		return "", "", fmt.Errorf("unknown action: %q", resolvedAction)
	}
	if action != "" && method != "" && actionFromMethod != action {
		return "", "", fmt.Errorf("method %q does not match action %q (expected %q)", method, action, canonicalMethod)
	}
	return resolvedAction, canonicalMethod, nil
}

func plannerOnlySlackActionMessage(action string, params map[string]any) string {
	switch action {
	case "post_thread_reply":
		return `WRONG ACTION: post_thread_reply is only available to the planner role. If this is a scheduled task or assistant-initiated Slack post, use chat.postMessage instead. Retry NOW with: ` + slackPostMessageRetrySnippet(params)
	default:
		return fmt.Sprintf("%s is only available to the planner role", action)
	}
}

func slackPostMessageRetrySnippet(params map[string]any) string {
	channel := strings.TrimSpace(stringFromAny(params["channel"]))
	threadTS := strings.TrimSpace(stringFromAny(params["thread_ts"]))
	if channel == "" {
		channel = "<channel-id>"
	}
	if threadTS != "" {
		return `slack_api(method="chat.postMessage", params={"channel": "` + channel + `", "thread_ts": "` + threadTS + `", "text": "<your message>"})`
	}
	return `slack_api(method="chat.postMessage", params={"channel": "` + channel + `", "text": "<your message>"})`
}

package slackagent

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
)

const (
	slackAPIRoleAssistant = "assistant"
	slackAPIRolePlanner   = "planner"
)

type slackAPITool struct {
	role                  string
	apiURL                string
	token                 string
	workspaceDir          string
	activeThread          func(channel, threadTS string) bool
	httpTransport         http.RoundTripper
	messageTargets        map[string]slackAPIMessageTarget
	latestTargetByChannel map[string]slackAPIMessageTarget
	publicReplyDelivery   func(context.Context, slackPublicThreadReplyDelivery) slackPublicThreadReplyDeliveryResult
	customEmoji           func() []string
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

	if resolvedAction == "post_thread_reply" && t.role != slackAPIRolePlanner {
		return slackAPIToolResult{Success: false, Text: plannerOnlySlackActionMessage(resolvedAction, params)}, nil
	}
	if resolvedAction == "post_message" && t.role == slackAPIRolePlanner {
		return slackAPIToolResult{Success: false, Text: `WRONG ACTION: post_message is NOT available in triage mode. Use slack.postThreadReply instead. Retry NOW with: ` + slackPostThreadReplyRetrySnippet(params)}, nil
	}
	switch resolvedAction {
	case "post_message":
		if reason := t.validatePostMessageContract(resolvedAction, params); reason != "" {
			return slackAPIToolResult{Success: false, Text: reason}, nil
		}
		return t.actionPostMessageWithAction(ctx, params, resolvedAction)
	case "post_thread_reply":
		if reason := t.validatePostMessageContract(resolvedAction, params); reason != "" {
			return slackAPIToolResult{Success: false, Text: reason}, nil
		}
		return t.actionPostThreadReply(ctx, params)
	case "fetch_thread":
		return t.actionFetchThread(ctx, params)
	case "fetch_channel_history":
		return t.actionFetchChannelHistory(ctx, params)
	case "upload_file":
		return t.actionUploadFile(ctx, params), nil
	case "add_reaction":
		return t.actionAddReaction(ctx, params)
	case "list_emoji":
		return t.actionListEmoji(ctx, params)
	case "delete_message", "edit_message", "pin", "unpin", "set_topic", "set_purpose", "add_bookmark", "invite":
		return t.actionGenericSlackForm(ctx, resolvedAction, params)
	case "fetch_canvas":
		return t.actionFetchCanvas(ctx, params), nil
	case "fetch_image":
		return t.actionFetchImage(ctx, params), nil
	case "fetch_file":
		return t.actionFetchFile(ctx, params), nil
	case "create_canvas":
		return t.actionCreateCanvas(ctx, params), nil
	case "edit_canvas":
		return t.actionEditCanvas(ctx, params), nil
	case "send_dm":
		return slackAPIToolResult{Success: false, Text: fmt.Sprintf("Action %q is registered in the matrix but not available in this Go runtime yet", resolvedAction)}, nil
	default:
		return slackAPIToolResult{Success: false, Text: fmt.Sprintf("Action %q is not implemented by the current Slack API parity shim", resolvedAction)}, nil
	}
}

func (t *slackAPITool) actionPostMessage(ctx context.Context, params map[string]any) (slackAPIToolResult, error) {
	return t.actionPostMessageWithAction(ctx, params, "post_message")
}

func (t *slackAPITool) actionPostMessageWithAction(ctx context.Context, params map[string]any, action string) (slackAPIToolResult, error) {
	channel := strings.TrimSpace(stringFromAny(params["channel"]))
	threadTS := strings.TrimSpace(stringFromAny(params["thread_ts"]))
	text := strings.TrimSpace(sanitizeSlackOutgoingText(stringFromAny(params["text"])))

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

	purpose := slackAPIPostMessagePurpose(action, params)
	if postMessagePurposeUsesPublicReplyHelper(purpose) {
		return t.actionPostMessageViaPublicReplyDelivery(ctx, params, channel, threadTS, text, purpose)
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
	rawBlocks, hasBlocks := params["blocks"]
	blocksAttached := 0
	if hasBlocks && rawBlocks != nil {
		blocksJSON, count, err := encodeSafeBlocks(rawBlocks)
		if err != nil {
			return slackAPIToolResult{Success: false, Text: "Failed to post blocks: " + err.Error()}, nil
		}
		if count > 0 {
			form.Set("blocks", blocksJSON)
			blocksAttached = count
		}
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
		return slackAPIToolResult{Success: false, Text: "Failed to post chat.postMessage: " + err.Error()}, nil
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
		return slackAPIToolResult{Success: false, Text: "Failed to post chat.postMessage: " + firstNonEmpty(body.Error, resp.Status)}, nil
	}
	return slackAPIToolResult{Success: true, Text: fmt.Sprintf("Message posted (ts: %s, %d blocks)", body.TS, blocksAttached)}, nil
}

func (t *slackAPITool) actionPostThreadReply(ctx context.Context, params map[string]any) (slackAPIToolResult, error) {
	channel := strings.TrimSpace(stringFromAny(params["channel"]))
	threadTS := strings.TrimSpace(firstNonEmpty(stringFromAny(params["thread_ts"]), stringFromAny(params["ts"])))
	text := strings.TrimSpace(stringFromAny(params["text"]))
	if channel == "" || threadTS == "" || text == "" {
		return slackAPIToolResult{
			Success: false,
			Text:    "channel, thread_ts, and text are required for slack.postThreadReply. Retry NOW with: " + slackPostThreadReplyRetrySnippet(params),
		}, nil
	}
	params = cloneStringAnyMap(params)
	params["thread_ts"] = threadTS
	params["purpose"] = postMessagePurposePublicThreadReply
	return t.actionPostMessageWithAction(ctx, params, "post_thread_reply")
}

func (t *slackAPITool) actionPostMessageViaPublicReplyDelivery(ctx context.Context, params map[string]any, channel string, threadTS string, text string, purpose string) (slackAPIToolResult, error) {
	if t.publicReplyDelivery == nil {
		return slackAPIToolResult{Success: false, Text: "Public Slack posts from slack_api require the service delivery gate. Retry through the foreground delivery path instead of direct chat.postMessage."}, nil
	}
	blocks, blockCount, err := safeSlackBlockMaps(params["blocks"])
	if err != nil {
		return slackAPIToolResult{Success: false, Text: "Failed to post blocks: " + err.Error()}, nil
	}
	delivery := t.publicReplyDelivery(ctx, slackPublicThreadReplyDelivery{
		Source:        slackPublicReplySourceSlackAPITool,
		SurfaceKind:   postMessagePublicSurfaceKind(purpose, stringFromAny(params["surface_kind"])),
		WorkspaceID:   stringFromAny(params["workspace_id"]),
		ChannelID:     channel,
		ThreadTS:      threadTS,
		FallbackText:  text,
		Blocks:        blocks,
		DedupKey:      stringFromAny(params["dedup_key"]),
		SnapshotTS:    stringFromAny(params["snapshot_ts"]),
		LedgerSummary: stringFromAny(params["ledger_summary"]),
	})
	if delivery.Blocked {
		return slackAPIToolResult{Success: false, Text: "Public Slack post blocked: " + firstNonEmpty(delivery.BlockReason, "blocked")}, nil
	}
	if !delivery.Post.OK {
		return slackAPIToolResult{Success: false, Text: "Failed to post chat.postMessage: " + firstNonEmpty(delivery.Post.Error, delivery.Post.Detail, "post_failed")}, nil
	}
	return slackAPIToolResult{Success: true, Text: fmt.Sprintf("Message posted (ts: %s, %d blocks)", delivery.Post.TS, blockCount)}, nil
}

func (t *slackAPITool) validatePostMessageContract(action string, params map[string]any) string {
	purpose := slackAPIPostMessagePurpose(action, params)
	if strings.TrimSpace(stringFromAny(params["purpose"])) != "" && purpose == "" {
		return "Invalid Slack post purpose. Use one of: public_thread_reply, public_channel_notice, operator_notice, status, status_update, control_plane, manual_override, meeting_notification."
	}
	if action == "post_thread_reply" {
		if purpose != postMessagePurposePublicThreadReply {
			return "slack.postThreadReply always uses purpose=public_thread_reply; use chat.postMessage with an explicit escape purpose for non-reply notifications"
		}
		return ""
	}
	channel := strings.TrimSpace(stringFromAny(params["channel"]))
	if strings.HasPrefix(channel, "D") && purpose == "" {
		return ""
	}
	if purpose == "" {
		return "Slack chat.postMessage requires an explicit purpose. Use purpose=public_channel_notice for public channel notices, purpose=public_thread_reply for public thread replies, or an escape purpose such as operator_notice/status/control_plane/meeting_notification. If this is the current @mention thread, output your reply text directly."
	}
	if purpose == postMessagePurposeManualOverride && strings.TrimSpace(stringFromAny(params["bypass_reason"])) == "" {
		return "manual_override Slack posts require bypass_reason"
	}
	if purpose == postMessagePurposePublicThreadReply && strings.TrimSpace(firstNonEmpty(stringFromAny(params["thread_ts"]), stringFromAny(params["ts"]))) == "" {
		return "public_thread_reply Slack posts require thread_ts"
	}
	if purpose == postMessagePurposePublicChannelNotice && strings.TrimSpace(stringFromAny(params["thread_ts"])) != "" {
		return "public_channel_notice Slack posts must not include thread_ts; use public_thread_reply for thread replies"
	}
	if slackAPIPostMessagePurposeRequiresDedup(purpose) && !strings.HasPrefix(channel, "D") && strings.TrimSpace(stringFromAny(params["dedup_key"])) == "" {
		return purpose + " Slack posts to public channels require dedup_key"
	}
	return ""
}

func slackAPIPostMessagePurpose(action string, params map[string]any) string {
	if action == "post_thread_reply" && strings.TrimSpace(stringFromAny(params["purpose"])) == "" {
		return postMessagePurposePublicThreadReply
	}
	return normalizePostMessagePurpose(stringFromAny(params["purpose"]))
}

func slackAPIPostMessagePurposeRequiresDedup(purpose string) bool {
	switch purpose {
	case postMessagePurposeOperatorNotice,
		postMessagePurposeStatus,
		postMessagePurposeStatusUpdate,
		postMessagePurposeControlPlane,
		postMessagePurposeMeetingNotification:
		return true
	default:
		return false
	}
}

func safeSlackBlockMaps(raw any) ([]map[string]any, int, error) {
	if raw == nil {
		return nil, 0, nil
	}
	blocksJSON, count, err := encodeSafeBlocks(raw)
	if err != nil || count == 0 {
		return nil, count, err
	}
	var blocks []map[string]any
	if err := json.Unmarshal([]byte(blocksJSON), &blocks); err != nil {
		return nil, 0, err
	}
	return blocks, count, nil
}

func (t *slackAPITool) actionFetchThread(ctx context.Context, params map[string]any) (slackAPIToolResult, error) {
	channel, threadTS := normalizedFetchThreadParams(params)
	if channel == "" || threadTS == "" {
		return slackAPIToolResult{Success: false, Text: "channel and thread_ts are required for conversations.replies"}, nil
	}
	limit := maxInt(intFromAny(params["limit"]), maxAppMentionThreadMessages)
	values := url.Values{
		"channel": {channel},
		"ts":      {threadTS},
		"limit":   {strconv.Itoa(limit)},
	}
	var body slackRepliesResponse
	if result := t.callSlackGET(ctx, slackThreadFetchAPIBaseURL, "conversations.replies", values, &body); !result.OK || !body.OK {
		return slackAPIToolResult{Success: false, Text: "Failed to fetch thread: " + firstNonEmpty(body.Error, result.Error, result.Detail)}, nil
	}
	return slackAPIJSONTextResult(map[string]any{
		"ok":       true,
		"channel":  channel,
		"threadTS": threadTS,
		"messages": body.Messages,
	})
}

func normalizedFetchThreadParams(params map[string]any) (string, string) {
	channel := strings.TrimSpace(stringFromContext(params, "channel"))
	threadTS := strings.TrimSpace(stringFromContext(params, "thread_ts"))
	if threadTS == "" {
		threadTS = strings.TrimSpace(stringFromContext(params, "ts"))
	}
	return channel, threadTS
}

func (t *slackAPITool) actionFetchChannelHistory(ctx context.Context, params map[string]any) (slackAPIToolResult, error) {
	channel := strings.TrimSpace(firstNonEmpty(stringFromAny(params["channel"]), stringFromAny(params["channel_id"])))
	if channel == "" {
		return slackAPIToolResult{Success: false, Text: "channel is required for conversations.history"}, nil
	}
	limit := intFromAny(params["limit"])
	if limit <= 0 {
		limit = 20
	}
	values := url.Values{
		"channel": {channel},
		"limit":   {strconv.Itoa(limit)},
	}
	if cursor := strings.TrimSpace(stringFromAny(params["cursor"])); cursor != "" {
		values.Set("cursor", cursor)
	}
	if oldest := strings.TrimSpace(stringFromAny(params["oldest"])); oldest != "" {
		values.Set("oldest", oldest)
	}
	if latest := strings.TrimSpace(stringFromAny(params["latest"])); latest != "" {
		values.Set("latest", latest)
	}
	var body slackRepliesResponse
	if result := t.callSlackGET(ctx, slackThreadFetchAPIBaseURL, "conversations.history", values, &body); !result.OK || !body.OK {
		return slackAPIToolResult{Success: false, Text: "Failed to fetch channel history: " + firstNonEmpty(body.Error, result.Error, result.Detail)}, nil
	}
	return slackAPIJSONTextResult(map[string]any{
		"ok":       true,
		"channel":  channel,
		"messages": body.Messages,
	})
}

func (t *slackAPITool) actionUploadFile(ctx context.Context, params map[string]any) slackAPIToolResult {
	rawPath := firstNonEmpty(stringFromAny(params["path"]), stringFromAny(params["file_path"]))
	resolvedPath, err := slackWorkspaceFileResolver{workspaceDir: t.workspaceDir}.resolveLocalUploadPath(rawPath)
	if err != nil {
		return slackAPIToolResult{Success: false, Text: "Failed to upload file: " + err.Error()}
	}
	client := &http.Client{Transport: t.httpTransport}
	if client.Transport == nil {
		client.Transport = http.DefaultTransport
	}
	result := UploadSlackFile(ctx, client, t.token, t.apiURL, SlackFileUploadInput{
		Path:           resolvedPath,
		Filename:       stringFromAny(params["filename"]),
		Title:          stringFromAny(params["title"]),
		Channel:        firstNonEmpty(stringFromAny(params["channel"]), stringFromAny(params["channel_id"])),
		ThreadTS:       firstNonEmpty(stringFromAny(params["thread_ts"]), stringFromAny(params["threadTs"])),
		InitialComment: firstNonEmpty(stringFromAny(params["initial_comment"]), stringFromAny(params["comment"])),
	})
	if !result.OK {
		return slackAPIToolResult{Success: false, Text: "Failed to upload file: " + firstNonEmpty(result.Error, result.Detail)}
	}
	text := fmt.Sprintf("File uploaded: %s", firstNonEmpty(result.Permalink, result.FileID, result.Filename))
	return slackAPIToolResult{Success: true, Text: text}
}

func (t *slackAPITool) actionAddReaction(ctx context.Context, params map[string]any) (slackAPIToolResult, error) {
	channel := strings.TrimSpace(firstNonEmpty(stringFromAny(params["channel"]), stringFromAny(params["channel_id"])))
	timestamp := strings.TrimSpace(firstNonEmpty(
		stringFromAny(params["timestamp"]),
		stringFromAny(params["msg_ts"]),
		stringFromAny(params["ts"]),
		stringFromAny(params["thread_ts"]),
	))
	messageRef := strings.TrimSpace(firstNonEmpty(stringFromAny(params["message_ref"]), stringFromAny(params["target_ref"])))
	if messageRef != "" {
		target, ok := t.messageTargets[messageRef]
		if !ok {
			return slackAPIToolResult{Success: false, Text: fmt.Sprintf("Unknown message_ref %q. Use a ref from the digest such as m1, m2, ...", messageRef)}, nil
		}
		if channel == "" {
			channel = target.ChannelID
		}
		if timestamp == "" {
			timestamp = target.Timestamp
		}
	}
	if channel != "" && timestamp == "" {
		if target, ok := t.latestTargetByChannel[channel]; ok {
			timestamp = target.Timestamp
		}
	}
	emoji := normalizeSlackReactionName(firstNonEmpty(
		stringFromAny(params["emoji"]),
		stringFromAny(params["name"]),
		stringFromAny(params["reaction"]),
	))
	if channel == "" || timestamp == "" || emoji == "" {
		return slackAPIToolResult{Success: false, Text: "emoji and a target message are required. Prefer message_ref from the digest (for example m1). If you only provide channel, the tool will target the latest digest message in that channel when possible."}, nil
	}
	values := url.Values{}
	values.Set("channel", channel)
	values.Set("timestamp", timestamp)
	values.Set("name", emoji)
	client := &http.Client{Transport: t.httpTransport}
	if client.Transport == nil {
		client.Transport = http.DefaultTransport
	}
	var body map[string]any
	result := callSlackFormAPI(ctx, client, t.token, t.apiURL, slackAPIMethodByAction["add_reaction"], values, &body)
	if !result.OK {
		return slackAPIToolResult{Success: false, Text: "Failed to call reactions.add: " + firstNonEmpty(result.Error, result.Detail)}, nil
	}
	if ok, _ := body["ok"].(bool); !ok {
		errText := firstNonEmpty(stringFromAny(body["error"]), "slack_api_error")
		if errText == "already_reacted" {
			return slackAPIToolResult{Success: true, Text: "Already reacted with this emoji"}, nil
		}
		return slackAPIToolResult{Success: false, Text: "Failed to call reactions.add: " + errText}, nil
	}
	return slackAPIToolResult{Success: true, Text: fmt.Sprintf("Added :%s: reaction", emoji)}, nil
}

func (t *slackAPITool) actionGenericSlackForm(ctx context.Context, action string, params map[string]any) (slackAPIToolResult, error) {
	method := slackAPIMethodByAction[action]
	if method == "" {
		return slackAPIToolResult{Success: false, Text: fmt.Sprintf("No Slack API method registered for action %q", action)}, nil
	}
	values := url.Values{}
	for key, value := range params {
		if text := slackAPIParamString(value); text != "" {
			values.Set(key, text)
		}
	}
	normalizeSlackFormAliases(values, action)
	client := &http.Client{Transport: t.httpTransport}
	if client.Transport == nil {
		client.Transport = http.DefaultTransport
	}
	var body map[string]any
	result := callSlackFormAPI(ctx, client, t.token, t.apiURL, method, values, &body)
	if !result.OK {
		return slackAPIToolResult{Success: false, Text: "Failed to call " + method + ": " + firstNonEmpty(result.Error, result.Detail)}, nil
	}
	if ok, _ := body["ok"].(bool); !ok {
		return slackAPIToolResult{Success: false, Text: "Failed to call " + method + ": " + firstNonEmpty(stringFromAny(body["error"]), "slack_api_error")}, nil
	}
	return slackAPIJSONTextResult(body)
}

func (t *slackAPITool) actionListEmoji(ctx context.Context, params map[string]any) (slackAPIToolResult, error) {
	if t.customEmoji != nil {
		if names := t.customEmoji(); len(names) > 0 {
			return workspaceCustomEmojiJSON(names, "workspace_cache"), nil
		}
	}
	return t.actionGenericSlackForm(ctx, "list_emoji", params)
}

type slackAPIMessageTarget struct {
	ChannelID string
	Timestamp string
}

var slackAPIDigestMessageRefPattern = regexp.MustCompile(`\[ref:([^\s\]]+)\s+msg_ts:([^\s\]]+)\]`)

func slackAPIMessageTargetsFromArgs(args map[string]any, params map[string]any) (map[string]slackAPIMessageTarget, map[string]slackAPIMessageTarget) {
	targets := map[string]slackAPIMessageTarget{}
	latest := map[string]slackAPIMessageTarget{}
	for _, raw := range []string{
		stringFromAny(args["digest"]),
		stringFromAny(args["slack_activity_digest"]),
		stringFromAny(args["slackActivityDigest"]),
		stringFromAny(params["digest"]),
		stringFromAny(params["slack_activity_digest"]),
		stringFromAny(params["slackActivityDigest"]),
	} {
		for ref, target := range slackAPIMessageTargetsFromDigest(raw) {
			targets[ref] = target
			if target.ChannelID != "" {
				if previous, ok := latest[target.ChannelID]; !ok || slackTimestampLess(previous.Timestamp, target.Timestamp) {
					latest[target.ChannelID] = target
				}
			}
		}
	}
	return targets, latest
}

func slackTimestampLess(left string, right string) bool {
	left = strings.TrimSpace(left)
	right = strings.TrimSpace(right)
	if left == "" {
		return right != ""
	}
	if right == "" {
		return false
	}
	return left < right
}

func slackAPIMessageTargetsFromDigest(digest string) map[string]slackAPIMessageTarget {
	targets := map[string]slackAPIMessageTarget{}
	currentChannel := ""
	for _, line := range strings.Split(digest, "\n") {
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "#") && !strings.Contains(trimmed, " ") {
			currentChannel = strings.TrimPrefix(trimmed, "#")
			continue
		}
		match := slackAPIDigestMessageRefPattern.FindStringSubmatch(trimmed)
		if len(match) != 3 {
			continue
		}
		ref := strings.TrimSpace(match[1])
		timestamp := strings.TrimSpace(match[2])
		if ref == "" || timestamp == "" {
			continue
		}
		targets[ref] = slackAPIMessageTarget{ChannelID: currentChannel, Timestamp: timestamp}
	}
	return targets
}

func normalizeSlackReactionName(value string) string {
	value = strings.TrimSpace(value)
	value = strings.TrimPrefix(value, ":")
	value = strings.TrimSuffix(value, ":")
	return strings.TrimSpace(value)
}

func (t *slackAPITool) callSlackGET(ctx context.Context, baseURL string, method string, values url.Values, target any) slackFormAPIResult {
	baseURL = strings.TrimRight(strings.TrimSpace(baseURL), "/")
	if baseURL == "" {
		baseURL = defaultSlackAPIBaseURL
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, baseURL+"/"+method+"?"+values.Encode(), nil)
	if err != nil {
		return slackFormAPIResult{Error: "build_request_failed", Detail: err.Error()}
	}
	if token := strings.TrimSpace(t.token); token != "" {
		request.Header.Set("Authorization", "Bearer "+token)
	}
	client := &http.Client{Transport: t.httpTransport}
	if client.Transport == nil {
		client.Transport = http.DefaultTransport
	}
	response, err := client.Do(request)
	if err != nil {
		return slackFormAPIResult{Error: "request_failed", Detail: err.Error()}
	}
	defer response.Body.Close()
	if err := json.NewDecoder(response.Body).Decode(target); err != nil {
		return slackFormAPIResult{Status: response.StatusCode, Error: "decode_response_failed", Detail: err.Error()}
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return slackFormAPIResult{Status: response.StatusCode, Error: fmt.Sprintf("http_%d", response.StatusCode)}
	}
	return slackFormAPIResult{OK: true, Status: response.StatusCode}
}

func slackAPIJSONTextResult(value any) (slackAPIToolResult, error) {
	payload, err := json.Marshal(value)
	if err != nil {
		return slackAPIToolResult{}, err
	}
	return slackAPIToolResult{Success: true, Text: string(payload)}, nil
}

func cloneStringAnyMap(input map[string]any) map[string]any {
	out := make(map[string]any, len(input))
	for key, value := range input {
		out[key] = value
	}
	return out
}

func slackAPIParamString(value any) string {
	switch typed := value.(type) {
	case string:
		return strings.TrimSpace(typed)
	case json.Number:
		return strings.TrimSpace(typed.String())
	case bool:
		if typed {
			return "true"
		}
		return "false"
	case int:
		return strconv.Itoa(typed)
	case int64:
		return strconv.FormatInt(typed, 10)
	case float64:
		return strconv.FormatFloat(typed, 'f', -1, 64)
	default:
		return ""
	}
}

func normalizeSlackFormAliases(values url.Values, action string) {
	if values.Get("channel") == "" && values.Get("channel_id") != "" {
		values.Set("channel", values.Get("channel_id"))
	}
	if values.Get("timestamp") == "" && values.Get("ts") != "" {
		values.Set("timestamp", values.Get("ts"))
	}
	if action == "add_bookmark" && values.Get("type") == "" {
		values.Set("type", "link")
	}
}

var slackAPIMethodByAction = map[string]string{
	"send_dm":               "slack.sendDM",
	"fetch_thread":          "conversations.replies",
	"fetch_channel_history": "conversations.history",
	"fetch_image":           "slack.fetchImage",
	"fetch_file":            "slack.fetchFile",
	"fetch_canvas":          "slack.fetchCanvas",
	"upload_file":           "slack.uploadFile",
	"post_message":          "chat.postMessage",
	"post_thread_reply":     "slack.postThreadReply",
	"delete_message":        "chat.delete",
	"edit_message":          "chat.update",
	"add_reaction":          "reactions.add",
	"list_emoji":            "emoji.list",
	"pin":                   "pins.add",
	"unpin":                 "pins.remove",
	"set_topic":             "conversations.setTopic",
	"set_purpose":           "conversations.setPurpose",
	"add_bookmark":          "bookmarks.add",
	"invite":                "conversations.invite",
	"create_canvas":         "canvases.create",
	"edit_canvas":           "canvases.edit",
}

var slackAPIActions = []string{
	"send_dm", "fetch_thread", "fetch_channel_history", "fetch_image", "fetch_file", "fetch_canvas",
	"upload_file", "post_message", "post_thread_reply", "delete_message", "edit_message",
	"add_reaction", "list_emoji", "pin", "unpin", "set_topic", "set_purpose",
	"add_bookmark", "invite", "create_canvas", "edit_canvas",
}

var slackAPIActionsByMethod = func() map[string]string {
	byMethod := make(map[string]string, len(slackAPIMethodByAction))
	for action, method := range slackAPIMethodByAction {
		byMethod[method] = action
	}
	return byMethod
}()

func slackAPIMethodMatrix() []SlackAPIMethodSpec {
	statusByAction := map[string]string{
		"fetch_thread":          "active",
		"fetch_channel_history": "active",
		"upload_file":           "active",
		"post_message":          "active",
		"post_thread_reply":     "active",
		"delete_message":        "active",
		"edit_message":          "active",
		"add_reaction":          "active",
		"list_emoji":            "active",
		"pin":                   "active",
		"unpin":                 "active",
		"set_topic":             "active",
		"set_purpose":           "active",
		"add_bookmark":          "active",
		"invite":                "active",
		"fetch_image":           "active",
		"fetch_file":            "active",
		"fetch_canvas":          "active",
		"create_canvas":         "active",
		"edit_canvas":           "active",
		"send_dm":               "registered_unavailable",
	}
	roleByAction := map[string]string{
		"send_dm":           "planner",
		"post_thread_reply": "planner",
		"post_message":      "assistant/scheduled",
	}
	methods := make([]SlackAPIMethodSpec, 0, len(slackAPIActions))
	for _, action := range slackAPIActions {
		method := slackAPIMethodByAction[action]
		methods = append(methods, SlackAPIMethodSpec{
			Method: method,
			Action: action,
			Status: firstNonEmpty(statusByAction[action], "registered_unavailable"),
			Role:   roleByAction[action],
			Source: "cueboard slack_api_tool.go",
		})
	}
	return methods
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

func slackPostThreadReplyRetrySnippet(params map[string]any) string {
	channel := strings.TrimSpace(stringFromAny(params["channel"]))
	threadTS := strings.TrimSpace(stringFromAny(params["thread_ts"]))
	if channel == "" {
		channel = "<channel-id>"
	}
	if threadTS != "" {
		return `slack_api(method="slack.postThreadReply", params={"channel": "` + channel + `", "thread_ts": "` + threadTS + `", "text": "<your message>"})`
	}
	return `slack_api(method="slack.postThreadReply", params={"channel": "` + channel + `", "text": "<your message>"})`
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

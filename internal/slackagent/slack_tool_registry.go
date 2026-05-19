package slackagent

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/AFK-surf/oneesama/internal/httputil"
)

const slackToolParitySchema = "oneesama.slack-tools-parity.v1"

type SlackToolSpec struct {
	Name         string `json:"name"`
	Source       string `json:"source"`
	Category     string `json:"category"`
	Registration string `json:"registration"`
	Adapter      string `json:"adapter"`
	Status       string `json:"status"`
	ProductScope string `json:"product_scope,omitempty"`
}

type SlackAPIMethodSpec struct {
	Method string `json:"method"`
	Action string `json:"action"`
	Status string `json:"status"`
	Role   string `json:"role,omitempty"`
	Source string `json:"source"`
}

type SlackToolParityReport struct {
	OK                                   bool                 `json:"ok"`
	Schema                               string               `json:"schema"`
	GeneratedAt                          string               `json:"generated_at"`
	ActiveTools                          []string             `json:"active_tools"`
	ValidationOnlyTools                  []string             `json:"validation_only_tools"`
	RegisteredUnavailableTools           []string             `json:"registered_unavailable_tools"`
	PendingTools                         []string             `json:"pending_tools"`
	ExcludedTools                        []string             `json:"excluded_tools"`
	ValidationOnlySlackAPIMethods        []string             `json:"validation_only_slack_api_methods"`
	RegisteredUnavailableSlackAPIMethods []string             `json:"registered_unavailable_slack_api_methods"`
	Tools                                []SlackToolSpec      `json:"tools"`
	SlackAPIMethods                      []SlackAPIMethodSpec `json:"slack_api_methods"`
	Notes                                []string             `json:"notes"`
}

type SlackToolCallRequest struct {
	Tool string         `json:"tool"`
	Name string         `json:"name"`
	Role string         `json:"role"`
	Args map[string]any `json:"args"`
}

type SlackToolCallResponse struct {
	OK     bool   `json:"ok"`
	Schema string `json:"schema"`
	Tool   string `json:"tool"`
	Text   string `json:"text,omitempty"`
	Error  string `json:"error,omitempty"`
	Result any    `json:"result,omitempty"`
}

var slackToolSpecs = []SlackToolSpec{
	{Name: "slack_api", Source: "slack_api_tool*.go", Category: "proxy", Registration: "RegisterSlackProxyTools", Adapter: "native_slack_web_api", Status: "active"},
	{Name: "read_doc", Source: "slack_tools.go", Category: "helper", Registration: "RegisterSlackHelperTools", Adapter: "local_workspace_doc_reader", Status: "active"},
	{Name: "person_memory", Source: "people_memory_tool.go", Category: "helper", Registration: "RegisterSlackHelperTools", Adapter: "local_people_memory", Status: "active"},
	{Name: "followup_memory", Source: "heartbeat_followup.go", Category: "helper", Registration: "RegisterSlackHelperTools/RegisterHeartbeatTools", Adapter: "local_heartbeat_followup_store", Status: "active"},
	{Name: "suggest_action", Source: "suggest_tool.go", Category: "helper", Registration: "RegisterSlackHelperTools", Adapter: "local_pending_action_card", Status: "active"},
	{Name: "runtime_status", Source: "runtime_status_tool.go", Category: "assistant_only/heartbeat", Registration: "RegisterSlackHelperTools(RoleAssistant)/RegisterHeartbeatTools", Adapter: "local_runtime_status", Status: "active"},
	{Name: "heartbeat_log", Source: "heartbeat_log_tool.go", Category: "assistant_only", Registration: "RegisterSlackHelperTools(RoleAssistant)", Adapter: "local_status_log", Status: "active"},
	{Name: "memory_search", Source: "DefaultSystemPromptTemplate", Category: "memory", Registration: "framework_memory_tools", Adapter: "local_slack_memory", Status: "active"},
	{Name: "memory_get", Source: "DefaultSystemPromptTemplate", Category: "memory", Registration: "framework_memory_tools", Adapter: "local_slack_memory", Status: "active"},
	{Name: "memory_write", Source: "DefaultSystemPromptTemplate", Category: "memory", Registration: "framework_memory_tools", Adapter: "local_slack_memory", Status: "active"},
	{Name: "exa_search", Source: "framework web tools", Category: "web", Registration: "framework_web_tools", Adapter: "jina_search_compat", Status: "active"},
	{Name: "exa_contents", Source: "framework web tools", Category: "web", Registration: "framework_web_tools", Adapter: "jina_reader_compat", Status: "active"},
	{Name: "usage_api", Source: "usage_tool.go", Category: "helper", Registration: "RegisterSlackHelperTools", Adapter: "local_usage_status_stub", Status: "validation_only"},
	{Name: "manage_schedule", Source: "assistant_schedule_tool.go", Category: "assistant_schedule", Registration: "assistant prompt/defaults", Adapter: "assistant_thread_schedule_list", Status: "active"},
	{Name: "notify_meeting_slack", Source: "meeting_slack_notify_tool.go", Category: "copilot", Registration: "RegisterCopilotHelperTools", Adapter: "slack_post_message", Status: "active"},
	{Name: "send_meeting_chat", Source: "copilot_tools.go", Category: "copilot", Registration: "RegisterCopilotHelperTools", Adapter: "meeting_agent_chat", Status: "product_excluded", ProductScope: "Peng excluded meeting chat sending for task #147"},
	{Name: "image_generation", Source: "image_generation_tool.go", Category: "assistant_only", Registration: "RegisterSlackHelperTools(RoleAssistant)", Adapter: "image_provider", Status: "product_excluded", ProductScope: "Peng excluded image generation for task #147"},
	{Name: "audio_generation", Source: "audio_generation_tool.go", Category: "assistant_only", Registration: "RegisterSlackHelperTools(RoleAssistant)", Adapter: "audio_provider", Status: "product_excluded", ProductScope: "Peng excluded audio generation for task #147"},
	{Name: "linear_api", Source: "linear_tools.go", Category: "credentialed_proxy", Registration: "RegisterCredentialedProxyTools", Adapter: "external_linear_provider", Status: "product_excluded", ProductScope: "Peng excluded credentialed external app integrations for task #147"},
	{Name: "notion_api", Source: "notion_tool.go", Category: "credentialed_proxy", Registration: "RegisterCredentialedProxyTools", Adapter: "external_notion_provider", Status: "product_excluded", ProductScope: "Peng excluded credentialed external app integrations for task #147"},
	{Name: "google_calendar_api", Source: "gcal_tools.go", Category: "credentialed_proxy", Registration: "RegisterCredentialedProxyTools", Adapter: "external_gcal_provider", Status: "product_excluded", ProductScope: "Peng excluded credentialed external app integrations for task #147"},
	{Name: "figma_api", Source: "figma_tools.go", Category: "credentialed_proxy", Registration: "RegisterCredentialedProxyTools", Adapter: "external_figma_provider", Status: "product_excluded", ProductScope: "Peng excluded credentialed external app integrations for task #147"},
}

func (s *Service) SlackToolParityReport() SlackToolParityReport {
	report := SlackToolParityReport{
		OK:              true,
		Schema:          slackToolParitySchema,
		GeneratedAt:     nowRFC3339(),
		Tools:           append([]SlackToolSpec(nil), slackToolSpecs...),
		SlackAPIMethods: slackAPIMethodMatrix(),
		Notes: []string{
			"Cueboard credentialed third-party tools are listed for visibility but intentionally excluded by Peng's task #147 scope.",
			"exa_search/exa_contents preserve Cueboard tool names and use Jina-compatible public web readers when Exa credentials are not present.",
			"Loopback callers can use /slack/tools/call or /tools/call as the local tool gateway.",
		},
	}
	for _, spec := range report.Tools {
		switch spec.Status {
		case "active":
			report.ActiveTools = append(report.ActiveTools, spec.Name)
		case "validation_only":
			report.ValidationOnlyTools = append(report.ValidationOnlyTools, spec.Name)
			report.PendingTools = append(report.PendingTools, spec.Name)
		case "registered_unavailable":
			report.RegisteredUnavailableTools = append(report.RegisteredUnavailableTools, spec.Name)
			report.PendingTools = append(report.PendingTools, spec.Name)
		case "product_excluded":
			report.ExcludedTools = append(report.ExcludedTools, spec.Name)
		default:
			report.PendingTools = append(report.PendingTools, spec.Name)
		}
	}
	for _, method := range report.SlackAPIMethods {
		switch method.Status {
		case "validation_only":
			report.ValidationOnlySlackAPIMethods = append(report.ValidationOnlySlackAPIMethods, method.Method)
		case "registered_unavailable":
			report.RegisteredUnavailableSlackAPIMethods = append(report.RegisteredUnavailableSlackAPIMethods, method.Method)
		}
	}
	sort.Strings(report.ActiveTools)
	sort.Strings(report.ValidationOnlyTools)
	sort.Strings(report.RegisteredUnavailableTools)
	sort.Strings(report.ExcludedTools)
	sort.Strings(report.PendingTools)
	sort.Strings(report.ValidationOnlySlackAPIMethods)
	sort.Strings(report.RegisteredUnavailableSlackAPIMethods)
	return report
}

func (s *Service) ExecuteSlackTool(ctx context.Context, request SlackToolCallRequest) (SlackToolCallResponse, error) {
	name := firstNonEmpty(request.Tool, request.Name)
	name = strings.TrimSpace(name)
	args := request.Args
	if args == nil {
		args = make(map[string]any)
	}
	if name == "" {
		return slackToolError(name, "tool_required"), nil
	}
	if spec, ok := slackToolSpecByName(name); ok && spec.Status == "product_excluded" {
		return slackToolError(name, "product_excluded"), nil
	}

	switch name {
	case "slack_api":
		return s.executeSlackAPITool(ctx, request.Role, args)
	case "read_doc":
		return s.executeReadDocTool(args), nil
	case "memory_search":
		return slackToolOK(name, s.SearchLocalMemory(firstNonEmpty(stringFromAny(args["query"]), stringFromAny(args["q"])), intFromAny(args["limit"]))), nil
	case "memory_get":
		return s.executeMemoryGetTool(args), nil
	case "memory_write":
		return s.executeMemoryWriteTool(args), nil
	case "person_memory":
		result, err := (&personMemoryTool{workspaceDir: s.workspaceDir}).Execute(ctx, args)
		return slackToolFromTextResult(name, result, err)
	case "followup_memory":
		return s.executeFollowupMemoryTool(ctx, args)
	case "suggest_action":
		return s.executeSuggestActionTool(ctx, request.Role, args), nil
	case "runtime_status":
		return slackToolOK(name, s.executeRuntimeStatusTool(ctx)), nil
	case "heartbeat_log":
		limit := intFromAny(args["limit"])
		includeRaw := boolFromAny(args["include_raw"], true)
		return slackToolOK(name, s.executeHeartbeatLogTool(ctx, limit, includeRaw)), nil
	case "exa_contents":
		return executeExaContentsTool(ctx, args), nil
	case "exa_search":
		return executeExaSearchTool(ctx, args), nil
	case "usage_api":
		return slackToolOK(name, map[string]any{"status": "local_usage_backend_not_configured"}), nil
	case "manage_schedule":
		result := ExecuteAssistantScheduleTool(ctx, ExecuteAssistantScheduleToolArgs{
			Action:    firstNonEmpty(stringFromAny(args["action"]), "list"),
			ChannelID: firstNonEmpty(stringFromAny(args["channel_id"]), stringFromAny(args["channel"])),
			ThreadTS:  firstNonEmpty(stringFromAny(args["thread_ts"]), stringFromAny(args["threadTs"])),
		}, ExecuteAssistantScheduleToolOptions{ScheduleManager: s.scheduleManager})
		return slackToolOK(name, result), nil
	case "notify_meeting_slack":
		return s.executeNotifyMeetingSlackTool(ctx, args), nil
	default:
		return slackToolError(name, "tool_not_available"), nil
	}
}

func slackToolSpecByName(name string) (SlackToolSpec, bool) {
	for _, spec := range slackToolSpecs {
		if spec.Name == name {
			return spec, true
		}
	}
	return SlackToolSpec{}, false
}

func slackToolOK(tool string, result any) SlackToolCallResponse {
	return SlackToolCallResponse{OK: true, Schema: "oneesama.slack-tool-result.v1", Tool: tool, Result: result}
}

func slackToolError(tool, err string) SlackToolCallResponse {
	return SlackToolCallResponse{OK: false, Schema: "oneesama.slack-tool-result.v1", Tool: tool, Error: err}
}

// isActiveMentionThread is the live activeThread callback wired into
// slackAPITool. When the bot is currently handling a mention on this thread
// (claim recorded via slack_thread_cases by beginMentionThreadCase), the tool
// refuses chat.postMessage to the same thread to prevent duplicate replies —
// the worker output is delivered through the assistant pipeline already.
func (s *Service) isActiveMentionThread(channelID, threadTS string) bool {
	if s == nil || s.threadCases == nil {
		return false
	}
	return s.threadCases.IsActive(context.Background(), channelID, threadTS)
}

func slackToolFromTextResult(tool string, result slackAPIToolResult, err error) (SlackToolCallResponse, error) {
	if err != nil {
		return SlackToolCallResponse{}, err
	}
	if !result.Success {
		return SlackToolCallResponse{OK: false, Schema: "oneesama.slack-tool-result.v1", Tool: tool, Text: result.Text, Error: "tool_failed"}, nil
	}
	var parsed any
	if err := json.Unmarshal([]byte(result.Text), &parsed); err == nil {
		return SlackToolCallResponse{OK: true, Schema: "oneesama.slack-tool-result.v1", Tool: tool, Text: result.Text, Result: parsed}, nil
	}
	return SlackToolCallResponse{OK: true, Schema: "oneesama.slack-tool-result.v1", Tool: tool, Text: result.Text, Result: map[string]any{"text": result.Text}}, nil
}

func (s *Service) executeSlackAPITool(ctx context.Context, role string, args map[string]any) (SlackToolCallResponse, error) {
	if strings.TrimSpace(role) == "" {
		role = slackAPIRoleAssistant
	}
	tool := &slackAPITool{
		role:         role,
		apiURL:       defaultSlackAPIBaseURL,
		token:        s.botToken,
		workspaceDir: s.workspaceDir,
		activeThread: s.isActiveMentionThread,
	}
	params, _ := args["params"].(map[string]any)
	if params == nil {
		params = map[string]any{}
	}
	tool.messageTargets, tool.latestTargetByChannel = slackAPIMessageTargetsFromArgs(args, params)
	result, err := tool.Execute(ctx, args)
	return slackToolFromTextResult("slack_api", result, err)
}

func (s *Service) executeReadDocTool(args map[string]any) SlackToolCallResponse {
	relPath := strings.TrimSpace(firstNonEmpty(stringFromAny(args["path"]), stringFromAny(args["file"])))
	if relPath == "" {
		return slackToolError("read_doc", "path_required")
	}
	if !isAllowedToolDocPath(relPath) {
		return slackToolError("read_doc", "path_not_allowed")
	}
	raw, root, err := readToolDocFromAllowedRoots(s.workspaceDir, relPath)
	if err != nil {
		return slackToolError("read_doc", "file_not_found")
	}
	return slackToolOK("read_doc", map[string]any{"path": filepath.ToSlash(relPath), "root": root, "content": truncateSlackContextText(string(raw), 8000)})
}

func (s *Service) executeMemoryGetTool(args map[string]any) SlackToolCallResponse {
	relPath := strings.TrimSpace(firstNonEmpty(stringFromAny(args["path"]), stringFromAny(args["key"])))
	if relPath == "" {
		return slackToolOK("memory_get", s.MemorySummary())
	}
	if !isAllowedMemoryPath(relPath) {
		return slackToolError("memory_get", "path_not_allowed")
	}
	root := s.memoryWriteRoot()
	if strings.TrimSpace(root) == "" {
		return slackToolError("memory_get", "memory_disabled")
	}
	raw, err := os.ReadFile(filepath.Join(root, filepath.FromSlash(filepath.ToSlash(relPath))))
	if err != nil {
		return slackToolError("memory_get", "file_not_found")
	}
	return slackToolOK("memory_get", map[string]any{"path": filepath.ToSlash(relPath), "content": string(raw)})
}

func (s *Service) executeMemoryWriteTool(args map[string]any) SlackToolCallResponse {
	relPath := strings.TrimSpace(firstNonEmpty(stringFromAny(args["path"]), stringFromAny(args["key"])))
	content := stringFromAny(args["content"])
	if content == "" {
		content = stringFromAny(args["value"])
	}
	if relPath == "" || content == "" {
		return slackToolError("memory_write", "path_and_content_required")
	}
	if !isAllowedMemoryPath(relPath) {
		return slackToolError("memory_write", "path_not_allowed")
	}
	root := s.memoryWriteRoot()
	if strings.TrimSpace(root) == "" {
		return slackToolError("memory_write", "memory_disabled")
	}
	path := filepath.Join(root, filepath.FromSlash(filepath.ToSlash(relPath)))
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return slackToolError("memory_write", "mkdir_failed")
	}
	mode := strings.ToLower(strings.TrimSpace(stringFromAny(args["mode"])))
	if mode == "" {
		mode = "write"
	}
	var err error
	switch mode {
	case "write":
		err = os.WriteFile(path, []byte(content), 0o644)
	case "append":
		err = appendMemoryWriteFile(path, content)
	default:
		return slackToolError("memory_write", "invalid_mode")
	}
	if err != nil {
		return slackToolError("memory_write", "write_failed")
	}
	return slackToolOK("memory_write", map[string]any{"path": filepath.ToSlash(relPath), "bytes": len([]byte(content)), "mode": mode})
}

func (s *Service) memoryWriteRoot() string {
	if s == nil {
		return ""
	}
	if strings.TrimSpace(s.workspaceDir) != "" {
		return s.workspaceDir
	}
	if s.localMemory != nil {
		return s.localMemory.workspaceDir
	}
	return ""
}

func appendMemoryWriteFile(path string, content string) error {
	existing, err := os.ReadFile(path)
	if err != nil && !os.IsNotExist(err) {
		return err
	}
	var b strings.Builder
	if len(existing) > 0 {
		b.Write(existing)
		if !strings.HasSuffix(string(existing), "\n") {
			b.WriteString("\n")
		}
	}
	b.WriteString(content)
	if !strings.HasSuffix(content, "\n") {
		b.WriteString("\n")
	}
	return os.WriteFile(path, []byte(b.String()), 0o644)
}

func (s *Service) executeFollowupMemoryTool(ctx context.Context, args map[string]any) (SlackToolCallResponse, error) {
	action := strings.ToLower(firstNonEmpty(stringFromAny(args["action"]), "list"))
	switch action {
	case "list", "search", "status":
		status, err := s.SlackFollowupStatus(ctx, stringFromAny(args["status"]), intFromAny(args["limit"]))
		if err != nil {
			return SlackToolCallResponse{}, err
		}
		return slackToolOK("followup_memory", status), nil
	case "record", "create":
		result, err := s.CreateSlackFollowupSurface(ctx, SlackFollowupCreateRequest{
			ChannelID: firstNonEmpty(stringFromAny(args["channel_id"]), stringFromAny(args["channel"])),
			ThreadTS:  firstNonEmpty(stringFromAny(args["thread_ts"]), stringFromAny(args["threadTs"])),
			Kind:      firstNonEmpty(stringFromAny(args["kind"]), "followup"),
			Title:     firstNonEmpty(stringFromAny(args["title"]), stringFromAny(args["summary"])),
			Summary:   firstNonEmpty(stringFromAny(args["summary"]), stringFromAny(args["title"])),
			Priority:  firstNonEmpty(stringFromAny(args["priority"]), "normal"),
		})
		if err != nil {
			return SlackToolCallResponse{}, err
		}
		return slackToolOK("followup_memory", result), nil
	case "resolve":
		if s.followups == nil {
			return slackToolError("followup_memory", "followup_store_disabled"), nil
		}
		record, err := s.followups.ResolveFollowup(ctx, int64(intFromAny(args["followup_id"])), "done", stringFromAny(args["resolution"]))
		if err != nil {
			return SlackToolCallResponse{}, err
		}
		return slackToolOK("followup_memory", record), nil
	default:
		return slackToolError("followup_memory", "unsupported_action"), nil
	}
}

func (s *Service) executeSuggestActionTool(ctx context.Context, role string, args map[string]any) SlackToolCallResponse {
	tool := &slackSuggestActionTool{role: role, fetchThreadTranscript: s.fetchThreadTranscriptForSuggestAction}
	request, validation := tool.normalizeRequest(ctx, args)
	if validation != nil {
		return SlackToolCallResponse{OK: validation.Success, Schema: "oneesama.slack-tool-result.v1", Tool: "suggest_action", Text: validation.Text, Error: "validation_failed"}
	}
	result, err := s.createSuggestedPendingAction(ctx, request, args)
	if err != nil {
		return SlackToolCallResponse{OK: false, Schema: "oneesama.slack-tool-result.v1", Tool: "suggest_action", Error: err.Error()}
	}
	if !result.Post.OK {
		return SlackToolCallResponse{OK: false, Schema: "oneesama.slack-tool-result.v1", Tool: "suggest_action", Error: "post_failed", Result: result}
	}
	return slackToolOK("suggest_action", result)
}

type slackSuggestActionResult struct {
	Request        *slackSuggestActionRequest `json:"request"`
	PendingAction  SlackPendingAction         `json:"pending_action"`
	Post           PostMessageResult          `json:"post"`
	Recommendation *SlackThreadRecommendation `json:"recommendation,omitempty"`
	Followup       *SlackHeartbeatFollowup    `json:"followup,omitempty"`
}

func (s *Service) createSuggestedPendingAction(ctx context.Context, request *slackSuggestActionRequest, args map[string]any) (*slackSuggestActionResult, error) {
	if request == nil {
		return nil, fmt.Errorf("request_required")
	}
	params := cloneStringAnyMap(request.Params)
	params["source"] = "suggest_action"
	params["title"] = request.Title
	params["summary"] = request.Summary
	record, err := s.triage.InsertPendingAction(ctx, SlackPendingAction{
		ChannelID:  request.Channel,
		ThreadTS:   request.ThreadTS,
		ActionType: request.ActionType,
		Params:     params,
	})
	if err != nil {
		return nil, fmt.Errorf("insert pending action: %w", err)
	}
	if record == nil {
		return nil, fmt.Errorf("pending action store disabled")
	}
	if err := s.cognition.RecordAction(ctx, "workspace", request.Channel, request.ThreadTS, request.ActionType, "pending"); err != nil {
		s.logger.Warn("slack suggest_action ledger action record failed", "error", err)
	}
	action := SlackTriageDecisionAction{
		Type:                 request.ActionType,
		Title:                request.Title,
		Message:              firstNonEmpty(request.Summary, request.Title),
		ChannelID:            request.Channel,
		ThreadTS:             request.ThreadTS,
		Confidence:           clampFloat(numberFromAny(args["confidence"], 1), 0, 1, 1),
		Reason:               stringFromAny(args["reason"]),
		RequiresConfirmation: true,
	}
	post := s.PostMessage(ctx, PostMessageInput{
		Channel:  request.Channel,
		ThreadTS: request.ThreadTS,
		Text:     buildSlackTriageActionText(action, *record),
		Blocks:   buildSlackTriageActionBlocks(action, *record),
		DedupKey: fmt.Sprintf("slack-suggest-action:%s:%s:%s:%d", request.Channel, request.ThreadTS, request.ActionType, record.ID),
	})
	if post.OK {
		cardTS := firstNonEmpty(post.TS, post.ThreadTS)
		if err := s.triage.SetPendingActionCardTS(ctx, record.ID, cardTS); err != nil {
			s.logger.Warn("slack suggest_action card ts update failed", "pending_action_id", record.ID, "error", err)
		} else {
			record.CardTS = cardTS
		}
		recommendation, followup, err := s.createPendingActionSideEffects(ctx, *record, cardTS)
		if err != nil {
			return nil, err
		}
		if err := s.cognition.RecordOutbound(ctx, "workspace", request.Channel, request.ThreadTS, fmt.Sprintf("Suggested %s: %s", request.ActionType, request.Title)); err != nil {
			s.logger.Warn("slack suggest_action outbound record failed", "error", err)
		}
		return &slackSuggestActionResult{Request: request, PendingAction: *record, Post: post, Recommendation: recommendation, Followup: followup}, nil
	}
	return &slackSuggestActionResult{Request: request, PendingAction: *record, Post: post}, nil
}

func (s *Service) fetchThreadTranscriptForSuggestAction(ctx context.Context, channel, threadTS string) (string, error) {
	response, err := s.callSlackConversationsReplies(ctx, channel, threadTS)
	if err != nil {
		return "", err
	}
	if !response.OK {
		return "", fmt.Errorf("%s", firstNonEmpty(response.Error, "slack_api_error"))
	}
	var lines []string
	for _, message := range response.Messages {
		lines = append(lines, fmt.Sprintf("[ts:%s] %s: %s", firstNonEmpty(message.TS, message.Timestamp, message.EventTS), firstNonEmpty(message.UserID, message.User), message.Text))
	}
	return strings.Join(lines, "\n"), nil
}

func executeExaContentsTool(ctx context.Context, args map[string]any) SlackToolCallResponse {
	rawURL := firstNonEmpty(stringFromAny(args["url"]), stringFromAny(args["id"]))
	if rawURL == "" {
		return slackToolError("exa_contents", "url_required")
	}
	context := fetchSlackExternalLinkContext(ctx, rawURL)
	if context.Error != "" {
		return SlackToolCallResponse{OK: false, Schema: "oneesama.slack-tool-result.v1", Tool: "exa_contents", Error: context.Error, Result: context}
	}
	return slackToolOK("exa_contents", context)
}

func executeExaSearchTool(ctx context.Context, args map[string]any) SlackToolCallResponse {
	query := firstNonEmpty(stringFromAny(args["query"]), stringFromAny(args["q"]))
	if query == "" {
		return slackToolError("exa_search", "query_required")
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, slackExternalSearchURL(query), nil)
	if err != nil {
		return slackToolError("exa_search", "build_request_failed")
	}
	request.Header.Set("User-Agent", "oneesama-slack-tools/1.0")
	client := slackExternalSearchHTTPClient
	if client == nil {
		client = httputil.NewHTTPClient(8 * time.Second)
	}
	response, err := client.Do(request)
	if err != nil {
		return SlackToolCallResponse{OK: false, Schema: "oneesama.slack-tool-result.v1", Tool: "exa_search", Error: err.Error()}
	}
	defer response.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(response.Body, slackExternalLinkFetchBodyLimit))
	if err != nil {
		return SlackToolCallResponse{OK: false, Schema: "oneesama.slack-tool-result.v1", Tool: "exa_search", Error: err.Error()}
	}
	text := truncateSlackContextText(normalizeExternalLinkText(string(raw)), 3000)
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return SlackToolCallResponse{OK: false, Schema: "oneesama.slack-tool-result.v1", Tool: "exa_search", Error: fmt.Sprintf("search returned HTTP %d", response.StatusCode), Result: map[string]any{"query": query, "excerpt": text, "source": "jina_search"}}
	}
	return slackToolOK("exa_search", map[string]any{"query": query, "source": "jina_search", "excerpt": text})
}

func isAllowedToolDocPath(relPath string) bool {
	rel := filepath.ToSlash(strings.TrimSpace(relPath))
	return rel == "README.md" || strings.HasPrefix(rel, "docs/") && strings.HasSuffix(rel, ".md")
}

func readToolDocFromAllowedRoots(workspaceDir string, relPath string) ([]byte, string, error) {
	rel := filepath.FromSlash(filepath.ToSlash(strings.TrimSpace(relPath)))
	roots := []string{strings.TrimSpace(workspaceDir)}
	if cwd, err := os.Getwd(); err == nil {
		roots = append(roots, cwd)
	}
	seen := make(map[string]struct{})
	var lastErr error
	for _, root := range roots {
		if strings.TrimSpace(root) == "" {
			continue
		}
		absRoot, err := filepath.Abs(root)
		if err != nil {
			lastErr = err
			continue
		}
		if _, ok := seen[absRoot]; ok {
			continue
		}
		seen[absRoot] = struct{}{}
		raw, err := os.ReadFile(filepath.Join(absRoot, rel))
		if err == nil {
			return raw, absRoot, nil
		}
		lastErr = err
	}
	if lastErr == nil {
		lastErr = os.ErrNotExist
	}
	return nil, "", lastErr
}

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
	OK              bool                 `json:"ok"`
	Schema          string               `json:"schema"`
	GeneratedAt     string               `json:"generated_at"`
	ActiveTools     []string             `json:"active_tools"`
	PendingTools    []string             `json:"pending_tools"`
	ExcludedTools   []string             `json:"excluded_tools"`
	Tools           []SlackToolSpec      `json:"tools"`
	SlackAPIMethods []SlackAPIMethodSpec `json:"slack_api_methods"`
	Notes           []string             `json:"notes"`
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
	{Name: "usage_api", Source: "usage_tool.go", Category: "helper", Registration: "RegisterSlackHelperTools", Adapter: "local_usage_status_stub", Status: "active_stub"},
	{Name: "manage_schedule", Source: "assistant_schedule_tool.go", Category: "assistant_schedule", Registration: "assistant prompt/defaults", Adapter: "assistant_thread_schedule_list", Status: "active"},
	{Name: "notify_meeting_slack", Source: "meeting_slack_notify_tool.go", Category: "copilot", Registration: "RegisterCopilotHelperTools", Adapter: "slack_post_message", Status: "active"},
	{Name: "send_meeting_chat", Source: "copilot_tools.go", Category: "copilot", Registration: "RegisterCopilotHelperTools", Adapter: "meeting_agent_chat", Status: "pending_provider"},
	{Name: "image_generation", Source: "image_generation_tool.go", Category: "assistant_only", Registration: "RegisterSlackHelperTools(RoleAssistant)", Adapter: "image_provider", Status: "pending_product_decision"},
	{Name: "audio_generation", Source: "audio_generation_tool.go", Category: "assistant_only", Registration: "RegisterSlackHelperTools(RoleAssistant)", Adapter: "audio_provider", Status: "pending_product_decision"},
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
		case "active", "active_stub":
			report.ActiveTools = append(report.ActiveTools, spec.Name)
		case "product_excluded":
			report.ExcludedTools = append(report.ExcludedTools, spec.Name)
		default:
			report.PendingTools = append(report.PendingTools, spec.Name)
		}
	}
	sort.Strings(report.ActiveTools)
	sort.Strings(report.ExcludedTools)
	sort.Strings(report.PendingTools)
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
		return slackToolOK(name, s.Status()), nil
	case "heartbeat_log":
		limit := intFromAny(args["limit"])
		path, lines, err := loadHeartbeatLogTail(limit)
		result := map[string]any{"path": path, "lines": lines}
		if err != nil {
			result["error"] = err.Error()
		}
		return slackToolOK(name, result), nil
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
		result := s.poster.PostMessage(ctx, PostMessageInput{
			Channel:  firstNonEmpty(stringFromAny(args["channel"]), stringFromAny(args["channel_id"])),
			ThreadTS: firstNonEmpty(stringFromAny(args["thread_ts"]), stringFromAny(args["threadTs"])),
			Text:     firstNonEmpty(stringFromAny(args["text"]), stringFromAny(args["message"])),
		})
		return slackToolOK(name, result), nil
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
		role:   role,
		apiURL: defaultSlackAPIBaseURL,
		token:  s.botToken,
	}
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
	raw, err := os.ReadFile(filepath.Join(s.localMemory.workspaceDir, filepath.FromSlash(filepath.ToSlash(relPath))))
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
	path := filepath.Join(s.localMemory.workspaceDir, filepath.FromSlash(filepath.ToSlash(relPath)))
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return slackToolError("memory_write", "mkdir_failed")
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		return slackToolError("memory_write", "write_failed")
	}
	return slackToolOK("memory_write", map[string]any{"path": filepath.ToSlash(relPath), "bytes": len([]byte(content))})
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
	return slackToolOK("suggest_action", request)
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

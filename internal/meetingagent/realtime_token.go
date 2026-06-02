package meetingagent

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"time"

	"github.com/AFK-surf/oneesama/internal/meetrunner"
)

const defaultRealtimeSafetyIdentifier = "meeting-avatar-bot-local"
const realtimeClientSecretMaxAttempts = 3

func (s *Service) RealtimeConfig() map[string]any {
	currentUser := s.realtimeCurrentUser()
	tools := s.realtimeServerToolSchemas()
	options := RealtimeSessionOptions{
		BotName:     s.openai.BotName,
		CurrentUser: currentUser,
		Tools:       tools,
	}
	instructions := buildRealtimeInstructions(options, s.openai)
	session := buildRealtimeSessionConfig(options, s.openai)
	demoSurface := s.demoSurfaceStatus()
	return map[string]any{
		"ok":              true,
		"model":           s.openai.RealtimeModel,
		"reasoningEffort": s.openai.RealtimeReasoningEffort,
		"voice":           s.openai.RealtimeVoice,
		"turnDetection":   s.openai.RealtimeTurnDetection,
		"sessionSchema":   s.openai.RealtimeSessionSchema,
		"agentRuntime":    s.openai.RealtimeAgentRuntime,
		"instructions":    instructions,
		"tools":           tools,
		"session":         session,
		"currentUser":     currentUser,
		"tuning":          realtimeTuningGuide(),
		"demoSurface":     demoSurface,
		"contextBudget": realtimeHarnessContextBudget(instructions, tools, session, map[string]any{
			"currentUser": currentUser,
			"demoSurface": demoSurface,
		}),
	}
}

func (s *Service) RealtimeContextHealth(ctx context.Context) map[string]any {
	tools := s.realtimeServerToolSchemas()
	options := RealtimeSessionOptions{
		BotName:     s.openai.BotName,
		CurrentUser: s.realtimeCurrentUser(),
		Tools:       tools,
	}
	session := buildRealtimeSessionConfig(options, s.openai)
	instructions := buildRealtimeInstructions(options, s.openai)
	health := map[string]any{
		"itemsCount":             0,
		"tokenEstimate":          0,
		"lastCompactAt":          "",
		"nextCompactThreshold":   80000,
		"source":                 "no_active_realtime_session",
		"sessionTruncation":      session["truncation"],
		"contextLifecyclePolicy": map[string]any{"recentItems": 20, "compactItemThreshold": 200},
		"contextBudget": realtimeHarnessContextBudget(instructions, tools, session, map[string]any{
			"currentUser": s.realtimeCurrentUser(),
			"demoSurface": s.demoSurfaceStatus(),
		}),
	}
	status, err := s.meetRunner.StatusSession(ctx, meetrunner.StatusSessionInput{})
	if err != nil {
		if strings.Contains(err.Error(), "no_active_join") {
			health["ok"] = true
			health["source"] = "no_active_realtime_session"
			health["reason"] = "no_active_join"
			return health
		}
		health["ok"] = false
		health["error"] = err.Error()
		return health
	}
	if contextHealth, ok := extractContextHealth(status.Active); ok {
		for key, value := range contextHealth {
			health[key] = value
		}
		health["source"] = "meet_runner_realtime_bridge"
	}
	health["ok"] = true
	return health
}

func extractContextHealth(value any) (map[string]any, bool) {
	root, ok := value.(map[string]any)
	if !ok {
		return nil, false
	}
	if direct, ok := root["contextHealth"].(map[string]any); ok {
		return direct, true
	}
	realtimeBridge, ok := root["realtimeBridge"].(map[string]any)
	if !ok {
		return nil, false
	}
	if contextHealth, ok := realtimeBridge["contextHealth"].(map[string]any); ok {
		return contextHealth, true
	}
	return nil, false
}

func realtimeTuningGuide() map[string]any {
	return map[string]any{
		"automatic": []string{
			"session/client-secret mint",
			"WebRTC data channel",
			"Meet participant audio forwarding",
			"remote audio route to avatar bus",
			"tool call routing",
			"error/reconnect signals",
		},
		"human": []string{
			"voice preference",
			"response timing",
			"interrupt timing",
			"VAD eagerness",
			"persona feel",
			"silence handling",
		},
		"presets": map[string]any{
			"steady": map[string]any{
				"turnDetection": map[string]any{
					"type":               "semantic_vad",
					"eagerness":          "low",
					"create_response":    true,
					"interrupt_response": true,
				},
				"note": "least interrupt-prone; lets the user take time before chunking.",
			},
			"balanced": map[string]any{
				"turnDetection": map[string]any{
					"type":               "semantic_vad",
					"eagerness":          "auto",
					"create_response":    true,
					"interrupt_response": true,
				},
				"note": "default human-loop starting point.",
			},
			"fast": map[string]any{
				"turnDetection": map[string]any{
					"type":               "semantic_vad",
					"eagerness":          "high",
					"create_response":    true,
					"interrupt_response": true,
				},
				"note": "faster responses; more likely to cut short pauses.",
			},
			"server_vad": map[string]any{
				"turnDetection": map[string]any{
					"type":                "server_vad",
					"threshold":           0.72,
					"prefix_padding_ms":   300,
					"silence_duration_ms": 500,
					"create_response":     true,
					"interrupt_response":  true,
				},
				"note": "silence-based baseline for noisy rooms.",
			},
		},
	}
}

func (s *Service) realtimeCurrentUser() RealtimeCurrentUser {
	return RealtimeCurrentUser{
		Name:        firstNonEmpty(s.openai.CurrentUserName, "Operator"),
		EnglishName: firstNonEmpty(s.openai.CurrentUserEnglishName, "Operator"),
		Email:       firstNonEmpty(s.openai.CurrentUserEmail, "operator@example.com"),
		Linear:      firstNonEmpty(s.openai.CurrentUserLinear, "operator"),
		GitHub:      firstNonEmpty(s.openai.CurrentUserGitHub, "operator"),
		Role:        firstNonEmpty(s.openai.CurrentUserRole, "meeting operator"),
		Aliases:     compactCurrentUserAliases(s.openai.CurrentUserAliases, s.openai.CurrentUserName, s.openai.CurrentUserEnglishName),
	}
}

func (s *Service) realtimeServerToolSchemas() []map[string]any {
	return realtimeToolSchemas(s.realtimeDemoSurfaceToolsExposed())
}

func (s *Service) realtimeDemoSurfaceToolsExposed() bool {
	return s != nil && s.demoBridge != nil && s.demoSurface.ExposeRealtimeTools
}

func (s *Service) withRealtimeServerToolSchemas(options RealtimeSessionOptions) RealtimeSessionOptions {
	serverTools := s.realtimeServerToolSchemas()
	if options.Tools == nil {
		options.Tools = serverTools
		return options
	}
	options.Tools = filterRealtimeToolSchemasByRequestedNames(serverTools, options.Tools)
	return options
}

func filterRealtimeToolSchemasByRequestedNames(serverTools []map[string]any, requestedTools []map[string]any) []map[string]any {
	requestedNames := map[string]bool{}
	for _, tool := range requestedTools {
		name := strings.TrimSpace(stringFromAny(tool["name"]))
		if name != "" {
			requestedNames[name] = true
		}
	}
	out := make([]map[string]any, 0, len(serverTools))
	for _, tool := range serverTools {
		name := strings.TrimSpace(stringFromAny(tool["name"]))
		if requestedNames[name] {
			out = append(out, tool)
		}
	}
	return out
}

func compactCurrentUserAliases(values []string, identityValues ...string) []string {
	out := make([]string, 0, len(values)+len(identityValues))
	seen := map[string]struct{}{}
	add := func(value string) {
		trimmed := strings.TrimSpace(value)
		if trimmed == "" || isRuntimeOnlyCurrentUserAlias(trimmed) {
			return
		}
		key := strings.ToLower(trimmed)
		if _, ok := seen[key]; ok {
			return
		}
		seen[key] = struct{}{}
		out = append(out, trimmed)
	}
	for _, value := range identityValues {
		add(value)
	}
	for _, value := range values {
		add(value)
	}
	return out
}

func isRuntimeOnlyCurrentUserAlias(value string) bool {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "老大":
		return true
	default:
		return false
	}
}

func (s *Service) MintRealtimeClientSecret(ctx context.Context, options RealtimeSessionOptions) (map[string]any, int, error) {
	options = s.withRealtimeServerToolSchemas(options)
	session := buildRealtimeSessionConfig(options, s.openai)
	upstream := map[string]any{
		"baseUrl":          s.openai.BaseURL,
		"clientSecretsUrl": s.openai.RealtimeClientSecretsURL,
	}
	if strings.TrimSpace(s.openai.APIKey) == "" {
		return map[string]any{
			"ok":       false,
			"error":    "MAB_OPENAI_API_KEY/OPENAI_API_KEY missing",
			"dryRun":   true,
			"session":  session,
			"upstream": upstream,
		}, http.StatusOK, nil
	}

	payload, err := json.Marshal(map[string]any{"session": session})
	if err != nil {
		return nil, http.StatusInternalServerError, fmt.Errorf("marshal realtime client secret request: %w", err)
	}
	for attempt := 1; attempt <= realtimeClientSecretMaxAttempts; attempt++ {
		request, err := http.NewRequestWithContext(ctx, http.MethodPost, s.openai.RealtimeClientSecretsURL, bytes.NewReader(payload))
		if err != nil {
			return nil, http.StatusInternalServerError, fmt.Errorf("build realtime client secret request: %w", err)
		}
		request.Header.Set("Authorization", "Bearer "+s.openai.APIKey)
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set("OpenAI-Safety-Identifier", firstNonEmpty(options.SafetyIdentifier, options.RequestedBy, defaultRealtimeSafetyIdentifier))

		response, err := s.httpClient.Do(request)
		if err != nil {
			if attempt < realtimeClientSecretMaxAttempts && isRetryableRealtimeClientSecretError(err) {
				if sleepErr := sleepRealtimeClientSecretRetry(ctx, attempt); sleepErr != nil {
					return nil, http.StatusBadGateway, fmt.Errorf("post realtime client secret: %w", err)
				}
				continue
			}
			return nil, http.StatusBadGateway, fmt.Errorf("post realtime client secret: %w", err)
		}

		parsed := readRealtimeJSON(response.Body)
		_ = response.Body.Close()
		if response.StatusCode < http.StatusOK || response.StatusCode >= http.StatusMultipleChoices {
			if attempt < realtimeClientSecretMaxAttempts && isRetryableRealtimeClientSecretStatus(response.StatusCode) {
				if sleepErr := sleepRealtimeClientSecretRetry(ctx, attempt); sleepErr != nil {
					return nil, http.StatusBadGateway, fmt.Errorf("retry realtime client secret after status %d: %w", response.StatusCode, sleepErr)
				}
				continue
			}
			if attempt > 1 {
				upstream["mintAttempts"] = attempt
			}
			return map[string]any{
				"ok":       false,
				"error":    "openai_realtime_upstream",
				"status":   response.StatusCode,
				"detail":   parsed,
				"upstream": upstream,
			}, http.StatusBadGateway, nil
		}

		result := map[string]any{
			"ok":       true,
			"upstream": upstream,
		}
		if attempt > 1 {
			result["mintAttempts"] = attempt
		}
		for key, value := range parsed {
			result[key] = value
		}
		return result, http.StatusOK, nil
	}
	return nil, http.StatusBadGateway, fmt.Errorf("post realtime client secret: exhausted retry attempts")
}

func isRetryableRealtimeClientSecretStatus(status int) bool {
	switch status {
	case http.StatusInternalServerError, http.StatusBadGateway, http.StatusServiceUnavailable, http.StatusGatewayTimeout:
		return true
	default:
		return false
	}
}

func isRetryableRealtimeClientSecretError(err error) bool {
	if errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) {
		return true
	}
	var netErr net.Error
	if errors.As(err, &netErr) && netErr.Timeout() {
		return true
	}
	text := strings.ToLower(err.Error())
	for _, needle := range []string{
		"connection reset",
		"connection refused",
		"server closed idle connection",
		"socket hang up",
		"timeout",
		"temporarily unavailable",
		"eof",
	} {
		if strings.Contains(text, needle) {
			return true
		}
	}
	return false
}

func sleepRealtimeClientSecretRetry(ctx context.Context, attempt int) error {
	delay := time.Duration(250*(1<<(attempt-1))) * time.Millisecond
	if delay > time.Second {
		delay = time.Second
	}
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

func readRealtimeJSON(reader io.Reader) map[string]any {
	body, err := io.ReadAll(io.LimitReader(reader, 1<<20))
	if err != nil {
		return map[string]any{
			"raw": "",
		}
	}
	var parsed map[string]any
	if err := json.Unmarshal(body, &parsed); err != nil {
		return map[string]any{"raw": string(body)}
	}
	return parsed
}

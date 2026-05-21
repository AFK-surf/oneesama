package meetingagent

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"

	"github.com/AFK-surf/oneesama/internal/meetrunner"
)

const defaultRealtimeSafetyIdentifier = "meeting-avatar-bot-local"

func (s *Service) RealtimeConfig() map[string]any {
	currentUser := s.realtimeCurrentUser()
	options := RealtimeSessionOptions{
		BotName:     s.openai.BotName,
		CurrentUser: currentUser,
	}
	return map[string]any{
		"ok":              true,
		"model":           s.openai.RealtimeModel,
		"reasoningEffort": s.openai.RealtimeReasoningEffort,
		"voice":           s.openai.RealtimeVoice,
		"turnDetection":   s.openai.RealtimeTurnDetection,
		"sessionSchema":   s.openai.RealtimeSessionSchema,
		"agentRuntime":    s.openai.RealtimeAgentRuntime,
		"instructions":    buildRealtimeInstructions(options, s.openai),
		"tools":           realtimeToolSchemas(s.demoBridge != nil),
		"session":         buildRealtimeSessionConfig(options, s.openai),
		"currentUser":     currentUser,
		"tuning":          realtimeTuningGuide(),
		"demoSurface":     s.demoSurfaceStatus(),
	}
}

func (s *Service) RealtimeContextHealth(ctx context.Context) map[string]any {
	options := RealtimeSessionOptions{
		BotName:     s.openai.BotName,
		CurrentUser: s.realtimeCurrentUser(),
	}
	session := buildRealtimeSessionConfig(options, s.openai)
	health := map[string]any{
		"itemsCount":             0,
		"tokenEstimate":          0,
		"lastCompactAt":          "",
		"nextCompactThreshold":   80000,
		"source":                 "no_active_realtime_session",
		"sessionTruncation":      session["truncation"],
		"contextLifecyclePolicy": map[string]any{"recentItems": 20, "compactItemThreshold": 200},
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
				"turnDetection": map[string]any{"type": "semantic_vad", "eagerness": "low"},
				"note":          "least interrupt-prone; lets the user take time before chunking.",
			},
			"balanced": map[string]any{
				"turnDetection": map[string]any{"type": "semantic_vad", "eagerness": "auto"},
				"note":          "default human-loop starting point.",
			},
			"fast": map[string]any{
				"turnDetection": map[string]any{"type": "semantic_vad", "eagerness": "high"},
				"note":          "faster responses; more likely to cut short pauses.",
			},
			"server_vad": map[string]any{
				"turnDetection": map[string]any{
					"type":                "server_vad",
					"threshold":           0.5,
					"prefix_padding_ms":   300,
					"silence_duration_ms": 500,
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

func compactCurrentUserAliases(values []string, identityValues ...string) []string {
	out := make([]string, 0, len(values)+len(identityValues))
	seen := map[string]struct{}{}
	add := func(value string) {
		trimmed := strings.TrimSpace(value)
		if trimmed == "" {
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

func (s *Service) MintRealtimeClientSecret(ctx context.Context, options RealtimeSessionOptions) (map[string]any, int, error) {
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
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, s.openai.RealtimeClientSecretsURL, bytes.NewReader(payload))
	if err != nil {
		return nil, http.StatusInternalServerError, fmt.Errorf("build realtime client secret request: %w", err)
	}
	request.Header.Set("Authorization", "Bearer "+s.openai.APIKey)
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("OpenAI-Safety-Identifier", firstNonEmpty(options.SafetyIdentifier, options.RequestedBy, defaultRealtimeSafetyIdentifier))

	response, err := s.httpClient.Do(request)
	if err != nil {
		return nil, http.StatusBadGateway, fmt.Errorf("post realtime client secret: %w", err)
	}
	defer response.Body.Close()

	parsed := readRealtimeJSON(response.Body)
	if response.StatusCode < http.StatusOK || response.StatusCode >= http.StatusMultipleChoices {
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
	for key, value := range parsed {
		result[key] = value
	}
	return result, http.StatusOK, nil
}

func readRealtimeJSON(reader io.Reader) map[string]any {
	body, err := io.ReadAll(io.LimitReader(reader, 1<<20))
	if err != nil {
		return map[string]any{"raw": ""}
	}
	var parsed map[string]any
	if err := json.Unmarshal(body, &parsed); err != nil {
		return map[string]any{"raw": string(body)}
	}
	return parsed
}

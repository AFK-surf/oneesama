package meetingagent

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
)

const defaultRealtimeSafetyIdentifier = "meeting-avatar-bot-local"

func (s *Service) RealtimeConfig() map[string]any {
	options := RealtimeSessionOptions{
		BotName:     s.openai.BotName,
		CurrentUser: s.realtimeCurrentUser(),
	}
	return map[string]any{
		"ok":              true,
		"model":           s.openai.RealtimeModel,
		"reasoningEffort": s.openai.RealtimeReasoningEffort,
		"voice":           s.openai.RealtimeVoice,
		"turnDetection":   s.openai.RealtimeTurnDetection,
		"sessionSchema":   s.openai.RealtimeSessionSchema,
		"instructions":    buildRealtimeInstructions(options, s.openai),
		"tools":           defaultRealtimeToolSchemas(),
		"session":         buildRealtimeSessionConfig(options, s.openai),
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
	}
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

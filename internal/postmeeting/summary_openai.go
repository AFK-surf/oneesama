package postmeeting

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
)

type OpenAIChatConfig struct {
	APIKey     string
	BaseURL    string
	HTTPClient *http.Client
}

func NewOpenAIChatClientFactory(config OpenAIChatConfig) SummaryLLMClientFactory {
	return func(model string) (SummaryLLMClient, error) {
		if firstNonEmpty(config.APIKey) == "" {
			return nil, fmt.Errorf("openai api key is not configured")
		}
		return &OpenAIChatClient{
			APIKey:     config.APIKey,
			BaseURL:    config.BaseURL,
			Model:      model,
			HTTPClient: config.HTTPClient,
		}, nil
	}
}

type OpenAIChatClient struct {
	APIKey     string
	BaseURL    string
	Model      string
	HTTPClient *http.Client
}

func (c *OpenAIChatClient) Chat(ctx context.Context, messages []SummaryLLMMessage) (SummaryLLMResponse, error) {
	payload := map[string]any{
		"model":    firstNonEmpty(c.Model),
		"messages": messages,
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return SummaryLLMResponse{}, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.endpoint(), bytes.NewReader(body))
	if err != nil {
		return SummaryLLMResponse{}, err
	}
	req.Header.Set("Authorization", "Bearer "+firstNonEmpty(c.APIKey))
	req.Header.Set("Content-Type", "application/json")
	resp, err := httpClient(c.HTTPClient).Do(req)
	if err != nil {
		return SummaryLLMResponse{}, fmt.Errorf("summary llm request: %w", err)
	}
	defer resp.Body.Close()
	respBody, err := readProviderResponseBody(resp.Body)
	if err != nil {
		return SummaryLLMResponse{}, fmt.Errorf("read summary llm response body: %w", err)
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return SummaryLLMResponse{}, fmt.Errorf("summary llm failed (%d): %s", resp.StatusCode, string(respBody))
	}
	content, err := parseOpenAIChatContent(respBody)
	if err != nil {
		return SummaryLLMResponse{}, err
	}
	return SummaryLLMResponse{Content: content}, nil
}

func (c *OpenAIChatClient) ChatStream(ctx context.Context, messages []SummaryLLMMessage, _ func(string)) (SummaryLLMResponse, error) {
	return c.Chat(ctx, messages)
}

func (c *OpenAIChatClient) endpoint() string {
	baseURL := strings.TrimRight(firstNonEmpty(c.BaseURL, "https://api.openai.com/v1"), "/")
	return baseURL + "/chat/completions"
}

func parseOpenAIChatContent(body []byte) (string, error) {
	var raw struct {
		Choices []struct {
			Message struct {
				Content any `json:"content"`
			} `json:"message"`
		} `json:"choices"`
	}
	if err := json.Unmarshal(body, &raw); err != nil {
		return "", fmt.Errorf("parse summary llm response: %w", err)
	}
	if len(raw.Choices) == 0 {
		return "", fmt.Errorf("summary llm response has no choices")
	}
	switch content := raw.Choices[0].Message.Content.(type) {
	case string:
		return strings.TrimSpace(content), nil
	case []any:
		var b strings.Builder
		for _, item := range content {
			part, ok := item.(map[string]any)
			if !ok {
				continue
			}
			if text, ok := part["text"].(string); ok {
				b.WriteString(text)
			}
		}
		if text := strings.TrimSpace(b.String()); text != "" {
			return text, nil
		}
	}
	return "", fmt.Errorf("summary llm response content is empty")
}

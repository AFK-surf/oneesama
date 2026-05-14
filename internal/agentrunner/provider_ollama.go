package agentrunner

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/AFK-surf/oneesama/internal/httputil"
	appconfig "github.com/AFK-surf/oneesama/pkg/config"
)

type ollamaProvider struct {
	baseURL string
	model   string
	dryRun  bool
	client  *http.Client
}

func newOllamaProvider(cfg appconfig.AgentRunnerConfig) runnerProvider {
	return &ollamaProvider{
		baseURL: strings.TrimRight(strings.TrimSpace(cfg.Ollama.BaseURL), "/"),
		model:   strings.TrimSpace(cfg.Ollama.Model),
		dryRun:  cfg.DryRun,
		client:  httputil.NewHTTPClient(30 * time.Second),
	}
}

func (p *ollamaProvider) Provider() string {
	return "ollama"
}

func (p *ollamaProvider) DryRun() bool {
	return p.dryRun
}

func (p *ollamaProvider) Run(ctx context.Context, input StartInput) (RunResult, error) {
	if p.dryRun {
		return RunResult{
			Status: StatusCompleted,
			Result: dryRunResult("ollama"),
		}, nil
	}
	if p.baseURL == "" || p.model == "" {
		return RunResult{}, fmt.Errorf("ollama base_url and model are required")
	}

	payload, err := json.Marshal(map[string]any{
		"model":  p.model,
		"prompt": buildPrompt(input),
		"stream": false,
	})
	if err != nil {
		return RunResult{}, fmt.Errorf("marshal ollama request: %w", err)
	}

	request, err := http.NewRequestWithContext(ctx, http.MethodPost, p.baseURL+"/api/generate", bytes.NewReader(payload))
	if err != nil {
		return RunResult{}, fmt.Errorf("build ollama request: %w", err)
	}
	request.Header.Set("Content-Type", "application/json")

	response, err := p.client.Do(request)
	if err != nil {
		return RunResult{}, fmt.Errorf("ollama request failed: %w", err)
	}
	defer response.Body.Close()

	body, err := io.ReadAll(io.LimitReader(response.Body, 1<<20))
	if err != nil {
		return RunResult{}, fmt.Errorf("read ollama response: %w", err)
	}

	var parsed struct {
		Response      string `json:"response"`
		Model         string `json:"model"`
		Done          bool   `json:"done"`
		TotalDuration int64  `json:"total_duration"`
	}
	_ = json.Unmarshal(body, &parsed)

	result := strings.TrimSpace(parsed.Response)
	if result == "" {
		result = strings.TrimSpace(string(body))
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return RunResult{
			Status: StatusFailed,
			Result: result,
			Error:  result,
			Debug:  strings.TrimSpace(string(body)),
		}, fmt.Errorf("ollama returned %s", response.Status)
	}

	return RunResult{
		Status: StatusCompleted,
		Result: result,
		Debug:  strings.TrimSpace(string(body)),
	}, nil
}

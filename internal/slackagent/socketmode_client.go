package slackagent

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/AFK-surf/oneesama/internal/httputil"
)

const defaultSlackSocketOpenURL = "https://slack.com/api/apps.connections.open"
const defaultSlackSocketOpenTimeout = 5 * time.Second

type SlackSocketModeClient struct {
	appToken string
	openURL  string
	client   *http.Client
}

func NewSlackSocketModeClient(appToken string) *SlackSocketModeClient {
	return &SlackSocketModeClient{
		appToken: strings.TrimSpace(appToken),
		openURL:  defaultSlackSocketOpenURL,
		client:   httputil.NewHTTPClient(defaultSlackSocketOpenTimeout),
	}
}

func (c *SlackSocketModeClient) OpenConnection(ctx context.Context) (string, error) {
	if c == nil || strings.TrimSpace(c.appToken) == "" {
		return "", fmt.Errorf("slack socket mode app token is required")
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.openURL, nil)
	if err != nil {
		return "", fmt.Errorf("build slack socket mode open request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+c.appToken)

	response, err := c.client.Do(req)
	if err != nil {
		return "", fmt.Errorf("open slack socket mode connection: %w", err)
	}
	defer func() { _ = response.Body.Close() }()

	body, err := io.ReadAll(io.LimitReader(response.Body, 1<<20))
	if err != nil {
		return "", fmt.Errorf("read slack socket mode response: %w", err)
	}

	var payload SlackSocketOpenResponse
	if err := json.Unmarshal(body, &payload); err != nil {
		return "", fmt.Errorf("decode slack socket mode response: %w", err)
	}
	if !payload.OK || strings.TrimSpace(payload.URL) == "" {
		return "", fmt.Errorf("slack socket mode open failed: %s", firstNonEmpty(payload.Error, response.Status))
	}
	return strings.TrimSpace(payload.URL), nil
}

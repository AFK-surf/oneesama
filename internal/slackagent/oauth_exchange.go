package slackagent

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/AFK-surf/oneesama/internal/httputil"
)

type slackOAuthHTTPExchanger struct {
	client    *http.Client
	accessURL string
}

func NewSlackOAuthExchanger(client *http.Client) OAuthExchanger {
	httpClient := client
	if httpClient == nil {
		httpClient = httputil.NewHTTPClient(10 * time.Second)
	}
	return &slackOAuthHTTPExchanger{
		client:    httpClient,
		accessURL: defaultSlackOAuthAccessURL,
	}
}

func (e *slackOAuthHTTPExchanger) ExchangeCode(ctx context.Context, input SlackOAuthExchangeInput) (SlackOAuthExchangeResult, error) {
	params := url.Values{
		"code":          {strings.TrimSpace(input.Code)},
		"client_id":     {strings.TrimSpace(input.ClientID)},
		"client_secret": {strings.TrimSpace(input.ClientSecret)},
	}
	if redirectURI := strings.TrimSpace(input.RedirectURI); redirectURI != "" {
		params.Set("redirect_uri", redirectURI)
	}

	request, err := http.NewRequestWithContext(
		ctx,
		http.MethodPost,
		e.accessURL,
		strings.NewReader(params.Encode()),
	)
	if err != nil {
		return SlackOAuthExchangeResult{}, fmt.Errorf("build slack oauth exchange request: %w", err)
	}
	request.Header.Set("Content-Type", "application/x-www-form-urlencoded")

	response, err := e.client.Do(request)
	if err != nil {
		return SlackOAuthExchangeResult{}, fmt.Errorf("run slack oauth exchange request: %w", err)
	}
	defer response.Body.Close()

	var body SlackOAuthResponseBody
	if err := json.NewDecoder(response.Body).Decode(&body); err != nil {
		return SlackOAuthExchangeResult{}, fmt.Errorf("decode slack oauth exchange response: %w", err)
	}

	return SlackOAuthExchangeResult{
		OK:     response.StatusCode >= 200 && response.StatusCode < 300 && body.OK,
		Status: response.StatusCode,
		Body:   body,
	}, nil
}

package slackagent

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"strings"
	"time"

	"github.com/AFK-surf/oneesama/internal/persistence"
)

var errSlackOAuthNotConfigured = errors.New("slack oauth client credentials are not configured")

type SlackOAuthExchangeError struct {
	Status int
	Reason string
}

func (e *SlackOAuthExchangeError) Error() string {
	if strings.TrimSpace(e.Reason) == "" {
		return "slack oauth exchange failed"
	}
	return "slack oauth exchange failed: " + e.Reason
}

func (s *Service) BeginInstall() (SlackInstallFlow, error) {
	flow := SlackInstallFlow{
		Response: SlackInstallResponse{
			OK:                     true,
			RedirectURI:            s.oauthRedirectURI(),
			OAuthConfigured:        strings.TrimSpace(s.clientID) != "" && strings.TrimSpace(s.clientSecret) != "",
			ClientIDConfigured:     strings.TrimSpace(s.clientID) != "",
			ClientSecretConfigured: strings.TrimSpace(s.clientSecret) != "",
			PermissionModel: SlackPermissionModel{
				Mode: "socket_mode_plus_assistant_dm",
				Notes: []string{
					"Manifest/App Home changes must be followed by Reinstall to Workspace.",
					"OAuth callback persists the returned installation into the configured state provider for future multi-team routing.",
				},
			},
		},
	}
	if !flow.Response.OAuthConfigured {
		return flow, nil
	}

	state, err := newSlackOAuthState()
	if err != nil {
		return SlackInstallFlow{}, err
	}
	redirectURI := s.oauthRedirectURI()
	installURL, err := buildSlackOAuthAuthorizeURL(s.clientID, redirectURI, state)
	if err != nil {
		return SlackInstallFlow{}, err
	}

	flow.State = state
	flow.Response.InstallURL = installURL
	flow.Response.StateCookieSet = true
	return flow, nil
}

func (s *Service) CompleteOAuth(ctx context.Context, code string) (SlackOAuthCallbackResponse, error) {
	if strings.TrimSpace(code) == "" {
		return SlackOAuthCallbackResponse{}, errors.New("slack oauth code is required")
	}
	if strings.TrimSpace(s.clientID) == "" || strings.TrimSpace(s.clientSecret) == "" {
		return SlackOAuthCallbackResponse{}, errSlackOAuthNotConfigured
	}

	exchange, err := s.oauthExchanger.ExchangeCode(ctx, SlackOAuthExchangeInput{
		Code:         code,
		ClientID:     s.clientID,
		ClientSecret: s.clientSecret,
		RedirectURI:  s.oauthRedirectURI(),
	})
	if err != nil {
		return SlackOAuthCallbackResponse{}, err
	}
	if !exchange.OK {
		return SlackOAuthCallbackResponse{}, &SlackOAuthExchangeError{
			Status: exchange.Status,
			Reason: firstNonEmpty(exchange.Body.Error, fmt.Sprintf("http_%d", exchange.Status)),
		}
	}

	store, err := s.installationCollection()
	if err != nil {
		return SlackOAuthCallbackResponse{}, err
	}

	now := time.Now().UTC()
	record := buildSlackInstallation(exchange.Body, now)
	if existing, ok, err := store.Get(ctx, record.InstallationID); err != nil {
		return SlackOAuthCallbackResponse{}, fmt.Errorf("load slack installation %s: %w", record.InstallationID, err)
	} else if ok && strings.TrimSpace(existing.InstalledAt) != "" {
		record.InstalledAt = existing.InstalledAt
	}
	if err := store.Set(ctx, record.InstallationID, record); err != nil {
		return SlackOAuthCallbackResponse{}, fmt.Errorf("persist slack installation %s: %w", record.InstallationID, err)
	}

	return SlackOAuthCallbackResponse{
		OK:           true,
		Installation: record.Summary(),
		RedirectURI:  s.oauthRedirectURI(),
		Note:         "OAuth installation persisted to the configured state provider.",
	}, nil
}

func (s *Service) installationCollection() (*persistence.TypedCollection[SlackInstallation], error) {
	s.installationMu.Lock()
	defer s.installationMu.Unlock()

	if s.installationStore != nil {
		return s.installationStore, nil
	}

	store, err := persistence.OpenTyped[SlackInstallation](persistence.Options{
		Provider:   persistence.NormalizeProvider(s.persistence.Provider),
		Collection: slackOAuthInstallations,
		DataDir:    s.persistence.DataDir,
		SQLitePath: s.persistence.SQLitePath,
	})
	if err != nil {
		s.logger.Warn("slack oauth installation store init failed", "error", err)
		return nil, fmt.Errorf("open slack oauth installation store: %w", err)
	}
	s.installationStore = store
	return store, nil
}

func (s *Service) oauthRedirectURI() string {
	if redirectURI := strings.TrimSpace(s.redirectURI); redirectURI != "" {
		return redirectURI
	}
	baseURL := strings.TrimRight(strings.TrimSpace(s.publicBaseURL), "/")
	if baseURL == "" {
		baseURL = "http://127.0.0.1:8780"
	}
	return baseURL + "/slack/oauth"
}

func buildSlackOAuthAuthorizeURL(clientID string, redirectURI string, state string) (string, error) {
	id := strings.TrimSpace(clientID)
	if id == "" {
		return "", errSlackOAuthNotConfigured
	}
	authorizeURL, err := url.Parse(defaultSlackOAuthAuthorizeURL)
	if err != nil {
		return "", fmt.Errorf("parse slack oauth authorize url: %w", err)
	}

	query := authorizeURL.Query()
	query.Set("client_id", id)
	query.Set("scope", strings.Join(requiredBotScopes, ","))
	if len(recommendedUserScopes) > 0 {
		query.Set("user_scope", strings.Join(recommendedUserScopes, ","))
	}
	if strings.TrimSpace(redirectURI) != "" {
		query.Set("redirect_uri", redirectURI)
	}
	if strings.TrimSpace(state) != "" {
		query.Set("state", state)
	}
	authorizeURL.RawQuery = query.Encode()
	return authorizeURL.String(), nil
}

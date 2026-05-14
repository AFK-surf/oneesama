package slackagent

import (
	"context"
	"slices"
	"strings"
)

const (
	defaultSlackOAuthAuthorizeURL = "https://slack.com/oauth/v2/authorize"
	defaultSlackOAuthAccessURL    = "https://slack.com/api/oauth.v2.access"
	slackOAuthInstallations       = "slack_oauth_installations"
	slackOAuthStateCookie         = "oneesama_slack_oauth_state"
	slackOAuthStateMaxAgeSeconds  = 600
)

type OAuthExchanger interface {
	ExchangeCode(ctx context.Context, input SlackOAuthExchangeInput) (SlackOAuthExchangeResult, error)
}

type SlackOAuthExchangeInput struct {
	Code         string
	ClientID     string
	ClientSecret string
	RedirectURI  string
}

type SlackOAuthExchangeResult struct {
	OK     bool
	Status int
	Body   SlackOAuthResponseBody
}

type SlackOAuthResponseBody struct {
	OK                  bool                    `json:"ok"`
	Error               string                  `json:"error,omitempty"`
	AppID               string                  `json:"app_id,omitempty"`
	Scope               string                  `json:"scope,omitempty"`
	TokenType           string                  `json:"token_type,omitempty"`
	AccessToken         string                  `json:"access_token,omitempty"`
	BotUserID           string                  `json:"bot_user_id,omitempty"`
	RefreshToken        string                  `json:"refresh_token,omitempty"`
	ExpiresIn           int                     `json:"expires_in,omitempty"`
	IsEnterpriseInstall bool                    `json:"is_enterprise_install,omitempty"`
	Team                *SlackOAuthTeam         `json:"team,omitempty"`
	Enterprise          *SlackOAuthEnterprise   `json:"enterprise,omitempty"`
	AuthedUser          *SlackOAuthAuthedUser   `json:"authed_user,omitempty"`
	IncomingWebhook     *SlackOAuthIncomingHook `json:"incoming_webhook,omitempty"`
}

type SlackOAuthTeam struct {
	ID   string `json:"id,omitempty"`
	Name string `json:"name,omitempty"`
}

type SlackOAuthEnterprise struct {
	ID   string `json:"id,omitempty"`
	Name string `json:"name,omitempty"`
}

type SlackOAuthAuthedUser struct {
	ID           string `json:"id,omitempty"`
	Scope        string `json:"scope,omitempty"`
	AccessToken  string `json:"access_token,omitempty"`
	TokenType    string `json:"token_type,omitempty"`
	RefreshToken string `json:"refresh_token,omitempty"`
	ExpiresIn    int    `json:"expires_in,omitempty"`
}

type SlackOAuthIncomingHook struct {
	URL              string `json:"url,omitempty"`
	Channel          string `json:"channel,omitempty"`
	ChannelID        string `json:"channel_id,omitempty"`
	ConfigurationURL string `json:"configuration_url,omitempty"`
}

type SlackInstallFlow struct {
	State    string
	Response SlackInstallResponse
}

type SlackInstallResponse struct {
	OK                     bool                 `json:"ok"`
	InstallURL             string               `json:"install_url"`
	RedirectURI            string               `json:"redirect_uri"`
	OAuthConfigured        bool                 `json:"oauth_configured"`
	ClientIDConfigured     bool                 `json:"client_id_configured"`
	ClientSecretConfigured bool                 `json:"client_secret_configured"`
	StateCookieSet         bool                 `json:"state_cookie_set"`
	PermissionModel        SlackPermissionModel `json:"permission_model"`
}

type SlackPermissionModel struct {
	Mode  string   `json:"mode"`
	Notes []string `json:"notes"`
}

type SlackOAuthCallbackResponse struct {
	OK           bool                     `json:"ok"`
	Installation SlackInstallationSummary `json:"installation"`
	RedirectURI  string                   `json:"redirect_uri"`
	Note         string                   `json:"note,omitempty"`
}

type SlackInstallation struct {
	InstallationID                  string   `json:"installation_id"`
	TeamID                          string   `json:"team_id,omitempty"`
	TeamName                        string   `json:"team_name,omitempty"`
	EnterpriseID                    string   `json:"enterprise_id,omitempty"`
	EnterpriseName                  string   `json:"enterprise_name,omitempty"`
	IsEnterpriseInstall             bool     `json:"is_enterprise_install,omitempty"`
	AppID                           string   `json:"app_id,omitempty"`
	BotUserID                       string   `json:"bot_user_id,omitempty"`
	BotScopes                       []string `json:"bot_scopes,omitempty"`
	BotTokenType                    string   `json:"bot_token_type,omitempty"`
	BotAccessToken                  string   `json:"bot_access_token,omitempty"`
	BotRefreshToken                 string   `json:"bot_refresh_token,omitempty"`
	BotExpiresAt                    string   `json:"bot_expires_at,omitempty"`
	AuthedUserID                    string   `json:"authed_user_id,omitempty"`
	AuthedUserScopes                []string `json:"authed_user_scopes,omitempty"`
	AuthedUserTokenType             string   `json:"authed_user_token_type,omitempty"`
	AuthedUserAccessToken           string   `json:"authed_user_access_token,omitempty"`
	AuthedUserRefreshToken          string   `json:"authed_user_refresh_token,omitempty"`
	AuthedUserExpiresAt             string   `json:"authed_user_expires_at,omitempty"`
	IncomingWebhookURL              string   `json:"incoming_webhook_url,omitempty"`
	IncomingWebhookChannel          string   `json:"incoming_webhook_channel,omitempty"`
	IncomingWebhookChannelID        string   `json:"incoming_webhook_channel_id,omitempty"`
	IncomingWebhookConfigurationURL string   `json:"incoming_webhook_configuration_url,omitempty"`
	InstalledAt                     string   `json:"installed_at"`
	UpdatedAt                       string   `json:"updated_at"`
}

type SlackInstallationSummary struct {
	InstallationID                  string   `json:"installation_id"`
	TeamID                          string   `json:"team_id,omitempty"`
	TeamName                        string   `json:"team_name,omitempty"`
	EnterpriseID                    string   `json:"enterprise_id,omitempty"`
	EnterpriseName                  string   `json:"enterprise_name,omitempty"`
	IsEnterpriseInstall             bool     `json:"is_enterprise_install,omitempty"`
	AppID                           string   `json:"app_id,omitempty"`
	BotUserID                       string   `json:"bot_user_id,omitempty"`
	BotScopes                       []string `json:"bot_scopes,omitempty"`
	BotTokenType                    string   `json:"bot_token_type,omitempty"`
	BotAccessToken                  string   `json:"bot_access_token,omitempty"`
	AuthedUserID                    string   `json:"authed_user_id,omitempty"`
	AuthedUserScopes                []string `json:"authed_user_scopes,omitempty"`
	AuthedUserTokenType             string   `json:"authed_user_token_type,omitempty"`
	AuthedUserAccessToken           string   `json:"authed_user_access_token,omitempty"`
	IncomingWebhookChannel          string   `json:"incoming_webhook_channel,omitempty"`
	IncomingWebhookChannelID        string   `json:"incoming_webhook_channel_id,omitempty"`
	IncomingWebhookConfigurationURL string   `json:"incoming_webhook_configuration_url,omitempty"`
	InstalledAt                     string   `json:"installed_at"`
	UpdatedAt                       string   `json:"updated_at"`
}

func (installation SlackInstallation) Summary() SlackInstallationSummary {
	return SlackInstallationSummary{
		InstallationID:                  installation.InstallationID,
		TeamID:                          installation.TeamID,
		TeamName:                        installation.TeamName,
		EnterpriseID:                    installation.EnterpriseID,
		EnterpriseName:                  installation.EnterpriseName,
		IsEnterpriseInstall:             installation.IsEnterpriseInstall,
		AppID:                           installation.AppID,
		BotUserID:                       installation.BotUserID,
		BotScopes:                       slices.Clone(installation.BotScopes),
		BotTokenType:                    installation.BotTokenType,
		BotAccessToken:                  maskToken(installation.BotAccessToken),
		AuthedUserID:                    installation.AuthedUserID,
		AuthedUserScopes:                slices.Clone(installation.AuthedUserScopes),
		AuthedUserTokenType:             installation.AuthedUserTokenType,
		AuthedUserAccessToken:           maskToken(installation.AuthedUserAccessToken),
		IncomingWebhookChannel:          installation.IncomingWebhookChannel,
		IncomingWebhookChannelID:        installation.IncomingWebhookChannelID,
		IncomingWebhookConfigurationURL: installation.IncomingWebhookConfigurationURL,
		InstalledAt:                     installation.InstalledAt,
		UpdatedAt:                       installation.UpdatedAt,
	}
}

func maskToken(value string) string {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return ""
	}
	if len(trimmed) <= 4 {
		return trimmed
	}
	return "..." + trimmed[len(trimmed)-4:]
}

func splitScopes(value string) []string {
	if strings.TrimSpace(value) == "" {
		return nil
	}
	parts := strings.Split(value, ",")
	return uniqSortedStrings(parts)
}

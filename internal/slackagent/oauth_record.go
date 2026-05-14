package slackagent

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"strings"
	"time"
)

func buildSlackInstallation(body SlackOAuthResponseBody, now time.Time) SlackInstallation {
	timestamp := now.Format(time.RFC3339Nano)
	record := SlackInstallation{
		InstallationID:                  slackInstallationID(body),
		TeamID:                          strings.TrimSpace(body.TeamID()),
		TeamName:                        strings.TrimSpace(body.TeamName()),
		EnterpriseID:                    strings.TrimSpace(body.EnterpriseID()),
		EnterpriseName:                  strings.TrimSpace(body.EnterpriseName()),
		IsEnterpriseInstall:             body.IsEnterpriseInstall,
		AppID:                           strings.TrimSpace(body.AppID),
		BotUserID:                       strings.TrimSpace(body.BotUserID),
		BotScopes:                       splitScopes(body.Scope),
		BotTokenType:                    strings.TrimSpace(body.TokenType),
		BotAccessToken:                  strings.TrimSpace(body.AccessToken),
		BotRefreshToken:                 strings.TrimSpace(body.RefreshToken),
		BotExpiresAt:                    expiresAt(now, body.ExpiresIn),
		AuthedUserID:                    strings.TrimSpace(body.AuthedUserID()),
		AuthedUserScopes:                splitScopes(body.AuthedUserScope()),
		AuthedUserTokenType:             strings.TrimSpace(body.AuthedUserTokenType()),
		AuthedUserAccessToken:           strings.TrimSpace(body.AuthedUserAccessToken()),
		AuthedUserRefreshToken:          strings.TrimSpace(body.AuthedUserRefreshToken()),
		AuthedUserExpiresAt:             expiresAt(now, body.AuthedUserExpiresIn()),
		IncomingWebhookURL:              strings.TrimSpace(body.IncomingWebhookURL()),
		IncomingWebhookChannel:          strings.TrimSpace(body.IncomingWebhookChannel()),
		IncomingWebhookChannelID:        strings.TrimSpace(body.IncomingWebhookChannelID()),
		IncomingWebhookConfigurationURL: strings.TrimSpace(body.IncomingWebhookConfigurationURL()),
		InstalledAt:                     timestamp,
		UpdatedAt:                       timestamp,
	}
	return record
}

func slackInstallationID(body SlackOAuthResponseBody) string {
	if body.IsEnterpriseInstall && strings.TrimSpace(body.EnterpriseID()) != "" {
		return "enterprise:" + strings.TrimSpace(body.EnterpriseID())
	}
	if strings.TrimSpace(body.TeamID()) != "" {
		return "team:" + strings.TrimSpace(body.TeamID())
	}
	if strings.TrimSpace(body.AuthedUserID()) != "" {
		return "user:" + strings.TrimSpace(body.AuthedUserID())
	}
	return "installation:unknown"
}

func expiresAt(now time.Time, seconds int) string {
	if seconds <= 0 {
		return ""
	}
	return now.Add(time.Duration(seconds) * time.Second).UTC().Format(time.RFC3339Nano)
}

func newSlackOAuthState() (string, error) {
	buffer := make([]byte, 16)
	if _, err := rand.Read(buffer); err != nil {
		return "", fmt.Errorf("generate slack oauth state: %w", err)
	}
	return hex.EncodeToString(buffer), nil
}

func (body SlackOAuthResponseBody) TeamID() string {
	if body.Team == nil {
		return ""
	}
	return body.Team.ID
}

func (body SlackOAuthResponseBody) TeamName() string {
	if body.Team == nil {
		return ""
	}
	return body.Team.Name
}

func (body SlackOAuthResponseBody) EnterpriseID() string {
	if body.Enterprise == nil {
		return ""
	}
	return body.Enterprise.ID
}

func (body SlackOAuthResponseBody) EnterpriseName() string {
	if body.Enterprise == nil {
		return ""
	}
	return body.Enterprise.Name
}

func (body SlackOAuthResponseBody) AuthedUserID() string {
	if body.AuthedUser == nil {
		return ""
	}
	return body.AuthedUser.ID
}

func (body SlackOAuthResponseBody) AuthedUserScope() string {
	if body.AuthedUser == nil {
		return ""
	}
	return body.AuthedUser.Scope
}

func (body SlackOAuthResponseBody) AuthedUserTokenType() string {
	if body.AuthedUser == nil {
		return ""
	}
	return body.AuthedUser.TokenType
}

func (body SlackOAuthResponseBody) AuthedUserAccessToken() string {
	if body.AuthedUser == nil {
		return ""
	}
	return body.AuthedUser.AccessToken
}

func (body SlackOAuthResponseBody) AuthedUserRefreshToken() string {
	if body.AuthedUser == nil {
		return ""
	}
	return body.AuthedUser.RefreshToken
}

func (body SlackOAuthResponseBody) AuthedUserExpiresIn() int {
	if body.AuthedUser == nil {
		return 0
	}
	return body.AuthedUser.ExpiresIn
}

func (body SlackOAuthResponseBody) IncomingWebhookURL() string {
	if body.IncomingWebhook == nil {
		return ""
	}
	return body.IncomingWebhook.URL
}

func (body SlackOAuthResponseBody) IncomingWebhookChannel() string {
	if body.IncomingWebhook == nil {
		return ""
	}
	return body.IncomingWebhook.Channel
}

func (body SlackOAuthResponseBody) IncomingWebhookChannelID() string {
	if body.IncomingWebhook == nil {
		return ""
	}
	return body.IncomingWebhook.ChannelID
}

func (body SlackOAuthResponseBody) IncomingWebhookConfigurationURL() string {
	if body.IncomingWebhook == nil {
		return ""
	}
	return body.IncomingWebhook.ConfigurationURL
}

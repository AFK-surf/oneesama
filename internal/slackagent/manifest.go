package slackagent

import (
	"encoding/json"
	"slices"
	"strings"
)

const (
	defaultSlackDisplayName = "Onee-sama"
)

var (
	requiredBotScopes     = []string{"app_mentions:read", "assistant:write", "channels:history", "channels:join", "channels:read", "chat:write", "chat:write.public", "files:read", "files:write", "groups:history", "groups:read", "im:history", "im:read", "im:write", "pins:read", "pins:write", "reactions:read", "reactions:write", "users:read"}
	recommendedBotScopes  = []string{"bookmarks:read", "bookmarks:write", "canvases:read", "canvases:write", "users:read.email"}
	recommendedUserScopes = []string{"channels:history", "channels:read", "groups:history", "im:history"}
	requiredBotEvents     = []string{"app_mention", "assistant_thread_context_changed", "assistant_thread_started", "message.channels", "message.groups", "message.im"}
)

type SlackManifest struct {
	DisplayInformation slackDisplayInformation `json:"display_information"`
	Features           slackFeatures           `json:"features"`
	OAuthConfig        slackOAuthConfig        `json:"oauth_config"`
	Settings           slackSettings           `json:"settings"`
}

type slackDisplayInformation struct {
	Name            string `json:"name"`
	BackgroundColor string `json:"background_color"`
}

type slackFeatures struct {
	AppHome       slackAppHome       `json:"app_home"`
	BotUser       slackBotUser       `json:"bot_user"`
	AssistantView slackAssistantView `json:"assistant_view"`
}

type slackAppHome struct {
	HomeTabEnabled            bool `json:"home_tab_enabled"`
	MessagesTabEnabled        bool `json:"messages_tab_enabled"`
	MessagesTabReadOnlyEnable bool `json:"messages_tab_read_only_enabled"`
}

type slackBotUser struct {
	DisplayName  string `json:"display_name"`
	AlwaysOnline bool   `json:"always_online"`
}

type slackAssistantView struct {
	AssistantDescription string                 `json:"assistant_description"`
	SuggestedPrompts     []slackSuggestedPrompt `json:"suggested_prompts"`
}

type slackSuggestedPrompt struct {
	Title   string `json:"title"`
	Message string `json:"message"`
}

type slackOAuthConfig struct {
	RedirectURLs []string    `json:"redirect_urls"`
	Scopes       slackScopes `json:"scopes"`
}

type slackScopes struct {
	User []string `json:"user"`
	Bot  []string `json:"bot"`
}

type slackSettings struct {
	EventSubscriptions slackEventSubscriptions `json:"event_subscriptions"`
	Interactivity      slackInteractivity      `json:"interactivity"`
	OrgDeployEnabled   bool                    `json:"org_deploy_enabled"`
	SocketModeEnabled  bool                    `json:"socket_mode_enabled"`
	TokenRotation      bool                    `json:"token_rotation_enabled"`
	MCPEnabled         bool                    `json:"is_mcp_enabled"`
}

type slackEventSubscriptions struct {
	RequestURL string   `json:"request_url"`
	BotEvents  []string `json:"bot_events"`
}

type slackInteractivity struct {
	IsEnabled  bool   `json:"is_enabled"`
	RequestURL string `json:"request_url"`
}

func (s *Service) BuildManifest() SlackManifest {
	baseURL := strings.TrimRight(strings.TrimSpace(s.publicBaseURL), "/")
	if baseURL == "" {
		baseURL = "http://127.0.0.1:8780"
	}
	return SlackManifest{
		DisplayInformation: slackDisplayInformation{Name: defaultSlackDisplayName, BackgroundColor: "#302f2f"},
		Features: slackFeatures{
			AppHome: slackAppHome{HomeTabEnabled: true, MessagesTabEnabled: true},
			BotUser: slackBotUser{DisplayName: defaultSlackDisplayName, AlwaysOnline: true},
			AssistantView: slackAssistantView{
				AssistantDescription: defaultSlackDisplayName + " helps summarize conversations, answer questions, and delegate complex work to Codex.",
				SuggestedPrompts: []slackSuggestedPrompt{
					{Title: "总结当前频道", Message: "请总结这个频道最近的重要讨论。"},
					{Title: "委托 Codex", Message: "请把这个任务委托给 Codex，并把结果发回这个线程。"},
				},
			},
		},
		OAuthConfig: slackOAuthConfig{
			RedirectURLs: []string{baseURL + "/slack/oauth"},
			Scopes: slackScopes{
				User: uniqSortedStrings(recommendedUserScopes),
				Bot:  uniqSortedStrings(append(slices.Clone(requiredBotScopes), recommendedBotScopes...)),
			},
		},
		Settings: slackSettings{
			EventSubscriptions: slackEventSubscriptions{RequestURL: baseURL + "/slack/events", BotEvents: slices.Clone(requiredBotEvents)},
			Interactivity:      slackInteractivity{IsEnabled: true, RequestURL: baseURL + "/slack/interactions"},
			SocketModeEnabled:  true,
		},
	}
}

func parseSlackManifest(input any) (SlackManifest, error) {
	payload, err := json.Marshal(input)
	if err != nil {
		return SlackManifest{}, err
	}
	var manifest SlackManifest
	if err := json.Unmarshal(payload, &manifest); err != nil {
		return SlackManifest{}, err
	}
	return manifest, nil
}

func uniqSortedStrings(values []string) []string {
	seen := make(map[string]struct{}, len(values))
	out := make([]string, 0, len(values))
	for _, value := range values {
		trimmed := strings.TrimSpace(value)
		if trimmed == "" {
			continue
		}
		if _, ok := seen[trimmed]; ok {
			continue
		}
		seen[trimmed] = struct{}{}
		out = append(out, trimmed)
	}
	slices.Sort(out)
	return out
}

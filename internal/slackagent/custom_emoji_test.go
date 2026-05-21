package slackagent

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/AFK-surf/oneesama/internal/persona"
)

func TestFetchWorkspaceCustomEmojiFiltersAliasesAndSorts(t *testing.T) {
	t.Parallel()

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/emoji.list" {
			t.Fatalf("path = %q, want /emoji.list", r.URL.Path)
		}
		if got := r.Header.Get("Authorization"); got != "Bearer xoxb-test" {
			t.Fatalf("Authorization = %q, want bearer token", got)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"ok": true,
			"emoji": map[string]string{
				"z_bridge":     "https://example.test/z.png",
				"alias_bridge": "alias:z_bridge",
				"eyes_bridge":  "https://example.test/eyes.png",
			},
		})
	}))
	defer server.Close()

	names, errText := fetchWorkspaceCustomEmoji(context.Background(), "xoxb-test", server.URL, nil)
	if errText != "" {
		t.Fatalf("fetchWorkspaceCustomEmoji error = %q", errText)
	}
	if got, want := strings.Join(names, ","), "eyes_bridge,z_bridge"; got != want {
		t.Fatalf("names = %q, want %q", got, want)
	}
}

func TestBuildSlackTriagePromptIncludesWorkspaceCustomEmoji(t *testing.T) {
	t.Parallel()

	prompt := buildSlackTriagePrompt(SlackTriagePromptInput{
		ChannelID:   "C123",
		Digest:      "这个可以轻轻回应一下",
		CustomEmoji: []string{"eyes_bridge", "thumbsup_bridge"},
	})
	for _, want := range []string{
		"## Workspace custom emoji",
		"eyes_bridge",
		"thumbsup_bridge",
		"reactions.add maps to type add_reaction",
	} {
		if !strings.Contains(prompt, want) {
			t.Fatalf("prompt missing %q:\n%s", want, prompt)
		}
	}
}

func TestBuildSlackTriagePersonaRequestIncludesWorkspaceCustomEmoji(t *testing.T) {
	t.Parallel()

	req := BuildSlackTriagePersonaRequestWithOptions(
		"C123",
		"100.000",
		[]SlackInboundMessage{{Text: "这条点个 reaction 就好"}},
		SlackTriageDecision{Summary: "reaction-worthy", ParseOK: true},
		nil,
		SlackTriagePersonaRequestOptions{CustomEmoji: []string{"ok_bridge", "eyes_bridge"}},
	)
	if !req.Safety.AllowReactions {
		t.Fatalf("AllowReactions = false, want true")
	}
	if got := personaContextText(req.Context, "workspace_custom_emoji"); got != "" {
		t.Fatalf("workspace_custom_emoji stable context = %q, want dynamic envelope only", got)
	}
	env, ok := personaDynamicContextEnvelope(req.DynamicContext, "workspace_custom_emoji")
	if !ok {
		t.Fatalf("dynamic context = %#v, want custom emoji envelope", req.DynamicContext)
	}
	if !strings.Contains(env.Content, "ok_bridge") || !strings.Contains(env.Content, "eyes_bridge") {
		t.Fatalf("workspace_custom_emoji dynamic context = %q, want custom names", env.Content)
	}
	if env.Source != slackDynamicContextSourceCustomEmoji || !strings.HasPrefix(env.Version, "sha256:") || env.Metadata["emoji_count"] != 2 {
		t.Fatalf("workspace_custom_emoji envelope = %#v, want source/version/count", env)
	}
}

func TestPersonaReactDecisionBecomesDirectReactionAction(t *testing.T) {
	t.Parallel()

	result := SlackPersonaShadowResult{
		Success:  true,
		Runtime:  persona.ProviderPi,
		Decision: persona.DecisionReact,
		reactionRecords: []persona.ReactionIntent{{
			Emoji:     "eyes_bridge",
			MessageTS: "100.123",
			Reason:    "light acknowledgement",
		}},
	}
	actions := slackPersonaForegroundActions("C123", "100.000", result)
	if len(actions) != 1 {
		t.Fatalf("actions = %#v, want one reaction action", actions)
	}
	action := actions[0]
	if action.Type != "add_reaction" || action.Emoji != "eyes_bridge" || action.MessageTS != "100.123" || action.RequiresConfirmation {
		t.Fatalf("action = %#v, want direct add_reaction", action)
	}
}

func TestSlackAPIToolListEmojiUsesWorkspaceCache(t *testing.T) {
	t.Parallel()

	tool := &slackAPITool{
		role:        slackAPIRoleAssistant,
		customEmoji: func() []string { return []string{"z_bridge", "eyes_bridge"} },
	}
	result, err := tool.Execute(context.Background(), map[string]any{"action": "list_emoji"})
	if err != nil {
		t.Fatalf("Execute: %v", err)
	}
	if !result.Success {
		t.Fatalf("result = %#v, want success", result)
	}
	for _, want := range []string{`"source":"workspace_cache"`, "eyes_bridge", "z_bridge"} {
		if !strings.Contains(result.Text, want) {
			t.Fatalf("result text missing %q: %s", want, result.Text)
		}
	}
}

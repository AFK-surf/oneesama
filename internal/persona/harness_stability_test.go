package persona

import "testing"

func TestOneesamaPIStablePromptHashIgnoresDynamicRequestInputs(t *testing.T) {
	base := Request{
		ID:   "stable-hash-a",
		Mode: ModeLive,
		Event: Event{
			Kind:      "slack_message",
			Text:      "first thread text",
			CreatedAt: "2026-05-21T10:00:00Z",
		},
		Context: []ContextItem{
			{Kind: "workspace_triage_policy", Text: "engage product-adjacent AI agent news", SourceRef: "policy:v1"},
			{Kind: "workspace_custom_emoji", Text: "oneesama, eyes_bridge", SourceRef: "emoji:v1"},
		},
		Memory: MemoryContext{
			Summary: "prior discussion about Browser Use",
			Items: []MemoryRecord{
				{Kind: "fact", Text: "Oneesama uses Pi-first foreground", SourceRef: "memory/a"},
			},
		},
		Metadata: map[string]any{
			"live_service_status": "green",
			"current_time":        "2026-05-21T18:00:00+08:00",
		},
	}
	changed := Request{
		ID:   "stable-hash-b",
		Mode: ModeShadow,
		Event: Event{
			Kind:      "slack_message",
			Text:      "different thread text",
			CreatedAt: "2026-05-22T10:00:00Z",
		},
		Context: []ContextItem{
			{Kind: "workspace_triage_policy", Text: "different policy text", SourceRef: "policy:v2"},
			{Kind: "workspace_custom_emoji", Text: "new_custom_emoji", SourceRef: "emoji:v2"},
		},
		Memory: MemoryContext{
			Summary: "different memory evidence",
			Items: []MemoryRecord{
				{Kind: "lesson", Text: "Different memory text", SourceRef: "memory/b"},
			},
		},
		Metadata: map[string]any{
			"live_service_status": "red",
			"current_time":        "2026-05-22T18:00:00+08:00",
		},
	}

	if got, want := OneesamaPIStablePromptHash(changed), OneesamaPIStablePromptHash(base); got != want {
		t.Fatalf("stable prompt hash changed with dynamic request inputs: got %s want %s", got, want)
	}
	if got, want := OneesamaPIStablePromptText(changed), OneesamaPIStablePromptText(base); got != want {
		t.Fatalf("stable prompt text changed with dynamic request inputs:\n--- got ---\n%s\n--- want ---\n%s", got, want)
	}
}

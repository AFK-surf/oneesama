package agentrunner

import (
	"strings"
	"testing"
)

func TestBuildPromptUsesWorkspaceAssistantForSlackSessions(t *testing.T) {
	prompt := buildPrompt(WithSessionCapabilities(StartInput{
		Task: "帮我把后面补充的信息并进文稿",
		Context: map[string]any{
			"source":               "slack-agent",
			"slackAssistantPrompt": "Thread metadata:\n- channel: C123\n\nThread context:\n[ts:1.0] <@U1>: 初稿\n[ts:2.0] <@U1>: 后面补充",
		},
	}, SessionKindSlack))

	for _, want := range []string{
		"You are a workspace assistant operating inside a Slack workspace.",
		"Thread context:",
		"帮我把后面补充的信息并进文稿",
		"prefer injected related memory evidence",
		"Oneesama's foreground / triage runtime is PiAgent",
	} {
		if !strings.Contains(prompt, want) {
			t.Fatalf("prompt missing %q:\n%s", want, prompt)
		}
	}
	if strings.Contains(prompt, "oneesama Go rewrite") {
		t.Fatalf("slack workspace prompt leaked repo-worker identity:\n%s", prompt)
	}
}

func TestBuildPromptUsesDemoSurfaceWorkerForDemoSurfaceSessions(t *testing.T) {
	prompt := buildPrompt(WithSessionCapabilities(StartInput{
		Task:             `Return {"summary":"ok","confidence":1}`,
		Mode:             "analysis",
		AllowCodeChanges: false,
		Context: map[string]any{
			"adapter": "codex",
			"url":     "https://example.test/demo",
		},
	}, SessionKindDemoSurface))

	for _, want := range []string{
		"read-only browser observation worker",
		"Do not call meeting, Slack, or messaging tools",
		"Return exactly the JSON object requested by the task",
		`"session_kind": "meeting_demo_surface"`,
	} {
		if !strings.Contains(prompt, want) {
			t.Fatalf("prompt missing %q:\n%s", want, prompt)
		}
	}
	for _, forbidden := range []string{
		"background worker for the oneesama Go rewrite",
		"Answer in concise Chinese",
		"workspace assistant operating inside a Slack workspace",
	} {
		if strings.Contains(prompt, forbidden) {
			t.Fatalf("demo surface prompt leaked forbidden phrase %q:\n%s", forbidden, prompt)
		}
	}
}

func TestBuildPromptUsesReadOnlySecretaryBoundaryForSecretaryLookup(t *testing.T) {
	prompt := buildPrompt(WithSessionCapabilities(StartInput{
		Task:             "Identify this linked HN profile from thread and memory evidence.",
		Mode:             "analysis",
		AllowCodeChanges: false,
		Context: map[string]any{
			"source": "persona_delegate_worker",
		},
	}, SessionKindSecretaryLookup))

	for _, want := range []string{
		"workspace assistant operating inside a Slack workspace",
		"Secretary lookup boundary",
		"read-only secretary lookup",
		"do not edit repos",
		"do not edit repos, schedule follow-ups, create canvases, or send Slack/Meet messages",
		`"session_kind": "secretary_lookup"`,
	} {
		if !strings.Contains(prompt, want) {
			t.Fatalf("prompt missing %q:\n%s", want, prompt)
		}
	}
}

func TestBuildPromptSurfacesWorkerHandoffContract(t *testing.T) {
	prompt := buildPrompt(WithSessionCapabilities(StartInput{
		Task:             "Identify this linked HN profile from thread and memory evidence.",
		Mode:             "analysis",
		AllowCodeChanges: false,
		Context: map[string]any{
			"source": "persona_delegate_worker",
			"handoff": map[string]any{
				"source_agent":    "oneesama_pi_foreground",
				"target_agent":    "secretary_lookup_worker",
				"reason":          "needs source-backed identity lookup",
				"expected_output": "JSON with visible_text and evidence_anchors",
				"boundaries":      []string{"read-only", "do not send Slack messages"},
			},
		},
	}, SessionKindSecretaryLookup))

	for _, want := range []string{
		"Worker handoff contract",
		"target subagent",
		`"source_agent": "oneesama_pi_foreground"`,
		`"target_agent": "secretary_lookup_worker"`,
		"do not send Slack messages",
		"Return results to Oneesama",
	} {
		if !strings.Contains(prompt, want) {
			t.Fatalf("prompt missing handoff contract %q:\n%s", want, prompt)
		}
	}
}

func TestBuildPromptInjectsLayeredIdentityBoundaryForSlackWorkers(t *testing.T) {
	prompt := buildPrompt(WithSessionCapabilities(StartInput{
		Task: "你是什么模型",
		Context: map[string]any{
			"source": "slack-agent",
			"oneesamaIdentity": map[string]any{
				"foreground": map[string]any{"runtime": "PiAgent"},
				"worker":     map[string]any{"provider": "codex"},
			},
			"relatedMemoryEvidence": `codex-3720: 我是 OpenAI Codex 的 Slack 代理。`,
		},
	}, SessionKindSlack))

	for _, want := range []string{
		"You are a delegated execution component inside Oneesama",
		"answer from the `oneesamaIdentity` context",
		"foreground / triage runtime is PiAgent",
		"Do not answer identity questions by describing only your local worker process",
		"another bot's historical self-description from memory",
	} {
		if !strings.Contains(prompt, want) {
			t.Fatalf("prompt missing identity boundary %q:\n%s", want, prompt)
		}
	}
}

func TestBuildPromptReadsSlackAppMentionPromptFromGenericContext(t *testing.T) {
	prompt := buildPrompt(StartInput{
		Task: "看看补充的信息",
		Context: map[string]any{
			"source":       "slack-agent",
			"session_kind": SessionKindSlack,
			"slackAppMention": map[string]any{
				"prompt": "Thread metadata:\n- thread_ts: 123.456\n\nThread context:\nold canvas F123",
			},
		},
	})

	if !strings.Contains(prompt, "workspace assistant operating inside a Slack workspace") ||
		!strings.Contains(prompt, "old canvas F123") {
		t.Fatalf("prompt = %s, want workspace assistant prompt with mention context", prompt)
	}
	if strings.Contains(prompt, "background worker for the oneesama Go rewrite") {
		t.Fatalf("prompt should not use repo-worker framing for Slack assistant sessions:\n%s", prompt)
	}
}

func TestBuildPromptDoesNotTellSlackWorkerToCurlLocalGateway(t *testing.T) {
	prompt := buildPrompt(WithSessionCapabilities(StartInput{
		Task: "读一下这个 X 链接",
		Context: map[string]any{
			"source": "slack-agent",
		},
	}, SessionKindSlack))

	for _, forbidden := range []string{
		"http://127.0.0.1:8780/slack/tools/call",
		"curl http://127.0.0.1",
		"Local Slack tool gateway",
	} {
		if strings.Contains(prompt, forbidden) {
			t.Fatalf("prompt leaked local gateway instruction %q:\n%s", forbidden, prompt)
		}
	}
	for _, want := range []string{
		"Do not attempt to reach localhost",
		"cannot safely verify",
		"<oneesama_tool_request>",
	} {
		if !strings.Contains(prompt, want) {
			t.Fatalf("prompt missing fail-closed guidance %q:\n%s", want, prompt)
		}
	}
}

func TestBuildPromptSurfacesFirstClassSlackToolEvidence(t *testing.T) {
	prompt := buildPrompt(WithSessionCapabilities(StartInput{
		Task: "介绍 Zyphra Labs",
		Context: map[string]any{
			"source":            "slack-agent",
			"slackToolEvidence": "1. exa_search (ok)\n   summary: Zyphra Labs builds audio and voice AI models.",
		},
	}, SessionKindSlack))

	for _, want := range []string{
		"Slack tool evidence (first-class dispatcher results",
		"Zyphra Labs builds audio and voice AI models.",
	} {
		if !strings.Contains(prompt, want) {
			t.Fatalf("prompt missing tool evidence %q:\n%s", want, prompt)
		}
	}
}

func TestBuildPromptForbidsNegativeSupportClaimFromMissingEvidence(t *testing.T) {
	prompt := buildPrompt(WithSessionCapabilities(StartInput{
		Task: "Bridge 支持 Windows 吗？",
		Context: map[string]any{
			"source":            "slack-agent",
			"slackToolEvidence": "1. memory_search (ok)\n   results: []",
		},
	}, SessionKindSlack))

	for _, want := range []string{
		"Do not turn \"no evidence found\" into a negative product claim",
		"Do not convert missing evidence into a negative product-support claim",
	} {
		if !strings.Contains(prompt, want) {
			t.Fatalf("prompt missing missing-evidence guard %q:\n%s", want, prompt)
		}
	}
}

func TestBuildPromptSurfacesRelatedMemoryEvidence(t *testing.T) {
	prompt := buildPrompt(WithSessionCapabilities(StartInput{
		Task: "jc说之前录制了5个Case Study的视频，这个有吗？",
		Context: map[string]any{
			"source":                "slack-agent",
			"relatedMemoryEvidence": "memory/team/meetings/jc-case-study.md:1-3 [team_meeting]: Jc discussed five use case demos, not recorded Case Study videos.",
		},
	}, SessionKindSlack))

	for _, want := range []string{
		"Related memory evidence",
		"memory/team/meetings/jc-case-study.md:1-3",
		"five use case demos",
	} {
		if !strings.Contains(prompt, want) {
			t.Fatalf("prompt missing %q:\n%s", want, prompt)
		}
	}
}

package meetingagent

import (
	"testing"

	appconfig "github.com/AFK-surf/oneesama/pkg/config"
)

func TestBuildRealtimeSessionLegacySchema(t *testing.T) {
	t.Parallel()

	session := buildRealtimeSessionConfig(RealtimeSessionOptions{
		SessionSchema:     "realtime-1.5",
		OutputModalities:  "audio,text",
		InputAudioFormat:  "pcm16",
		OutputAudioFormat: "pcm16",
	}, testRealtimeOpenAIConfig())

	if session["modalities"].([]string)[1] != "text" {
		t.Fatalf("modalities = %#v, want parsed comma string", session["modalities"])
	}
	if _, ok := session["output_modalities"]; ok {
		t.Fatalf("legacy session should not include realtime-2 output_modalities: %#v", session)
	}
	turn := session["turn_detection"].(map[string]any)
	if turn["type"] != "server_vad" {
		t.Fatalf("turn_detection = %#v, want legacy server_vad default", turn)
	}
}

func TestBuildRealtimeSessionMergesAudioAndReasoningOverrides(t *testing.T) {
	t.Parallel()

	session := buildRealtimeSessionConfig(RealtimeSessionOptions{
		Reasoning: map[string]any{"effort": "low"},
		Audio: map[string]any{
			"input": map[string]any{
				"noise_reduction": map[string]any{"type": "near_field"},
			},
			"output": map[string]any{"voice": "override_voice"},
		},
	}, testRealtimeOpenAIConfig())

	reasoning := session["reasoning"].(map[string]any)
	if reasoning["effort"] != "low" {
		t.Fatalf("reasoning = %#v, want explicit override", reasoning)
	}
	audio := session["audio"].(map[string]any)
	input := audio["input"].(map[string]any)
	if input["turn_detection"] == nil || input["noise_reduction"] == nil {
		t.Fatalf("input audio = %#v, want merged default + override", input)
	}
	output := audio["output"].(map[string]any)
	if output["voice"] != "override_voice" {
		t.Fatalf("output audio = %#v, want nested override", output)
	}
}

func TestBuildRealtimeSessionSupportsStructuredTurnDetection(t *testing.T) {
	t.Parallel()

	session := buildRealtimeSessionConfig(RealtimeSessionOptions{
		TurnDetection: map[string]any{
			"type":      "semantic_vad",
			"eagerness": "low",
		},
	}, testRealtimeOpenAIConfig())

	audio := session["audio"].(map[string]any)
	input := audio["input"].(map[string]any)
	turn := input["turn_detection"].(map[string]any)
	if turn["type"] != "semantic_vad" || turn["eagerness"] != "low" {
		t.Fatalf("turn_detection = %#v, want structured semantic_vad override", turn)
	}
}

func TestBuildRealtimeSessionDisablesTurnDetectionWithNone(t *testing.T) {
	t.Parallel()

	session := buildRealtimeSessionConfig(RealtimeSessionOptions{
		TurnDetection: "none",
	}, testRealtimeOpenAIConfig())

	audio := session["audio"].(map[string]any)
	input := audio["input"].(map[string]any)
	if input["turn_detection"] != nil {
		t.Fatalf("turn_detection = %#v, want nil", input["turn_detection"])
	}
}

func testRealtimeOpenAIConfig() appconfig.OpenAIConfig {
	return appconfig.OpenAIConfig{
		BaseURL:                  "https://api.openai.com/v1",
		RealtimeClientSecretsURL: "https://api.openai.com/v1/realtime/client_secrets",
		RealtimeSDPURL:           "https://api.openai.com/v1/realtime/calls",
		RealtimeModel:            "gpt-realtime-2",
		RealtimeReasoningEffort:  "high",
		RealtimeVoice:            "marin",
		RealtimeTurnDetection:    "semantic_vad",
		RealtimeSessionSchema:    "realtime-2",
		BotName:                  "Meeting Avatar Bot",
	}
}

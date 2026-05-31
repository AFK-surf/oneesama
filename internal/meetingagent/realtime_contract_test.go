package meetingagent

import (
	"strings"
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

func TestBuildRealtimeSessionAppliesProductTruncationDefault(t *testing.T) {
	session := buildRealtimeSessionConfig(RealtimeSessionOptions{}, testRealtimeOpenAIConfig())
	truncation, ok := session["truncation"].(map[string]any)
	if !ok {
		t.Fatalf("truncation = %#v, want object", session["truncation"])
	}
	if truncation["type"] != "retention_ratio" || truncation["retention_ratio"] != 0.8 {
		t.Fatalf("truncation = %#v, want retention_ratio 0.8", truncation)
	}
	tokenLimits, ok := truncation["token_limits"].(map[string]any)
	if !ok || tokenLimits["post_instructions"] != 8000 {
		t.Fatalf("token_limits = %#v, want post_instructions 8000", truncation["token_limits"])
	}
}

func TestBuildRealtimeSessionAllowsTruncationOverride(t *testing.T) {
	session := buildRealtimeSessionConfig(RealtimeSessionOptions{
		Truncation: "disabled",
	}, testRealtimeOpenAIConfig())
	if session["truncation"] != "disabled" {
		t.Fatalf("truncation = %#v, want disabled", session["truncation"])
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

func TestBuildRealtimeInstructionsIncludesRealtimeQualityGuards(t *testing.T) {
	t.Parallel()

	instructions := buildRealtimeInstructions(RealtimeSessionOptions{
		BotName: "Meeting Avatar Bot",
	}, testRealtimeOpenAIConfig())

	for _, want := range []string{
		"Addressing contract:",
		"Do not say internal control-plane status",
		"Do not announce what you are about to do",
		"Do not proactively offer capabilities",
		"Runtime video/HUD state is driven by audio/tool/job telemetry",
		"If the user says stop planning",
		"Ignore obvious self-echo",
		"Do not invent click/drag primitives",
		"observe -> plan -> act -> verify",
		"status queued or running",
		"Do not claim completion",
		"Screen-share action mandate:",
		"first action in that turn must be list_shareable_windows or share_existing_app_window",
		"Do not answer that a window list is processing",
		"App-control identity boundary:",
		"bot's host Mac",
		"这台 Mac mini",
		"“你用电脑控制”",
		"call control_shared_app_window",
		"Never satisfy an app-control request with a visual/HUD-only update",
		"Do not tell the human to share Chrome to you",
	} {
		if !strings.Contains(instructions, want) {
			t.Fatalf("instructions missing %q:\n%s", want, instructions)
		}
	}
}

func TestBuildRealtimeSessionMapsFastTurnDetectionPreset(t *testing.T) {
	t.Parallel()

	cfg := testRealtimeOpenAIConfig()
	cfg.RealtimeTurnDetection = "fast"
	session := buildRealtimeSessionConfig(RealtimeSessionOptions{}, cfg)

	audio := session["audio"].(map[string]any)
	input := audio["input"].(map[string]any)
	turn := input["turn_detection"].(map[string]any)
	if turn["type"] != "semantic_vad" || turn["eagerness"] != "high" ||
		turn["create_response"] != true || turn["interrupt_response"] != true {
		t.Fatalf("turn_detection = %#v, want fast semantic_vad preset", turn)
	}
}

func TestBuildRealtimeSessionDefaultsToSteadyTurnDetection(t *testing.T) {
	t.Parallel()

	cfg := testRealtimeOpenAIConfig()
	cfg.RealtimeTurnDetection = "steady"
	session := buildRealtimeSessionConfig(RealtimeSessionOptions{}, cfg)

	audio := session["audio"].(map[string]any)
	input := audio["input"].(map[string]any)
	turn := input["turn_detection"].(map[string]any)
	if turn["type"] != "semantic_vad" || turn["eagerness"] != "low" ||
		turn["create_response"] != true || turn["interrupt_response"] != true {
		t.Fatalf("turn_detection = %#v, want steady semantic_vad preset", turn)
	}
}

func TestBuildRealtimeSessionParsesJSONTurnDetectionConfig(t *testing.T) {
	t.Parallel()

	cfg := testRealtimeOpenAIConfig()
	cfg.RealtimeTurnDetection = `{"type":"semantic_vad","eagerness":"high"}`
	session := buildRealtimeSessionConfig(RealtimeSessionOptions{}, cfg)

	audio := session["audio"].(map[string]any)
	input := audio["input"].(map[string]any)
	turn := input["turn_detection"].(map[string]any)
	if turn["type"] != "semantic_vad" || turn["eagerness"] != "high" {
		t.Fatalf("turn_detection = %#v, want JSON semantic_vad config", turn)
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
		RealtimeTurnDetection:    "steady",
		RealtimeSessionSchema:    "realtime-2",
		BotName:                  "Meeting Avatar Bot",
	}
}

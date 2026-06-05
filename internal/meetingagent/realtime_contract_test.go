package meetingagent

import (
	"reflect"
	"sort"
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

func TestBuildRealtimeSessionEnablesInputAudioTranscriptionByDefault(t *testing.T) {
	session := buildRealtimeSessionConfig(RealtimeSessionOptions{}, testRealtimeOpenAIConfig())
	audio := session["audio"].(map[string]any)
	input := audio["input"].(map[string]any)
	transcription := input["transcription"].(map[string]any)
	if transcription["model"] != "gpt-4o-mini-transcribe" {
		t.Fatalf("transcription = %#v, want default model", transcription)
	}
}

func TestBuildRealtimeSessionAllowsInputAudioTranscriptionOverrideAndDisable(t *testing.T) {
	overridden := buildRealtimeSessionConfig(RealtimeSessionOptions{
		InputAudioTranscription: map[string]any{"model": "custom-transcribe", "language": "zh"},
	}, testRealtimeOpenAIConfig())
	disabled := buildRealtimeSessionConfig(RealtimeSessionOptions{
		InputAudioTranscription: "disabled",
	}, testRealtimeOpenAIConfig())

	overriddenAudio := overridden["audio"].(map[string]any)
	overriddenInput := overriddenAudio["input"].(map[string]any)
	transcription := overriddenInput["transcription"].(map[string]any)
	if transcription["model"] != "custom-transcribe" || transcription["language"] != "zh" {
		t.Fatalf("transcription = %#v, want override", transcription)
	}

	disabledAudio := disabled["audio"].(map[string]any)
	disabledInput := disabledAudio["input"].(map[string]any)
	if _, ok := disabledInput["transcription"]; ok {
		t.Fatalf("transcription = %#v, want omitted", disabledInput["transcription"])
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

func TestBuildRealtimeSessionDefaultsToLiveSafeToolSurface(t *testing.T) {
	t.Parallel()

	session := buildRealtimeSessionConfig(RealtimeSessionOptions{}, testRealtimeOpenAIConfig())
	tools := session["tools"].([]map[string]any)
	if !toolNamesInclude(realtimeToolMapsAsAny(tools), "share_existing_app_window", "kwwk_computer_use") {
		t.Fatalf("tools = %#v, missing live-safe app share/control tools", tools)
	}
	if toolNamesInclude(realtimeToolMapsAsAny(tools), "control_shared_app_window") {
		t.Fatalf("tools = %#v, compatibility app-control alias must not be in default Realtime tools", tools)
	}
	if toolNamesInclude(realtimeToolMapsAsAny(tools), "open_shared_browser_surface", "create_shared_workspace", "control_shared_browser_surface", "stop_shared_browser_surface") {
		t.Fatalf("tools = %#v, default session must not include demo/browser-surface tools", tools)
	}
}

func TestRealtimeKWWKToolSchemaOnlyExposesGoalAndTargetHints(t *testing.T) {
	t.Parallel()

	var kwwk map[string]any
	for _, tool := range defaultRealtimeToolSchemas() {
		if tool["name"] == "kwwk_computer_use" {
			kwwk = tool
			break
		}
	}
	if kwwk == nil {
		t.Fatal("kwwk_computer_use missing from default Realtime tools")
	}
	parameters := kwwk["parameters"].(map[string]any)
	properties := parameters["properties"].(map[string]any)
	keys := make([]string, 0, len(properties))
	for key := range properties {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	want := []string{
		"applicationName",
		"bundleIdentifier",
		"instruction",
		"processId",
		"session_id",
		"windowId",
		"windowTitle",
	}
	if !reflect.DeepEqual(keys, want) {
		t.Fatalf("kwwk_computer_use properties = %#v, want only goal and target hints %#v", keys, want)
	}
	for _, hidden := range []string{"job_id", "operations", "executionMode", "wait", "timeoutMs", "x", "y"} {
		if _, ok := properties[hidden]; ok {
			t.Fatalf("kwwk_computer_use must not expose %q to Realtime: %#v", hidden, properties)
		}
	}
}

func TestBuildRealtimeSessionAllowsExplicitDemoToolSurface(t *testing.T) {
	t.Parallel()

	session := buildRealtimeSessionConfig(RealtimeSessionOptions{
		Tools: realtimeToolSchemas(true),
	}, testRealtimeOpenAIConfig())
	tools := session["tools"].([]map[string]any)
	if !toolNamesInclude(realtimeToolMapsAsAny(tools), "open_shared_browser_surface", "control_shared_browser_surface") {
		t.Fatalf("tools = %#v, explicit demo-surface opt-in should include browser tools", tools)
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
		"Always answer in concise English, regardless of the user's language.",
		"Addressing contract:",
		"Do not say internal control-plane status",
		"Do not announce what you are about to do",
		"Do not proactively offer capabilities",
		"Runtime video/HUD state is driven by audio/tool/job telemetry",
		"If the user says stop planning",
		"Ignore obvious self-echo",
		"KWWK Computer Use routing:",
		"call kwwk_computer_use",
		"long-running background app-control path",
		"status queued or running",
		"Do not claim completion",
		"Screen-share action mandate:",
		"first action in that turn must be list_shareable_windows or share_existing_app_window",
		"Do not answer that a window list is processing",
		"Fake-execution ban:",
		"before emitting the corresponding tool call",
		"App-control identity boundary:",
		"bot's host Mac",
		"这台 Mac mini",
		"“你用电脑控制”",
		"call kwwk_computer_use",
		"Never satisfy an app-control request with a visual/HUD-only update",
		"Do not tell the human to share Chrome to you",
	} {
		if !strings.Contains(instructions, want) {
			t.Fatalf("instructions missing %q:\n%s", want, instructions)
		}
	}
	for _, unwanted := range []string{
		"Speak concise Chinese by default.",
		"summarize the result in concise Chinese",
	} {
		if strings.Contains(instructions, unwanted) {
			t.Fatalf("instructions contain obsolete Chinese-output requirement %q:\n%s", unwanted, instructions)
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

package meetingagent

type RealtimeCurrentUser struct {
	Name        string   `json:"name,omitempty"`
	EnglishName string   `json:"englishName,omitempty"`
	English     string   `json:"english,omitempty"`
	Email       string   `json:"email,omitempty"`
	Linear      string   `json:"linear,omitempty"`
	GitHub      string   `json:"github,omitempty"`
	Role        string   `json:"role,omitempty"`
	Aliases     []string `json:"aliases,omitempty"`
}

type RealtimeSessionOptions struct {
	BotName                string              `json:"botName,omitempty"`
	Model                  string              `json:"model,omitempty"`
	Instructions           string              `json:"instructions,omitempty"`
	Tools                  []map[string]any    `json:"tools,omitempty"`
	ToolChoice             string              `json:"toolChoice,omitempty"`
	ToolChoiceSnake        string              `json:"tool_choice,omitempty"`
	Voice                  string              `json:"voice,omitempty"`
	OutputModalities       any                 `json:"outputModalities,omitempty"`
	OutputModalitiesSnake  any                 `json:"output_modalities,omitempty"`
	InputAudioFormat       string              `json:"inputAudioFormat,omitempty"`
	InputAudioFormatSnake  string              `json:"input_audio_format,omitempty"`
	OutputAudioFormat      string              `json:"outputAudioFormat,omitempty"`
	OutputAudioFormatSnake string              `json:"output_audio_format,omitempty"`
	InputAudioFormatType   string              `json:"inputAudioFormatType,omitempty"`
	OutputAudioFormatType  string              `json:"outputAudioFormatType,omitempty"`
	InputAudioRate         any                 `json:"inputAudioRate,omitempty"`
	OutputAudioRate        any                 `json:"outputAudioRate,omitempty"`
	ReasoningEffort        string              `json:"reasoningEffort,omitempty"`
	ReasoningEffortSnake   string              `json:"reasoning_effort,omitempty"`
	Reasoning              map[string]any      `json:"reasoning,omitempty"`
	TurnDetection          any                 `json:"turnDetection,omitempty"`
	TurnDetectionSnake     any                 `json:"turn_detection,omitempty"`
	Audio                  map[string]any      `json:"audio,omitempty"`
	SessionSchema          string              `json:"sessionSchema,omitempty"`
	SessionSchemaSnake     string              `json:"session_schema,omitempty"`
	PersonalityContext     string              `json:"personalityContext,omitempty"`
	CurrentUser            RealtimeCurrentUser `json:"currentUser,omitempty"`
	SafetyIdentifier       string              `json:"safetyIdentifier,omitempty"`
	RequestedBy            string              `json:"requestedBy,omitempty"`
}

package config

import "time"

type Config struct {
	SlackAgent      ServiceConfig
	MeetingAgent    ServiceConfig
	Slack           SlackConfig
	AgentRunner     AgentRunnerConfig
	Meetd           MeetdConfig
	OpenAI          OpenAIConfig
	Dialog          DialogConfig
	Logging         LoggingConfig
	Paths           PathsConfig
	Persistence     PersistenceConfig
	ConfigFilePath  string
	SecretsFilePath string
}

type ServiceConfig struct {
	Listen         string
	AllowedOrigins []string
}

type LoggingConfig struct {
	Level  string
	Format string
}

type SlackConfig struct {
	SigningSecret   string
	BotToken        string
	AppToken        string
	BotUserID       string
	ClientID        string
	ClientSecret    string
	RedirectURI     string
	WorkspaceDir    string
	InternalAuthKey string
	PublicBaseURL   string
	EventBuffer     SlackEventBufferConfig
	Triage          SlackTriageConfig
	Memory          SlackMemoryConfig
}

type SlackEventBufferConfig struct {
	Enabled  bool
	Triage   bool
	MaxBatch int
	Debounce time.Duration
}

type SlackTriageConfig struct {
	PostActions       bool
	HeuristicFallback bool
}

type SlackMemoryConfig struct {
	Enabled bool
	Dir     string
}

type AgentRunnerConfig struct {
	Provider   string
	DryRun     bool
	JobTimeout time.Duration
	Codex      CodexRunnerConfig
	Claude     ClaudeRunnerConfig
	Ollama     OllamaRunnerConfig
}

type MeetdConfig struct {
	WatchInterval   time.Duration
	WebhookURL      string
	WebhookSecret   string
	CaptureCaptions bool
	CaptionLanguage string
	SummaryModel    string
	CalibrateModel  string
	ASRProvider     string
	ASRModel        string
	ASRLanguage     string
	GeminiAPIKey    string
	GeminiASRModel  string
}

type OpenAIConfig struct {
	APIKey                     string
	BaseURL                    string
	AudioTranscriptionsURL     string
	RealtimeClientSecretsURL   string
	RealtimeSDPURL             string
	RealtimeModel              string
	RealtimeReasoningEffort    string
	RealtimeVoice              string
	RealtimeTurnDetection      string
	RealtimeSessionSchema      string
	RealtimeAgentRuntime       string
	RealtimePersonalityContext string
	BotName                    string
	CurrentUserName            string
	CurrentUserEnglishName     string
	CurrentUserEmail           string
	CurrentUserLinear          string
	CurrentUserGitHub          string
	CurrentUserRole            string
}

type DialogConfig struct {
	STTProvider string
	TTSProvider string
	TTSVoice    string
	TTSCommand  string
	TTSHTTPURL  string
}

type CodexRunnerConfig struct {
	Bin           string
	Model         string
	Sandbox       string
	ModelProvider string
	BaseURL       string
	EnvKey        string
	WireAPI       string
}

type ClaudeRunnerConfig struct {
	Bin                 string
	Model               string
	ReadPermissionMode  string
	WritePermissionMode string
	MaxBudgetUSD        string
}

type OllamaRunnerConfig struct {
	BaseURL string
	Model   string
}

type PathsConfig struct {
	MeetRunnerDir string
}

type PersistenceConfig struct {
	Provider   string
	DataDir    string
	SQLitePath string
}

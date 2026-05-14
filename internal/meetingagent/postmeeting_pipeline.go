package meetingagent

import (
	"net/http"
	"strings"
	"time"

	"github.com/AFK-surf/oneesama/internal/postmeeting"
	appconfig "github.com/AFK-surf/oneesama/pkg/config"
)

func newPostMeetingPipeline(rootDir string, meetd appconfig.MeetdConfig, openai appconfig.OpenAIConfig, client *http.Client) *postmeeting.Pipeline {
	providerClient := client
	if providerClient == nil {
		providerClient = &http.Client{Timeout: 2 * time.Minute}
	}
	options := make([]postmeeting.PipelineOption, 0, 2)
	if asr := postmeeting.NewConfiguredASRProvider(postmeeting.ASRProviderConfig{
		Provider:                     meetd.ASRProvider,
		Model:                        meetd.ASRModel,
		Language:                     meetd.ASRLanguage,
		OpenAIAPIKey:                 openai.APIKey,
		OpenAIBaseURL:                openai.BaseURL,
		OpenAIAudioTranscriptionsURL: openai.AudioTranscriptionsURL,
		GeminiAPIKey:                 meetd.GeminiAPIKey,
		GeminiModel:                  firstNonEmpty(meetd.GeminiASRModel, meetd.ASRModel),
		HTTPClient:                   providerClient,
	}); asr != nil {
		options = append(options, postmeeting.WithASRProvider(asr))
	}
	if strings.TrimSpace(meetd.SummaryModel) != "" && strings.TrimSpace(openai.APIKey) != "" {
		options = append(options, postmeeting.WithSummarizer(&postmeeting.LLMSummarizer{
			SummaryModel:   meetd.SummaryModel,
			CalibrateModel: meetd.CalibrateModel,
			NewClient: postmeeting.NewOpenAIChatClientFactory(postmeeting.OpenAIChatConfig{
				APIKey:     openai.APIKey,
				BaseURL:    openai.BaseURL,
				HTTPClient: providerClient,
			}),
		}))
	}
	return postmeeting.NewPipeline(rootDir, options...)
}

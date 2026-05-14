package meetingagent

import (
	"context"

	"github.com/AFK-surf/oneesama/internal/postmeeting"
)

func (s *Service) PostProcessMeeting(ctx context.Context, input postmeeting.PostProcessInput) (postmeeting.PostProcessResult, error) {
	return s.pipeline.PostProcess(ctx, input)
}

func (s *Service) ListArtifacts() ([]postmeeting.ArtifactManifest, error) {
	return s.pipeline.ListArtifacts()
}

func (s *Service) GetArtifact(id string) (*postmeeting.ArtifactManifest, error) {
	return s.pipeline.GetArtifact(id)
}

func (s *Service) GetArtifactChat(id string) (*postmeeting.ChatArtifact, error) {
	return s.pipeline.GetArtifactChat(id)
}

func (s *Service) SendDigestWebhook(ctx context.Context, request postmeeting.DigestWebhookRequest) (postmeeting.DigestWebhookResult, error) {
	return s.webhookSender.Send(ctx, request)
}

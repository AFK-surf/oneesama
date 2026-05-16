package meetingagent

import (
	"context"
	"errors"
	"strings"

	"github.com/AFK-surf/oneesama/internal/meetrunner"
)

func (s *Service) StartScreenShare(ctx context.Context, input ScreenShareRequest) (meetrunner.ScreenShareResult, error) {
	sessionID, err := s.resolveScreenShareSessionID(ctx, input.SessionID)
	if err != nil {
		return nil, err
	}
	return s.meetRunner.StartScreenShare(ctx, meetrunner.ScreenShareInput{
		SessionID: sessionID,
		Title:     firstNonEmpty(input.Title, input.ScreenShareTitle),
		Subtitle:  firstNonEmpty(input.Subtitle, input.ScreenShareSubtitle),
		Preview:   input.Preview,
		Mode:      firstNonEmpty(input.Mode, input.ScreenShareMode),
		WaitMs:    input.WaitMs,
	})
}

func (s *Service) PresentScreenShare(ctx context.Context, input ScreenShareRequest) (meetrunner.ScreenShareResult, error) {
	sessionID, err := s.resolveScreenShareSessionID(ctx, input.SessionID)
	if err != nil {
		return nil, err
	}
	return s.meetRunner.PresentScreenShare(ctx, meetrunner.ScreenShareInput{
		SessionID: sessionID,
		Title:     firstNonEmpty(input.Title, input.ScreenShareTitle),
		Subtitle:  firstNonEmpty(input.Subtitle, input.ScreenShareSubtitle),
		Preview:   input.Preview,
		Mode:      firstNonEmpty(input.Mode, input.ScreenShareMode),
		WaitMs:    input.WaitMs,
	})
}

func (s *Service) PresentVideoStage(ctx context.Context, input VideoStageRequest) (meetrunner.ScreenShareResult, error) {
	sessionID, err := s.resolveScreenShareSessionID(ctx, input.SessionID)
	if err != nil {
		return nil, err
	}
	muted := true
	if input.Muted != nil {
		muted = *input.Muted
	}
	return s.meetRunner.PresentVideoStage(ctx, meetrunner.VideoStageInput{
		ScreenShareInput: meetrunner.ScreenShareInput{
			SessionID: sessionID,
			Title:     firstNonEmpty(input.Title, input.ScreenShareTitle, "Onee Sama video stage"),
			Subtitle:  firstNonEmpty(input.Subtitle, input.ScreenShareSubtitle, "Shared by Onee Sama"),
			Mode:      firstNonEmpty(input.Mode, input.ScreenShareMode, "synthetic"),
			WaitMs:    input.WaitMs,
		},
		VideoURL:   firstNonEmpty(input.VideoURL, input.URL, input.Path),
		StageTitle: firstNonEmpty(input.StageTitle, "Meeting Avatar Bot"),
		Width:      firstNonZero(input.Width, input.ScreenShareWidth, 1280),
		Height:     firstNonZero(input.Height, input.ScreenShareHeight, 720),
		Muted:      muted,
	})
}

func (s *Service) ListShareableApps(ctx context.Context, input ShareableAppsRequest) (meetrunner.ScreenShareResult, error) {
	sessionID, err := s.resolveScreenShareSessionID(ctx, input.SessionID)
	if err != nil {
		return nil, err
	}
	return s.meetRunner.ListShareableApps(ctx, meetrunner.ShareableAppsInput{SessionID: sessionID})
}

func (s *Service) PresentAppShare(ctx context.Context, input AppShareRequest) (meetrunner.ScreenShareResult, error) {
	sessionID, err := s.resolveScreenShareSessionID(ctx, input.SessionID)
	if err != nil {
		return nil, err
	}
	return s.meetRunner.PresentAppShare(ctx, meetrunner.AppShareInput{
		ScreenShareInput: meetrunner.ScreenShareInput{
			SessionID: sessionID,
			Title:     firstNonEmpty(input.Title, input.ScreenShareTitle),
			Subtitle:  firstNonEmpty(input.Subtitle, input.ScreenShareSubtitle),
			Preview:   input.Preview,
			Mode:      firstNonEmpty(input.Mode, input.ScreenShareMode),
			WaitMs:    input.WaitMs,
		},
		ProcessID:        firstNonZero(input.ProcessID, input.PID),
		PID:              input.PID,
		BundleIdentifier: firstNonEmpty(input.BundleIdentifier, input.BundleID),
		BundleID:         input.BundleID,
		ApplicationName:  firstNonEmpty(input.ApplicationName, input.AppName, input.Name),
		AppName:          input.AppName,
		Name:             input.Name,
	})
}

func (s *Service) StopScreenShare(ctx context.Context, input ScreenShareRequest) (meetrunner.ScreenShareResult, error) {
	sessionID, err := s.resolveScreenShareSessionID(ctx, input.SessionID)
	if err != nil {
		return nil, err
	}
	return s.meetRunner.StopScreenShare(ctx, meetrunner.ScreenShareInput{SessionID: sessionID})
}

func (s *Service) resolveScreenShareSessionID(ctx context.Context, sessionID string) (string, error) {
	session, err := s.resolveJoinSession(ctx, sessionID)
	if err != nil {
		return "", err
	}
	if session == nil {
		return "", errNoActiveJoin()
	}
	return strings.TrimSpace(session.ID), nil
}

func firstNonZero(values ...int) int {
	for _, value := range values {
		if value != 0 {
			return value
		}
	}
	return 0
}

func errNoActiveJoin() error {
	return errors.New("no_active_join")
}

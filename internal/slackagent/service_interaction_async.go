package slackagent

import (
	"context"
	"strings"
)

// LaunchAsyncInteraction is the standard ack-first wrapper for Slack
// Socket Mode interaction handlers and Events API webhooks. It spawns
// `work` on a goroutine with the cancellation-detached context so the
// caller can immediately ack Slack without being blocked by the work.
//
// Why this exists: Slack Socket Mode requires an ack within ~3 seconds.
// Any synchronous HTTP call (e.g. postSlackInteractionResponse against
// the user's `response_url`), agent runner spawn, or meeting-agent join
// request can easily exceed that window — causing Slack to resend the
// envelope and the user to see "the button did nothing" + a duplicate
// invocation. The 5/18 live join incident (commits c0ac26e + 3bbaa91)
// was exactly this class of bug: synchronous response_url update was
// blocking the ack path.
//
// Discipline:
//   - Any handler whose work could exceed ~500ms MUST go through this
//     helper or spawn its own goroutine BEFORE returning to the ack.
//   - The label argument flows into the structured log so operators can
//     trace which handler launched the goroutine after a deploy.
//   - The work function must NOT block on a channel it expects the
//     caller to drain; it owns its own lifecycle.
func (s *Service) LaunchAsyncInteraction(ctx context.Context, label string, work func(context.Context)) {
	if work == nil {
		return
	}
	detached := context.WithoutCancel(ctx)
	if s != nil && s.logger != nil {
		s.logger.Info("slack interaction async launch", "handler", strings.TrimSpace(label))
	}
	go work(detached)
}

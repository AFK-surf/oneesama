package slackagent

import (
	"context"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"time"
)

func (s *Service) InboundStatus() SlackInboundState {
	return s.inbound.Snapshot()
}

func (s *Service) BufferSlackInboundEvent(ctx context.Context, envelope SlackEventEnvelope, event SlackEventPayload) SlackInboundBufferResult {
	message := slackInboundMessageFromEvent(envelope, event)
	result := s.inbound.Buffer(message)
	if result.Buffered {
		if err := s.cognition.RecordInbound(ctx, firstNonEmpty(envelope.TeamID, "workspace"), message); err != nil {
			s.logger.Warn("slack cognition inbound record failed", "channel", event.Channel, "error", err)
		}
		s.maybeRecordInboundImprovementSignal(ctx, message)
	}
	return result
}

func slackInboundMessageFromEvent(envelope SlackEventEnvelope, event SlackEventPayload) SlackInboundMessage {
	message := SlackInboundMessage{
		TeamID:      envelope.TeamID,
		ChannelID:   event.Channel,
		ChannelType: event.ChannelType,
		UserID:      event.User,
		BotID:       event.BotID,
		Subtype:     event.Subtype,
		Text:        strings.TrimSpace(event.Text),
		TS:          firstNonEmpty(event.TS, event.EventTS),
		EventTS:     firstNonEmpty(event.EventTS, event.TS),
		ThreadTS:    event.ThreadTS,
	}
	if event.Message == nil {
		return normalizeSlackInboundMessage(message)
	}
	nested := event.Message
	message.ChannelID = firstNonEmpty(nested.Channel, message.ChannelID)
	message.UserID = firstNonEmpty(nested.User, nested.UserID, nested.UserIDCamel, message.UserID)
	message.BotID = firstNonEmpty(nested.BotID, message.BotID)
	message.Subtype = firstNonEmpty(nested.Subtype, message.Subtype)
	message.Text = strings.TrimSpace(firstNonEmpty(nested.Text, message.Text))
	message.TS = firstNonEmpty(nested.TS, nested.EventTS, message.TS)
	message.EventTS = firstNonEmpty(nested.EventTS, message.EventTS, nested.TS)
	message.ThreadTS = firstNonEmpty(nested.ThreadTS, message.ThreadTS)
	if len(nested.Files) > 0 {
		message.Files = append([]SlackFile(nil), nested.Files...)
	}
	return normalizeSlackInboundMessage(message)
}

func (s *Service) FlushSlackInbound(ctx context.Context, channelID string) ([]SlackInboundFlushResult, error) {
	var channels []string
	if strings.TrimSpace(channelID) != "" {
		channels = []string{strings.TrimSpace(channelID)}
	} else {
		channels = s.inbound.ChannelIDs()
	}
	results := make([]SlackInboundFlushResult, 0, len(channels))
	for _, channel := range channels {
		result, err := s.flushSlackInboundChannel(ctx, channel)
		if err != nil {
			return nil, err
		}
		if result != nil {
			results = append(results, *result)
		}
	}
	return results, nil
}

func (s *Service) flushSlackInboundChannel(ctx context.Context, channelID string) (*SlackInboundFlushResult, error) {
	return s.flushSlackInboundChannelWithContext(ctx, channelID, nil)
}

func (s *Service) flushSlackInboundChannelWithContext(ctx context.Context, channelID string, contextMessages []SlackInboundMessage) (*SlackInboundFlushResult, error) {
	messages := s.inbound.Drain(channelID)
	if len(messages) == 0 {
		return nil, nil
	}
	sort.Slice(messages, func(i, j int) bool {
		return slackTSLess(messages[i].TS, messages[j].TS)
	})
	sort.Slice(contextMessages, func(i, j int) bool {
		return slackTSLess(contextMessages[i].TS, contextMessages[j].TS)
	})
	digest := renderSlackActivityDigestWithContext(channelID, contextMessages, messages)
	s.inbound.RecordFlush(channelID, len(messages))
	_, err := s.rememberInboundDigest(ctx, channelID, digest, len(messages))
	if err != nil {
		return nil, err
	}
	triage := SlackInboundTriageResult{
		Enabled: s.inbound.Snapshot().EventBuffer.TriageEnabled,
	}
	if triage.Enabled {
		started, err := s.StartSlackTriage(ctx, channelID, messages, digest)
		if err != nil {
			return nil, err
		}
		triage.Run = started.Run
		triage.Job = started.Job
		triage.Finalization = started.Finalization
	} else {
		run, err := s.recordSlackTriageOnly(ctx, channelID, messages, digest)
		if err != nil {
			return nil, err
		}
		triage.Skipped = true
		triage.Reason = "triage_disabled"
		triage.Summary = fmt.Sprintf("Buffered %d Slack message(s) for %s", len(messages), channelID)
		triage.Run = run
	}
	result := SlackInboundFlushResult{
		ChannelID:       channelID,
		Messages:        messages,
		ContextMessages: contextMessages,
		Count:           len(messages),
		Digest:          digest,
		Triage:          &triage,
	}
	return &result, nil
}

func (s *Service) SweepSlackScanner(ctx context.Context, request SlackScannerSweepRequest) SlackScannerSweepResult {
	workspaceID := firstNonEmpty(request.WorkspaceID, request.WorkspaceIDSnake, request.TeamID, "workspace")
	channels := normalizeScannerChannels(request)
	if len(channels) == 0 {
		return SlackScannerSweepResult{OK: false, WorkspaceID: workspaceID, Error: "channel_required", Inbound: s.InboundStatus()}
	}
	results := make([]SlackScannerChannelResult, 0, len(channels))
	flush := request.Flush == nil || *request.Flush
	for _, channel := range channels {
		buffered := 0
		previousCursor := s.inbound.Cursor(channel.ID)
		nextCursor := previousCursor
		for _, message := range channel.Messages {
			message = normalizeSlackInboundMessage(message)
			message.TeamID = firstNonEmpty(message.TeamID, workspaceID)
			message.ChannelID = firstNonEmpty(message.ChannelID, channel.ID)
			message.ChannelType = firstNonEmpty(message.ChannelType, channel.Type)
			message.TS = firstNonEmpty(message.TS, message.EventTS)
			message.EventTS = firstNonEmpty(message.EventTS, message.TS)
			if shouldIgnoreScannerInboundMessage(message, s.botUserID) {
				continue
			}
			if previousCursor != "" && !slackTSGreater(message.TS, previousCursor) {
				continue
			}
			if s.inbound.Buffer(message).Buffered {
				buffered++
				if err := s.cognition.RecordInbound(ctx, workspaceID, message); err != nil {
					s.logger.Warn("slack cognition inbound record failed", "channel", channel.ID, "error", err)
				}
				s.maybeRecordInboundImprovementSignal(ctx, message)
			}
			if slackTSGreater(message.TS, nextCursor) {
				nextCursor = message.TS
			}
		}
		if nextCursor != previousCursor {
			s.inbound.SetCursor(channel.ID, nextCursor)
		}
		var flushed *SlackInboundFlushResult
		if flush && buffered > 0 {
			value, err := s.flushSlackInboundChannelWithContext(ctx, channel.ID, normalizeScannerContextMessages(workspaceID, channel, channel.ContextMessages))
			if err != nil {
				results = append(results, SlackScannerChannelResult{ChannelID: channel.ID, OK: false, Error: err.Error(), PreviousCursor: previousCursor, NextCursor: nextCursor, Scanned: len(channel.Messages), Buffered: buffered})
				continue
			}
			if value != nil {
				flushed = value
			}
		}
		results = append(results, SlackScannerChannelResult{ChannelID: channel.ID, OK: true, Source: "fixture", PreviousCursor: previousCursor, NextCursor: nextCursor, Scanned: len(channel.Messages), Buffered: buffered, Flushed: flushed})
	}
	ok := true
	for _, result := range results {
		ok = ok && result.OK
	}
	return SlackScannerSweepResult{OK: ok, WorkspaceID: workspaceID, Sweeps: results, Inbound: s.InboundStatus()}
}

func normalizeScannerContextMessages(workspaceID string, channel SlackScannerChannel, messages []SlackInboundMessage) []SlackInboundMessage {
	out := make([]SlackInboundMessage, 0, len(messages))
	for _, message := range messages {
		message = normalizeSlackInboundMessage(message)
		message.TeamID = firstNonEmpty(message.TeamID, workspaceID)
		message.ChannelID = firstNonEmpty(message.ChannelID, channel.ID)
		message.ChannelType = firstNonEmpty(message.ChannelType, channel.Type)
		message.TS = firstNonEmpty(message.TS, message.EventTS)
		message.EventTS = firstNonEmpty(message.EventTS, message.TS)
		if shouldIgnoreScannerInboundMessage(message, "") {
			continue
		}
		out = append(out, message)
	}
	return out
}

func (s *Service) rememberInboundDigest(ctx context.Context, channelID string, digest string, count int) (*SlackContextRecord, error) {
	if s.slackContext == nil {
		return nil, nil
	}
	return s.slackContext.Remember(ctx, AvatarCommandInput{
		TeamID:      "workspace",
		ChannelID:   channelID,
		ThreadTS:    "channel-root",
		UserID:      "slack-event-buffer",
		UserName:    "slack-event-buffer",
		Command:     "socket_message_buffer",
		Text:        digest,
		ChannelName: channelID,
	}, parsedAvatarCommand{Action: "slack_activity", Task: fmt.Sprintf("Buffered Slack digest with %d message(s).", count)}, nil)
}

func normalizeScannerChannels(request SlackScannerSweepRequest) []SlackScannerChannel {
	if len(request.Channels) > 0 {
		return request.Channels
	}
	channelID := firstNonEmpty(request.ChannelID, request.Channel)
	if channelID == "" {
		return nil
	}
	return []SlackScannerChannel{{
		ID:       channelID,
		Name:     channelID,
		Type:     "channel",
		Messages: request.Messages,
	}}
}

func slackTSLess(a string, b string) bool {
	return slackTSGreater(b, a)
}

func slackTSGreater(a string, b string) bool {
	a = strings.TrimSpace(a)
	b = strings.TrimSpace(b)
	if a == "" {
		return false
	}
	if b == "" {
		return true
	}
	aSec, aSeq, aOK := parseSlackTSParts(a)
	bSec, bSeq, bOK := parseSlackTSParts(b)
	if aOK && bOK {
		if aSec != bSec {
			return aSec > bSec
		}
		return aSeq > bSeq
	}
	aTime, aErr := time.Parse(time.RFC3339Nano, a)
	bTime, bErr := time.Parse(time.RFC3339Nano, b)
	if aErr == nil && bErr == nil {
		return aTime.After(bTime)
	}
	return strings.Compare(a, b) > 0
}

func parseSlackTSParts(ts string) (int64, int64, bool) {
	parts := strings.SplitN(ts, ".", 2)
	sec, err := strconv.ParseInt(parts[0], 10, 64)
	if err != nil {
		return 0, 0, false
	}
	var seq int64
	if len(parts) > 1 {
		value, err := strconv.ParseInt(parts[1], 10, 64)
		if err != nil {
			return 0, 0, false
		}
		seq = value
	}
	return sec, seq, true
}

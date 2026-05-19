package slackagent

import (
	"fmt"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	appconfig "github.com/AFK-surf/oneesama/pkg/config"
)

const (
	slackInboundDefaultMaxBatch = 10
	slackInboundDefaultDebounce = 5 * time.Minute
	slackInboundConversationGap = 5 * time.Minute
)

type slackInboundBuffer struct {
	mu          sync.Mutex
	channels    map[string]*slackInboundChannelBuffer
	triagedSets map[string]map[string]struct{}
	state       SlackEventBufferState
	maxBatch    int
	debounce    time.Duration
	onFlush     func(channelID string)
}

type slackInboundChannelBuffer struct {
	messages []SlackInboundMessage
	timer    *time.Timer
}

func newSlackInboundBuffer(cfg appconfig.SlackEventBufferConfig, onFlush func(channelID string)) *slackInboundBuffer {
	maxBatch := cfg.MaxBatch
	if maxBatch <= 0 {
		maxBatch = slackInboundDefaultMaxBatch
	}
	debounce := cfg.Debounce
	if debounce <= 0 {
		debounce = slackInboundDefaultDebounce
	}
	return &slackInboundBuffer{
		channels:    make(map[string]*slackInboundChannelBuffer),
		triagedSets: make(map[string]map[string]struct{}),
		state: SlackEventBufferState{
			Enabled:       cfg.Enabled,
			TriageEnabled: cfg.Triage,
			Channels:      make(map[string]SlackInboundChannelState),
		},
		maxBatch: maxBatch,
		debounce: debounce,
		onFlush:  onFlush,
	}
}

func (b *slackInboundBuffer) Buffer(message SlackInboundMessage) SlackInboundBufferResult {
	message = normalizeSlackInboundMessage(message)
	if b == nil || !b.state.Enabled {
		return SlackInboundBufferResult{Buffered: false, Ignored: true, Reason: "event_buffer_disabled"}
	}
	if shouldIgnoreInboundMessage(message) {
		return SlackInboundBufferResult{Buffered: false, Ignored: true, Reason: "ignored_message"}
	}
	b.mu.Lock()
	defer b.mu.Unlock()

	channel := b.channels[message.ChannelID]
	if channel == nil {
		channel = &slackInboundChannelBuffer{}
		b.channels[message.ChannelID] = channel
	}
	channel.messages = append(channel.messages, message)
	if channel.timer != nil {
		channel.timer.Stop()
	}
	b.state.BufferedMessages++
	b.state.LastBufferedAt = nowRFC3339()
	b.state.Channels[message.ChannelID] = SlackInboundChannelState{
		Pending:       len(channel.messages),
		LastUpdatedAt: b.state.LastBufferedAt,
		Cursor:        b.state.Channels[message.ChannelID].Cursor,
	}
	pending := len(channel.messages)
	if b.onFlush == nil {
		return SlackInboundBufferResult{Buffered: true, ChannelID: message.ChannelID, Pending: pending}
	}
	if pending >= b.maxBatch {
		go b.onFlush(message.ChannelID)
	} else {
		channelID := message.ChannelID
		channel.timer = time.AfterFunc(b.debounce, func() {
			go b.onFlush(channelID)
		})
	}
	return SlackInboundBufferResult{Buffered: true, ChannelID: message.ChannelID, Pending: pending}
}

func normalizeSlackInboundMessage(message SlackInboundMessage) SlackInboundMessage {
	message.TeamID = firstNonEmpty(message.TeamID, message.TeamIDSnake)
	message.ChannelID = firstNonEmpty(message.ChannelID, message.ChannelIDSnake)
	message.ChannelType = normalizeObservedChannelType(firstNonEmpty(message.ChannelType, message.ChannelTypeSnake))
	message.UserID = firstNonEmpty(message.UserID, message.UserIDSnake, message.User)
	message.BotID = firstNonEmpty(message.BotID, message.BotIDSnake)
	message.TS = firstNonEmpty(message.TS, message.EventTS, message.EventTSSnake)
	message.EventTS = firstNonEmpty(message.EventTS, message.EventTSSnake, message.TS)
	message.ThreadTS = firstNonEmpty(message.ThreadTS, message.ThreadTSSnake)
	message.TeamIDSnake = ""
	message.ChannelIDSnake = ""
	message.ChannelTypeSnake = ""
	message.UserIDSnake = ""
	message.User = ""
	message.BotIDSnake = ""
	message.EventTSSnake = ""
	message.ThreadTSSnake = ""
	return message
}

func (b *slackInboundBuffer) Drain(channelID string) []SlackInboundMessage {
	if b == nil {
		return nil
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	channel := b.channels[channelID]
	if channel == nil || len(channel.messages) == 0 {
		return nil
	}
	messages := append([]SlackInboundMessage(nil), channel.messages...)
	channel.messages = nil
	if channel.timer != nil {
		channel.timer.Stop()
		channel.timer = nil
	}
	b.state.Channels[channelID] = SlackInboundChannelState{
		Pending:       0,
		LastUpdatedAt: nowRFC3339(),
		Cursor:        b.state.Channels[channelID].Cursor,
	}
	return messages
}

func (b *slackInboundBuffer) Cursor(channelID string) string {
	if b == nil {
		return ""
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.state.Channels[channelID].Cursor
}

func (b *slackInboundBuffer) SetCursor(channelID string, cursor string) {
	if b == nil || strings.TrimSpace(channelID) == "" || strings.TrimSpace(cursor) == "" {
		return
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	state := b.state.Channels[channelID]
	if state.Cursor == "" || slackTSGreater(cursor, state.Cursor) {
		state.Cursor = cursor
		state.LastUpdatedAt = nowRFC3339()
		b.state.Channels[channelID] = state
	}
}

func (b *slackInboundBuffer) markTriaged(channelID string, timestamps []string) {
	if b == nil || strings.TrimSpace(channelID) == "" {
		return
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	set := b.triagedSets[channelID]
	if set == nil {
		set = make(map[string]struct{}, len(timestamps))
		b.triagedSets[channelID] = set
	}
	for _, timestamp := range timestamps {
		if trimmed := strings.TrimSpace(timestamp); trimmed != "" {
			set[trimmed] = struct{}{}
		}
	}
}

func (b *slackInboundBuffer) findMissed(channelID string, messages []SlackInboundMessage) []SlackInboundMessage {
	if b == nil || strings.TrimSpace(channelID) == "" {
		return nil
	}
	b.mu.Lock()
	set := b.triagedSets[channelID]
	b.mu.Unlock()
	if len(set) == 0 {
		return append([]SlackInboundMessage(nil), messages...)
	}
	var missed []SlackInboundMessage
	for _, message := range messages {
		timestamp := firstNonEmpty(message.TS, message.EventTS)
		if _, ok := set[timestamp]; !ok {
			missed = append(missed, message)
		}
	}
	return missed
}

func (b *slackInboundBuffer) pruneTriagedBefore(channelID string, cursor string) {
	if b == nil || strings.TrimSpace(channelID) == "" || strings.TrimSpace(cursor) == "" {
		return
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	set := b.triagedSets[channelID]
	for timestamp := range set {
		if !slackTSGreater(timestamp, cursor) {
			delete(set, timestamp)
		}
	}
	if len(set) == 0 {
		delete(b.triagedSets, channelID)
	}
}

func (b *slackInboundBuffer) inject(channelID string, messages []SlackInboundMessage) {
	if b == nil || strings.TrimSpace(channelID) == "" || len(messages) == 0 {
		return
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	b.injectLocked(channelID, messages)
}

func (b *slackInboundBuffer) injectAndScheduleRetry(channelID string, messages []SlackInboundMessage, retry func()) {
	if b == nil || strings.TrimSpace(channelID) == "" || len(messages) == 0 {
		return
	}
	b.mu.Lock()
	b.injectLocked(channelID, messages)
	channel := b.channels[channelID]
	if channel.timer != nil {
		channel.timer.Stop()
	}
	if retry != nil {
		channel.timer = time.AfterFunc(b.debounce, retry)
	}
	b.mu.Unlock()
}

func (b *slackInboundBuffer) reconcileHistory(channelID string, history []SlackInboundMessage, pendingCursor string, retry func()) SlackScannerReconcileResult {
	if b == nil || strings.TrimSpace(channelID) == "" {
		return SlackScannerReconcileResult{}
	}
	missed := b.findMissed(channelID, history)
	result := SlackScannerReconcileResult{
		ChannelID:     channelID,
		PendingCursor: pendingCursor,
		HistoryCount:  len(history),
		MissedCount:   len(missed),
	}
	if len(missed) == 0 {
		if pendingCursor != "" {
			b.SetCursor(channelID, pendingCursor)
			b.pruneTriagedBefore(channelID, pendingCursor)
			result.CommittedCursor = b.Cursor(channelID)
		}
		return result
	}
	b.injectAndScheduleRetry(channelID, missed, retry)
	return result
}

func (b *slackInboundBuffer) injectLocked(channelID string, messages []SlackInboundMessage) {
	channel := b.channels[channelID]
	if channel == nil {
		channel = &slackInboundChannelBuffer{}
		b.channels[channelID] = channel
	}
	for _, message := range messages {
		message = normalizeSlackInboundMessage(message)
		message.ChannelID = firstNonEmpty(message.ChannelID, channelID)
		channel.messages = append(channel.messages, message)
	}
	state := b.state.Channels[channelID]
	state.Pending = len(channel.messages)
	state.LastUpdatedAt = nowRFC3339()
	b.state.Channels[channelID] = state
}

func (b *slackInboundBuffer) ChannelIDs() []string {
	if b == nil {
		return nil
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	ids := make([]string, 0, len(b.channels))
	for id, channel := range b.channels {
		if channel != nil && len(channel.messages) > 0 {
			ids = append(ids, id)
		}
	}
	sort.Strings(ids)
	return ids
}

func (b *slackInboundBuffer) RecordFlush(channelID string, count int) {
	if b == nil {
		return
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	b.state.Flushes++
	b.state.LastFlushAt = nowRFC3339()
	b.state.LastFlushChannel = channelID
	b.state.LastFlushCount = count
}

func (b *slackInboundBuffer) SetLastTriageJob(id string) {
	if b == nil || id == "" {
		return
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	b.state.LastTriageJobID = id
}

func (b *slackInboundBuffer) Snapshot() SlackInboundState {
	if b == nil {
		return SlackInboundState{}
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	state := b.state
	state.Channels = make(map[string]SlackInboundChannelState, len(b.state.Channels))
	for key, value := range b.state.Channels {
		state.Channels[key] = value
	}
	return SlackInboundState{EventBuffer: state}
}

func renderSlackActivityDigest(channelID string, messages []SlackInboundMessage) string {
	return renderSlackActivityDigestWithContext(channelID, nil, messages)
}

func renderSlackActivityDigestWithContext(channelID string, contextMessages []SlackInboundMessage, messages []SlackInboundMessage) string {
	lines := []string{"=== Slack Activity ===", "", "#" + channelID}
	if len(contextMessages) > 0 {
		for _, message := range contextMessages {
			message = normalizeSlackInboundMessage(message)
			text := strings.TrimSpace(message.Text)
			if text == "" && len(message.Files) > 0 {
				text = slackInboundFileSummary(message.Files)
			}
			lines = append(lines, fmt.Sprintf("  (context) %s: %q", slackInboundResolveName(message.UserID), truncateString(resolveTextMentions(text, slackInboundResolveName), 150)))
		}
		lines = append(lines, "  --- new messages ---")
	}
	refCounter := 0
	for _, group := range groupSlackInboundMessagesByTime(messages, slackInboundConversationGap) {
		if len(group) == 1 {
			refCounter++
			lines = append(lines, "  "+formatSlackInboundMessageLine(group[0], fmt.Sprintf("m%d", refCounter)))
			continue
		}
		lines = append(lines, "  --- conversation ---")
		for _, message := range group {
			refCounter++
			lines = append(lines, "    "+formatSlackInboundMessageLine(message, fmt.Sprintf("m%d", refCounter)))
		}
		lines = append(lines, "  ---")
	}
	return strings.Join(lines, "\n") + "\n"
}

func formatSlackInboundMessageLine(message SlackInboundMessage, ref string) string {
	message = normalizeSlackInboundMessage(message)
	return formatMessageLine(SlackMessage{
		TS:         message.TS,
		EventTS:    message.EventTS,
		User:       message.UserID,
		UserID:     message.UserID,
		BotID:      message.BotID,
		Subtype:    message.Subtype,
		Text:       message.Text,
		ThreadTS:   message.ThreadTS,
		ReplyCount: message.ReplyCount,
		ReplyUsers: append([]string(nil), message.ReplyUsers...),
		Files:      append([]SlackFile(nil), message.Files...),
		Reactions:  append([]SlackReaction(nil), message.Reactions...),
	}, slackInboundResolveName, ref)
}

func slackInboundResolveName(userID string) string {
	userID = strings.TrimSpace(userID)
	if userID == "" {
		return "<@unknown>"
	}
	return "<@" + userID + ">"
}

func groupSlackInboundMessagesByTime(messages []SlackInboundMessage, gap time.Duration) [][]SlackInboundMessage {
	if len(messages) == 0 {
		return nil
	}
	groups := [][]SlackInboundMessage{{messages[0]}}
	for i := 1; i < len(messages); i++ {
		previous := parseSlackTime(firstNonEmpty(messages[i-1].TS, messages[i-1].EventTS))
		current := parseSlackTime(firstNonEmpty(messages[i].TS, messages[i].EventTS))
		if !previous.IsZero() && !current.IsZero() && current.Sub(previous) > gap {
			groups = append(groups, []SlackInboundMessage{messages[i]})
			continue
		}
		groups[len(groups)-1] = append(groups[len(groups)-1], messages[i])
	}
	return groups
}

func parseSlackTime(ts string) time.Time {
	ts = strings.TrimSpace(ts)
	if parsed, err := time.Parse(time.RFC3339Nano, ts); err == nil {
		return parsed
	}
	parts := strings.SplitN(ts, ".", 2)
	sec, err := strconv.ParseInt(parts[0], 10, 64)
	if err != nil {
		return time.Time{}
	}
	return time.Unix(sec, 0)
}

func renderLegacySlackActivityDigest(channelID string, messages []SlackInboundMessage) string {
	lines := []string{"=== Slack Activity ===", "", "#" + channelID}
	for _, message := range messages {
		thread := ""
		if message.ThreadTS != "" {
			thread = " thread=" + message.ThreadTS
		}
		text := strings.TrimSpace(message.Text)
		if text == "" && len(message.Files) > 0 {
			text = slackInboundFileSummary(message.Files)
		}
		lines = append(lines, fmt.Sprintf("- %s <@%s>%s: %s", firstNonEmpty(message.TS, nowRFC3339()), message.UserID, thread, text))
	}
	return strings.Join(lines, "\n") + "\n"
}

func shouldIgnoreInboundMessage(message SlackInboundMessage) bool {
	return shouldIgnoreScannerInboundMessage(message, "")
}

func shouldIgnoreScannerInboundMessage(message SlackInboundMessage, botUserID string) bool {
	return shouldIgnoreScannerInboundMessageForBotIDs(message, []string{botUserID})
}

func shouldIgnoreScannerInboundMessageForBotIDs(message SlackInboundMessage, botUserIDs []string) bool {
	message = normalizeSlackInboundMessage(message)
	if strings.TrimSpace(message.ChannelID) == "" {
		return true
	}
	if strings.TrimSpace(message.BotID) != "" {
		return true
	}
	if strings.TrimSpace(message.UserID) == "" {
		return true
	}
	subtype := strings.TrimSpace(message.Subtype)
	if subtype != "" && subtype != "file_share" {
		return true
	}
	text := strings.TrimSpace(message.Text)
	if slackTextMentionsAnyUser(text, botUserIDs) {
		return true
	}
	return text == "" && len(message.Files) == 0
}

func slackInboundFileSummary(files []SlackFile) string {
	if len(files) == 0 {
		return ""
	}
	parts := make([]string, 0, len(files))
	for _, file := range files {
		name := firstNonEmpty(file.Title, file.Name, file.ID, "file")
		typ := firstNonEmpty(file.Filetype, file.Mimetype)
		if typ != "" {
			parts = append(parts, fmt.Sprintf("[file: %s type=%s]", name, typ))
		} else {
			parts = append(parts, fmt.Sprintf("[file: %s]", name))
		}
	}
	return strings.Join(parts, " ")
}

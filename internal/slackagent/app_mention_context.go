package slackagent

import (
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"
)

const maxAppMentionThreadMessages = 50
const mentionRecentThreadTail = 12
const (
	replyFeedbackBlockID      = "oneesama_reply_feedback"
	replyFeedbackSavedBlockID = "oneesama_reply_feedback_saved"
)

var slackComparableTextReplacer = strings.NewReplacer(
	"*", "",
	"_", "",
	"`", "",
	"~", "",
	"\n", " ",
	"\r", " ",
)

type SlackAppMentionContext struct {
	Kind                string                         `json:"kind"`
	Source              string                         `json:"source,omitempty"`
	ChannelID           string                         `json:"channelId,omitempty"`
	ThreadTS            string                         `json:"threadTs,omitempty"`
	UserID              string                         `json:"userId,omitempty"`
	BotUserID           string                         `json:"botUserId,omitempty"`
	MessageCount        int                            `json:"messageCount"`
	Transcript          string                         `json:"transcript,omitempty"`
	Prompt              string                         `json:"prompt,omitempty"`
	RawMentionText      string                         `json:"rawMentionText,omitempty"`
	MentionText         string                         `json:"mentionText,omitempty"`
	InjectedJoinRequest bool                           `json:"injectedJoinRequest"`
	ContainsMeetURL     bool                           `json:"containsMeetUrl"`
	ParentInfo          SlackAssistantThreadParentInfo `json:"parentInfo"`
	CanvasFiles         []SlackThreadFile              `json:"canvasFiles,omitempty"`
	Files               []SlackThreadFile              `json:"files,omitempty"`
	ImageParts          []SlackThreadImage             `json:"imageParts,omitempty"`
	ExternalLinks       []SlackExternalLinkContext     `json:"externalLinks,omitempty"`
	LinkedSlackThreads  []SlackLinkedThreadContext     `json:"linkedSlackThreads,omitempty"`
	ToolEvidence        []SlackAppMentionToolEvidence  `json:"toolEvidence,omitempty"`
	MeetingContext      string                         `json:"meetingContext,omitempty"`
	ThreadPermalink     string                         `json:"threadPermalink,omitempty"`
	FetchOK             bool                           `json:"fetchOk"`
	FetchError          string                         `json:"fetchError,omitempty"`
	FetchedAt           string                         `json:"fetchedAt"`
}

type SlackAppMentionToolEvidence struct {
	Tool    string         `json:"tool"`
	Args    map[string]any `json:"args,omitempty"`
	OK      bool           `json:"ok"`
	Error   string         `json:"error,omitempty"`
	Summary string         `json:"summary,omitempty"`
	Text    string         `json:"text,omitempty"`
}

type SlackAssistantThreadParentInfo struct {
	User        string `json:"user,omitempty"`
	UserName    string `json:"userName,omitempty"`
	UserID      string `json:"userId,omitempty"`
	BotID       string `json:"botId,omitempty"`
	TS          string `json:"ts,omitempty"`
	IsBotParent bool   `json:"isBotParent,omitempty"`
}

type SlackThreadFile struct {
	ID        string `json:"id,omitempty"`
	Name      string `json:"name,omitempty"`
	Title     string `json:"title,omitempty"`
	Filetype  string `json:"filetype,omitempty"`
	Mimetype  string `json:"mimetype,omitempty"`
	Size      int64  `json:"size,omitempty"`
	OriginalW int    `json:"originalW,omitempty"`
	OriginalH int    `json:"originalH,omitempty"`
	Permalink string `json:"permalink,omitempty"`
	ImageURL  string `json:"imageUrl,omitempty"`
}

type SlackThreadImage struct {
	ID        string `json:"id,omitempty"`
	Name      string `json:"name,omitempty"`
	Mimetype  string `json:"mimetype,omitempty"`
	Size      int64  `json:"size,omitempty"`
	Permalink string `json:"permalink,omitempty"`
	ImageURL  string `json:"imageUrl,omitempty"`
	Source    string `json:"source,omitempty"`
}

type SlackLinkedThreadContext struct {
	URL          string            `json:"url,omitempty"`
	ChannelID    string            `json:"channelId,omitempty"`
	ThreadTS     string            `json:"threadTs,omitempty"`
	MessageCount int               `json:"messageCount,omitempty"`
	Transcript   string            `json:"transcript,omitempty"`
	CanvasFiles  []SlackThreadFile `json:"canvasFiles,omitempty"`
	FetchOK      bool              `json:"fetchOk"`
	FetchError   string            `json:"fetchError,omitempty"`
}

func buildSlackAppMentionContext(event SlackEventPayload) *SlackAppMentionContext {
	messages := threadMessagesFromEvent(event)
	botUserID := firstSlackMentionUserID(event.Text)
	transcriptMessages, omitted := compactSlackThreadTranscriptMessages(messages, true, mentionRecentThreadTail)
	transcript := formatSlackThreadTranscriptForBot(transcriptMessages, botUserID)
	transcript = annotateCompactedSlackTranscript(transcript, event.Channel, firstNonEmpty(event.ThreadTS, event.TS, event.EventTS), omitted)
	rawMentionText := stripSlackUserMention(event.Text, botUserID)
	mentionText := rawMentionText
	injectedJoinRequest := false
	if mentionText == "" && slackMeetURLPattern.MatchString(transcript) {
		mentionText = "请帮我加入这个会议"
		injectedJoinRequest = true
	}
	parent := firstSlackMessage(messages)
	media := extractSlackThreadMedia(messages)
	context := &SlackAppMentionContext{
		Kind:                "slack_app_mention_rich_context",
		Source:              "events_api",
		ChannelID:           event.Channel,
		ThreadTS:            firstNonEmpty(event.ThreadTS, event.TS, event.EventTS),
		UserID:              event.User,
		BotUserID:           botUserID,
		MessageCount:        len(transcriptMessages),
		Transcript:          transcript,
		RawMentionText:      rawMentionText,
		MentionText:         mentionText,
		InjectedJoinRequest: injectedJoinRequest,
		ContainsMeetURL:     slackMeetURLPattern.MatchString(transcript),
		ParentInfo:          slackParentInfo(parent),
		CanvasFiles:         media.CanvasFiles,
		Files:               media.Files,
		ImageParts:          media.Images,
		MeetingContext:      firstNonEmpty(event.MeetingContext, event.MeetingContextCamel),
		ThreadPermalink:     firstNonEmpty(event.ThreadPermalink, event.ThreadPermalinkCamel),
		FetchOK:             true,
		FetchedAt:           time.Now().UTC().Format(time.RFC3339Nano),
	}
	context.Prompt = buildSlackAssistantThreadMessage(context)
	return context
}

func threadMessagesFromEvent(event SlackEventPayload) []SlackMessage {
	candidates := [][]SlackMessage{
		event.ThreadMessages,
		event.ThreadMessagesCamel,
		event.Replies,
		nestedSlackThreadMessages(event),
	}
	for _, candidate := range candidates {
		if len(candidate) > 0 {
			return limitSlackMessages(candidate)
		}
	}
	return []SlackMessage{{
		TS:        firstNonEmpty(event.TS, event.EventTS),
		Timestamp: firstNonEmpty(event.TS, event.EventTS),
		EventTS:   event.EventTS,
		User:      event.User,
		UserID:    event.User,
		BotID:     event.BotID,
		Subtype:   event.Subtype,
		Text:      event.Text,
		Channel:   event.Channel,
		ThreadTS:  event.ThreadTS,
		Permalink: firstNonEmpty(event.ThreadPermalink, event.ThreadPermalinkCamel),
	}}
}

func limitSlackMessages(messages []SlackMessage) []SlackMessage {
	if len(messages) <= maxAppMentionThreadMessages {
		return append([]SlackMessage(nil), messages...)
	}
	return append([]SlackMessage(nil), messages[:maxAppMentionThreadMessages]...)
}

func firstSlackMessage(messages []SlackMessage) SlackMessage {
	if len(messages) == 0 {
		return SlackMessage{}
	}
	return messages[0]
}

func formatSlackThreadTranscript(messages []SlackMessage) string {
	return formatSlackThreadTranscriptForBot(messages, "")
}

func formatSlackThreadTranscriptForBot(messages []SlackMessage, botUserID string) string {
	lines := make([]string, 0, len(messages)*2)
	for _, message := range limitSlackMessages(messages) {
		if !isSlackTranscriptContentSubtype(message.Subtype) {
			continue
		}
		text := strings.TrimSpace(message.Text)
		blockLines := slackTranscriptBlockLines(message.Blocks)
		if text == "" && len(blockLines) == 0 && len(message.Files) == 0 && len(message.Attachments) == 0 {
			continue
		}
		prefix := fmt.Sprintf("[ts:%s] %s", slackMessageTimestamp(message), slackUserLabelForBot(message, botUserID))
		if text != "" && (!isSlackAssistantSelf(message, botUserID) || len(blockLines) == 0) {
			lines = append(lines, prefix+": "+resolveTextMentions(text, nil))
		} else {
			lines = append(lines, prefix+":")
		}
		seen := map[string]struct{}{}
		if text != "" && (!isSlackAssistantSelf(message, botUserID) || len(blockLines) == 0) {
			seen[normalizeSlackComparableText(text)] = struct{}{}
		}
		for _, line := range blockLines {
			key := normalizeSlackComparableText(line)
			if key == "" {
				continue
			}
			if _, exists := seen[key]; exists {
				continue
			}
			seen[key] = struct{}{}
			if strings.HasSuffix(lines[len(lines)-1], ":") {
				lines[len(lines)-1] += " " + line
			} else {
				lines = append(lines, "  "+line)
			}
		}
		for _, attachment := range message.Attachments {
			if attachment.Title != "" || attachment.TitleLink != "" {
				lines = append(lines, fmt.Sprintf("  [attachment: %s <%s>]", attachment.Title, attachment.TitleLink))
			}
			if attachment.Text != "" {
				lines = append(lines, "  "+truncateSlackContextText(attachment.Text, 300))
			}
			for _, file := range attachment.Files {
				lines = append(lines, "  "+formatSlackFileLine(normalizeSlackThreadFile(file)))
			}
		}
		for _, file := range message.Files {
			lines = append(lines, "  "+formatSlackFileLine(normalizeSlackThreadFile(file)))
		}
		if message.Subtype == "document_comment_root" {
			if line := slackCanvasCommentExcerpt(message.Blocks); line != "" {
				lines = append(lines, "  "+line)
			}
		}
		if len(message.Reactions) > 0 {
			reactions := make([]string, 0, len(message.Reactions))
			for _, reaction := range message.Reactions {
				reactions = append(reactions, fmt.Sprintf(":%s: x%d", firstNonEmpty(reaction.Name, "reaction"), maxInt(reaction.Count, 1)))
			}
			lines = append(lines, "  [reactions: "+strings.Join(reactions, ", ")+"]")
		}
	}
	return strings.TrimSpace(strings.Join(lines, "\n"))
}

func slackUserLabel(message SlackMessage) string {
	return slackUserLabelForBot(message, "")
}

func slackUserLabelForBot(message SlackMessage, botUserID string) string {
	if isSlackAssistantSelf(message, botUserID) {
		return slackUserDisplayName(message) + " [assistant]"
	}
	if message.BotID != "" {
		return firstNonEmpty(message.UserName, message.Username, message.BotID, "bot") + " [app]"
	}
	return slackUserDisplayName(message)
}

func slackUserDisplayName(message SlackMessage) string {
	if name := firstNonEmpty(message.UserName, message.Username); name != "" {
		return name
	}
	if id := firstNonEmpty(message.UserID, message.UserIDCamel, message.User); id != "" {
		return "<@" + id + ">"
	}
	return "bot"
}

func slackParentInfo(message SlackMessage) SlackAssistantThreadParentInfo {
	return SlackAssistantThreadParentInfo{
		User:        firstNonEmpty(message.User, message.UserID, message.UserIDCamel),
		UserName:    slackUserLabel(message),
		UserID:      firstNonEmpty(message.UserID, message.UserIDCamel, message.User),
		BotID:       message.BotID,
		TS:          firstNonEmpty(message.TS, message.EventTS),
		IsBotParent: message.BotID != "",
	}
}

func buildSlackAssistantThreadMessage(input *SlackAppMentionContext) string {
	parentAuthor := firstNonEmpty(input.ParentInfo.UserName, input.ParentInfo.User, input.ParentInfo.UserID, "unknown")
	lines := []string{
		"Thread metadata:",
		"- channel: " + firstNonEmpty(input.ChannelID, "unknown"),
		"- thread_ts: " + firstNonEmpty(input.ThreadTS, "unknown"),
	}
	if input.ThreadPermalink != "" {
		lines = append(lines, "- thread_permalink: "+input.ThreadPermalink)
	}
	startedBy := "- thread started by: " + parentAuthor
	if input.ParentInfo.IsBotParent {
		startedBy += " (assistant or app message)"
	}
	lines = append(lines, startedBy)
	if input.Transcript != "" {
		lines = append(lines, "", "Thread context:", "", input.Transcript)
	}
	if input.MeetingContext != "" {
		lines = append(lines, "", "---", "Live meeting status:", input.MeetingContext)
	}
	if len(input.ExternalLinks) > 0 {
		lines = append(lines, "", "---", "Fetched external link context:", formatSlackExternalLinkContexts(input.ExternalLinks))
	}
	if len(input.ToolEvidence) > 0 {
		lines = append(lines, "", "---", "First-class tool evidence:", formatSlackAppMentionToolEvidence(input.ToolEvidence))
	}
	lines = append(lines, "", "---", fmt.Sprintf("User <@%s> says:", firstNonEmpty(input.UserID, "unknown")), strings.TrimSpace(input.MentionText))
	return strings.TrimSpace(strings.Join(lines, "\n"))
}

func appendSlackAppMentionToolEvidencePromptContext(prompt string, evidence []SlackAppMentionToolEvidence) string {
	section := strings.TrimSpace(formatSlackAppMentionToolEvidence(evidence))
	if section == "" {
		return prompt
	}
	prompt = strings.TrimSpace(prompt)
	if prompt == "" {
		return "First-class tool evidence:\n" + section
	}
	return prompt + "\n\n---\nFirst-class tool evidence:\n" + section
}

func formatSlackAppMentionToolEvidence(evidence []SlackAppMentionToolEvidence) string {
	var lines []string
	for index, item := range evidence {
		tool := strings.TrimSpace(item.Tool)
		if tool == "" {
			continue
		}
		status := "ok"
		if !item.OK {
			status = "error"
		}
		lines = append(lines, fmt.Sprintf("%d. %s (%s)", index+1, tool, status))
		if len(item.Args) > 0 {
			lines = append(lines, "   args: "+formatSlackToolEvidenceArgs(item.Args))
		}
		if item.Error != "" {
			lines = append(lines, "   error: "+truncateSlackContextText(item.Error, 300))
		}
		if item.Summary != "" {
			lines = append(lines, "   summary: "+truncateSlackContextText(item.Summary, 1200))
		} else if item.Text != "" {
			lines = append(lines, "   text: "+truncateSlackContextText(item.Text, 1200))
		}
	}
	return strings.Join(lines, "\n")
}

func formatSlackToolEvidenceArgs(args map[string]any) string {
	parts := make([]string, 0, len(args))
	for _, key := range sortedMapKeys(args) {
		value := strings.TrimSpace(stringFromAny(args[key]))
		if value == "" {
			continue
		}
		parts = append(parts, fmt.Sprintf("%s=%q", key, truncateSlackContextText(value, 180)))
	}
	return strings.Join(parts, " ")
}

func sortedMapKeys(values map[string]any) []string {
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

type slackThreadMedia struct {
	Files       []SlackThreadFile
	Images      []SlackThreadImage
	CanvasFiles []SlackThreadFile
}

func extractSlackThreadMedia(messages []SlackMessage) slackThreadMedia {
	var media slackThreadMedia
	for _, message := range messages {
		for _, file := range message.Files {
			normalized := normalizeSlackThreadFile(file)
			media.Files = append(media.Files, normalized)
			if isSlackCanvasFile(normalized) {
				media.CanvasFiles = append(media.CanvasFiles, normalized)
			}
			if isSlackImageFile(normalized) {
				media.Images = append(media.Images, SlackThreadImage{
					ID: normalized.ID, Name: normalized.Name, Mimetype: normalized.Mimetype,
					Size: normalized.Size, Permalink: normalized.Permalink, ImageURL: normalized.ImageURL, Source: "inline",
				})
			}
		}
	}
	return media
}

func normalizeSlackThreadFile(file SlackFile) SlackThreadFile {
	name := firstNonEmpty(file.Name, file.Title, file.ID, "file")
	return SlackThreadFile{
		ID: file.ID, Name: name, Title: firstNonEmpty(file.Title, name), Filetype: file.Filetype,
		Mimetype: file.Mimetype, Size: file.Size, OriginalW: file.OriginalW, OriginalH: file.OriginalH, Permalink: firstNonEmpty(file.Permalink, file.URL, file.URLPrivate), ImageURL: firstNonEmpty(file.ImageURL, file.URL),
	}
}

func isSlackCanvasFile(file SlackThreadFile) bool {
	return file.Filetype == "quip" || strings.Contains(file.Mimetype, "slack-docs")
}

func isSlackImageFile(file SlackThreadFile) bool {
	return strings.HasPrefix(file.Mimetype, "image/") || file.Filetype == "jpg" || file.Filetype == "jpeg" || file.Filetype == "png" || file.Filetype == "gif" || file.Filetype == "webp"
}

func formatSlackFileLine(file SlackThreadFile) string {
	if isSlackCanvasFile(file) {
		return fmt.Sprintf("[canvas: %q canvas_id=%s]", firstNonEmpty(file.Title, file.Name), file.ID)
	}
	if isSlackImageFile(file) {
		parts := []string{fmt.Sprintf("[image: %s file_id=%s type=%s size=%d", firstNonEmpty(file.Name, "image"), file.ID, file.Mimetype, file.Size)}
		if file.ID == "" {
			parts[0] = fmt.Sprintf("[image: %s type=%s size=%d", firstNonEmpty(file.Name, "image"), file.Mimetype, file.Size)
		}
		if file.OriginalW > 0 && file.OriginalH > 0 {
			parts[0] += fmt.Sprintf(" %dx%d", file.OriginalW, file.OriginalH)
		}
		if file.Permalink != "" {
			return parts[0] + " <" + file.Permalink + ">]"
		}
		return parts[0] + "]"
	}
	return fmt.Sprintf("[file: %s type=%s size=%d <%s>]", file.Name, firstNonEmpty(file.Filetype, file.Mimetype, "unknown"), file.Size, file.Permalink)
}

func truncateSlackContextText(value string, maxLength int) string {
	if len(value) <= maxLength {
		return value
	}
	return value[:maxLength] + "..."
}

func maxInt(value int, fallback int) int {
	if value > 0 {
		return value
	}
	return fallback
}

func isSlackAssistantSelf(message SlackMessage, botUserID string) bool {
	return botUserID != "" && firstNonEmpty(message.User, message.UserID, message.UserIDCamel) == botUserID
}

func isSlackTranscriptContentSubtype(subtype string) bool {
	switch strings.TrimSpace(subtype) {
	case "", "bot_message", "document_comment_root", "file_share":
		return true
	default:
		return false
	}
}

func slackMessageTimestamp(message SlackMessage) string {
	return firstNonEmpty(message.TS, message.Timestamp, message.EventTS)
}

func slackTranscriptBlockLines(blocks []SlackBlock) []string {
	var lines []string
	for _, block := range blocks {
		if block.BlockID == replyFeedbackBlockID || block.BlockID == replyFeedbackSavedBlockID {
			continue
		}
		switch block.Type {
		case "section":
			if block.Text != nil && strings.TrimSpace(block.Text.Text) != "" {
				lines = append(lines, resolveTextMentions(block.Text.Text, nil))
			}
		case "header":
			if block.Text != nil && strings.TrimSpace(block.Text.Text) != "" {
				lines = append(lines, "[header: "+strings.TrimSpace(block.Text.Text)+"]")
			}
		case "context":
			for _, element := range block.Elements {
				if element.Text != nil && strings.TrimSpace(element.Text.Text) != "" {
					lines = append(lines, "[context: "+truncateSlackContextText(element.Text.Text, 200)+"]")
				}
			}
		case "actions":
			for _, element := range block.Elements {
				if strings.TrimSpace(element.URL) == "" {
					continue
				}
				label := ""
				if element.Text != nil {
					label = element.Text.Text
				}
				lines = append(lines, fmt.Sprintf("[button: %s <%s>]", label, element.URL))
			}
		}
	}
	return lines
}

func slackCanvasCommentExcerpt(blocks []SlackBlock) string {
	var ids []string
	for _, block := range blocks {
		if strings.HasPrefix(strings.TrimSpace(block.BlockID), "temp:C:") {
			ids = append(ids, strings.TrimSpace(block.BlockID))
		}
	}
	line := "[slack canvas comment excerpt"
	for _, id := range ids {
		line += " section_id=" + id
	}
	return line + "; original canvas_id is not present in this thread payload]"
}

func firstSlackMentionUserID(text string) string {
	match := slackBotMentionPattern.FindString(strings.TrimSpace(text))
	if match == "" {
		return ""
	}
	return strings.TrimSuffix(strings.TrimPrefix(match, "<@"), ">")
}

func normalizeSlackComparableText(text string) string {
	text = slackComparableTextReplacer.Replace(text)
	return strings.Join(strings.Fields(strings.ToLower(text)), " ")
}

func compactSlackThreadTranscriptMessages(messages []SlackMessage, compact bool, recentTail int) ([]SlackMessage, int) {
	if !compact || len(messages) <= recentTail+1 {
		return append([]SlackMessage(nil), messages...), 0
	}
	start := len(messages) - recentTail
	if start < 1 {
		start = 1
	}
	kept := make([]SlackMessage, 0, 1+len(messages[start:]))
	kept = append(kept, messages[0])
	kept = append(kept, messages[start:]...)
	omitted := start - 1
	if omitted < 0 {
		omitted = 0
	}
	return kept, omitted
}

func annotateCompactedSlackTranscript(transcript string, channelID string, threadTS string, omitted int) string {
	if omitted <= 0 {
		return transcript
	}
	hint := fmt.Sprintf("[... %d earlier thread messages omitted from initial context; use slack_api(method=\"conversations.replies\", params={\"channel\":\"%s\",\"thread_ts\":\"%s\"}) if older context matters.]", omitted, channelID, threadTS)
	if strings.TrimSpace(transcript) == "" {
		return hint
	}
	return strings.TrimSpace(transcript) + "\n" + hint
}

type queuedSlackMention struct {
	event SlackEventPayload
}

type mentionThreadState struct {
	pending   []queuedSlackMention
	running   bool
	ackPosted bool
}

type slackMentionQueue struct {
	mu     sync.Mutex
	states map[string]*mentionThreadState
}

func newSlackMentionQueue() *slackMentionQueue {
	return &slackMentionQueue{states: map[string]*mentionThreadState{}}
}

func mentionThreadKey(workspaceID, channelID, threadTS string) string {
	return workspaceID + ":" + channelID + ":" + threadTS
}

func (q *slackMentionQueue) enqueue(workspaceID, channelID, threadTS string, event SlackEventPayload) (startWorker bool, postAck bool) {
	q.mu.Lock()
	defer q.mu.Unlock()
	key := mentionThreadKey(workspaceID, channelID, threadTS)
	state := q.states[key]
	if state == nil {
		state = &mentionThreadState{}
		q.states[key] = state
	}
	state.pending = append(state.pending, queuedSlackMention{event: event})
	if state.running {
		if !state.ackPosted {
			state.ackPosted = true
			return false, true
		}
		return false, false
	}
	state.running = true
	state.ackPosted = false
	return true, false
}

func (q *slackMentionQueue) dequeueOrStop(workspaceID, channelID, threadTS string) ([]queuedSlackMention, bool) {
	q.mu.Lock()
	defer q.mu.Unlock()
	key := mentionThreadKey(workspaceID, channelID, threadTS)
	state := q.states[key]
	if state == nil {
		return nil, false
	}
	if len(state.pending) == 0 {
		delete(q.states, key)
		return nil, false
	}
	batch := append([]queuedSlackMention(nil), state.pending...)
	state.pending = nil
	state.ackPosted = false
	return batch, true
}

func (q *slackMentionQueue) hasQueued(workspaceID, channelID, threadTS string) bool {
	q.mu.Lock()
	defer q.mu.Unlock()
	state := q.states[mentionThreadKey(workspaceID, channelID, threadTS)]
	return state != nil && len(state.pending) > 0
}

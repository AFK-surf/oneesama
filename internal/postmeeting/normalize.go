package postmeeting

import (
	"regexp"
	"slices"
	"strings"
)

var linkPattern = regexp.MustCompile(`https?://[^\s<>"')\]}]+`)

func normalizeSegments(input PostProcessInput) []NormalizedSegment {
	sourceSegments := input.Segments
	if len(sourceSegments) == 0 {
		sourceSegments = input.Captions
	}
	if len(sourceSegments) == 0 {
		sourceSegments = input.Transcript.Segments
	}

	segments := make([]NormalizedSegment, 0, len(sourceSegments))
	for _, segment := range sourceSegments {
		text := collapseWhitespace(segment.Text)
		if text == "" {
			continue
		}
		segments = append(segments, NormalizedSegment{
			Speaker:   firstNonEmpty(segment.Speaker, segment.User, segment.Name, "unknown"),
			Text:      text,
			StartMS:   segment.StartMS,
			EndMS:     segment.EndMS,
			Timestamp: firstNonEmpty(segment.Timestamp, segment.TS),
			Source:    firstNonEmpty(segment.Source, "caption"),
			StreamID:  firstNonEmpty(segment.StreamID, segment.Stream),
		})
	}

	if len(segments) > 0 {
		return collapseIncrementalCaptionSegments(dedupeSegments(segments))
	}

	transcriptText := collapseWhitespace(firstNonEmpty(input.TranscriptText, input.Transcript.Text, input.Text))
	if transcriptText == "" {
		return nil
	}

	lines := strings.Split(transcriptText, "\n")
	segments = make([]NormalizedSegment, 0, len(lines))
	for index, line := range lines {
		text := collapseWhitespace(line)
		if text == "" {
			continue
		}
		source := "transcript_text_line"
		if index == 0 {
			source = "transcript_text"
		}
		segments = append(segments, NormalizedSegment{
			Speaker: "unknown",
			Text:    text,
			Source:  source,
		})
	}
	return segments
}

func dedupeSegments(segments []NormalizedSegment) []NormalizedSegment {
	if len(segments) == 0 {
		return nil
	}
	seen := make(map[string]struct{}, len(segments))
	out := make([]NormalizedSegment, 0, len(segments))
	for _, segment := range segments {
		key := strings.TrimSpace(segment.Speaker) + "\x00" + strings.TrimSpace(segment.Text)
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = struct{}{}
		out = append(out, segment)
	}
	return out
}

func collapseIncrementalCaptionSegments(segments []NormalizedSegment) []NormalizedSegment {
	if len(segments) == 0 {
		return nil
	}
	byStream := make(map[string]int)
	collapsed := make([]NormalizedSegment, 0, len(segments))
	for _, segment := range segments {
		streamID := strings.TrimSpace(segment.StreamID)
		key := strings.TrimSpace(segment.Speaker) + "\x00" + streamID
		if streamID == "" {
			collapsed = append(collapsed, segment)
			continue
		}
		if index, ok := byStream[key]; ok {
			current := collapsed[index]
			if longerCaptionUpdate(segment.Text, current.Text) {
				collapsed[index] = segment
			}
			continue
		}
		byStream[key] = len(collapsed)
		collapsed = append(collapsed, segment)
	}
	out := make([]NormalizedSegment, 0, len(collapsed))
	for index, segment := range collapsed {
		if supersededByLaterCaption(index, segment, collapsed) {
			continue
		}
		out = append(out, segment)
	}
	return out
}

func longerCaptionUpdate(candidate string, current string) bool {
	candidate = strings.TrimSpace(candidate)
	current = strings.TrimSpace(current)
	if len([]rune(candidate)) <= len([]rune(current)) {
		return false
	}
	return strings.Contains(strings.ToLower(candidate), strings.ToLower(current)) ||
		strings.Contains(strings.ToLower(current), strings.ToLower(candidate)) ||
		len([]rune(candidate))-len([]rune(current)) > 8
}

func supersededByLaterCaption(index int, segment NormalizedSegment, all []NormalizedSegment) bool {
	text := strings.ToLower(strings.TrimSpace(segment.Text))
	if text == "" {
		return true
	}
	for laterIndex := index + 1; laterIndex < len(all); laterIndex++ {
		later := all[laterIndex]
		if strings.TrimSpace(later.Speaker) != strings.TrimSpace(segment.Speaker) {
			continue
		}
		laterText := strings.ToLower(strings.TrimSpace(later.Text))
		if len([]rune(laterText)) <= len([]rune(text)) {
			continue
		}
		if strings.Contains(laterText, text) {
			return true
		}
	}
	return false
}

func normalizeChatMessages(input PostProcessInput) []NormalizedChatMessage {
	sourceMessages := input.ChatMessages
	if len(sourceMessages) == 0 {
		sourceMessages = input.MeetChatMessages
	}

	normalized := make([]NormalizedChatMessage, 0, len(sourceMessages))
	for _, entry := range sourceMessages {
		text := collapseWhitespace(firstNonEmpty(entry.Text, entry.Message, entry.Body))
		if text == "" {
			continue
		}
		combinedLinks := append(append([]string(nil), entry.Links...), extractLinks(text)...)
		links := normalizeLinks(combinedLinks...)
		normalized = append(normalized, NormalizedChatMessage{
			Direction: normalizeChatDirection(entry),
			Sender:    firstNonEmpty(entry.Sender, entry.User, entry.Name, entry.Author, "unknown"),
			Text:      text,
			Timestamp: firstNonEmpty(entry.Timestamp, entry.TS, entry.CreatedAt, entry.SentAt),
			MessageID: firstNonEmpty(entry.MessageID, entry.ID, entry.EventID),
			Links:     links,
			Source:    firstNonEmpty(entry.Source, entry.Type, "chat"),
			Error:     firstNonEmpty(entry.Error, entry.Status),
		})
	}
	return normalized
}

func participantList(input PostProcessInput, segments []NormalizedSegment) []string {
	if len(input.Participants) > 0 {
		return dedupeStrings(input.Participants)
	}
	participants := make([]string, 0)
	for _, segment := range segments {
		if speaker := strings.TrimSpace(segment.Speaker); speaker != "" && speaker != "unknown" {
			participants = append(participants, speaker)
		}
	}
	return dedupeStrings(participants)
}

func normalizeChatDirection(entry ChatMessageInput) string {
	value := strings.ToLower(strings.TrimSpace(firstNonEmpty(entry.Direction, entry.Type)))
	switch value {
	case "outgoing", "sent", "bot", "assistant":
		return "outgoing"
	case "incoming", "received", "user", "participant":
		return "incoming"
	default:
		if strings.Contains(strings.ToLower(strings.TrimSpace(entry.Source)), "send") {
			return "outgoing"
		}
		return "incoming"
	}
}

func extractLinks(text string) []string {
	matches := linkPattern.FindAllString(text, -1)
	if len(matches) == 0 {
		return nil
	}
	return normalizeLinks(matches...)
}

func normalizeLinks(values ...string) []string {
	normalized := make([]string, 0, len(values))
	for _, value := range values {
		trimmed := strings.TrimRight(strings.TrimSpace(value), ".,!?;:，。！？；：")
		if trimmed != "" {
			normalized = append(normalized, trimmed)
		}
	}
	return dedupeStrings(normalized)
}

func dedupeStrings(values []string) []string {
	if len(values) == 0 {
		return nil
	}
	seen := make(map[string]struct{}, len(values))
	out := make([]string, 0, len(values))
	for _, value := range values {
		trimmed := strings.TrimSpace(value)
		if trimmed == "" {
			continue
		}
		if _, ok := seen[trimmed]; ok {
			continue
		}
		seen[trimmed] = struct{}{}
		out = append(out, trimmed)
	}
	slices.Sort(out)
	return out
}

func collapseWhitespace(value string) string {
	return strings.Join(strings.Fields(strings.TrimSpace(value)), " ")
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if trimmed := strings.TrimSpace(value); trimmed != "" {
			return trimmed
		}
	}
	return ""
}

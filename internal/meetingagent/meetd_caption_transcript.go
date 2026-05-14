package meetingagent

import (
	"fmt"
	"strings"
	"time"
)

func meetdCaptionTranscript(captions []MeetdCaptionRecord, origin time.Time) string {
	captions = dedupeMeetdCaptionsForTranscript(captions)
	if len(captions) == 0 {
		return ""
	}
	origin = meetdCaptionOrigin(captions, origin)
	lines := make([]string, 0, len(captions))
	for _, caption := range captions {
		speaker := normalizeMeetdSpeakerName(caption.Speaker)
		if speaker == "" {
			speaker = "Unknown"
		}
		text := strings.TrimSpace(caption.Text)
		if text == "" {
			continue
		}
		lines = append(lines, fmt.Sprintf("[%s] %s: %s", formatMeetdRelativeTimestamp(caption.Timestamp, origin), speaker, text))
	}
	return strings.Join(lines, "\n")
}

func meetdCaptionTranscriptInRange(captions []MeetdCaptionRecord, origin, start, end time.Time) string {
	filtered := make([]MeetdCaptionRecord, 0, len(captions))
	for _, caption := range captions {
		if !start.IsZero() && caption.Timestamp.Before(start) {
			continue
		}
		if !end.IsZero() && caption.Timestamp.After(end) {
			continue
		}
		filtered = append(filtered, caption)
	}
	return meetdCaptionTranscript(filtered, origin)
}

func dedupeMeetdCaptionsForTranscript(captions []MeetdCaptionRecord) []MeetdCaptionRecord {
	if len(captions) == 0 {
		return nil
	}
	kept := make([]*MeetdCaptionRecord, 0, len(captions))
	for _, caption := range captions {
		caption.Speaker = normalizeMeetdSpeakerName(caption.Speaker)
		if caption.Speaker == "" {
			caption.Speaker = "Unknown"
		}
		caption.Text = strings.TrimSpace(caption.Text)
		if caption.Text == "" {
			continue
		}
		merged := false
		replacedEarlier := false
		for i := len(kept) - 1; i >= 0; i-- {
			prev := kept[i]
			if prev == nil {
				continue
			}
			if caption.Timestamp.Sub(prev.Timestamp) > meetdTranscriptSpeakerDedupWindow {
				break
			}
			if prev.Speaker != caption.Speaker {
				continue
			}
			if meetdCaptionTextsEquivalent(prev.Text, caption.Text) || meetdCaptionIsIncrementalUpdate(prev.Text, caption.Text) {
				kept[i] = nil
				merged = true
				replacedEarlier = true
				break
			}
			if meetdCaptionIsIncrementalUpdate(caption.Text, prev.Text) {
				merged = true
				break
			}
		}
		if !merged || replacedEarlier {
			clone := caption
			kept = append(kept, &clone)
		}
	}
	out := make([]MeetdCaptionRecord, 0, len(kept))
	for _, caption := range kept {
		if caption != nil {
			out = append(out, *caption)
		}
	}
	return out
}

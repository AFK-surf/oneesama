package postmeeting

import (
	"encoding/json"
	"strings"
)

func cleanResponseText(text string) string {
	for {
		start := strings.Index(text, "<think>")
		if start == -1 {
			break
		}
		end := strings.Index(text[start:], "</think>")
		if end == -1 {
			text = text[:start]
			break
		}
		text = text[:start] + text[start+end+len("</think>"):]
	}
	text = strings.TrimSpace(text)

	start := 0
	for i := 0; i < len(text)-6; i++ {
		if text[i:i+7] == "```json" {
			start = i + 7
			break
		}
		if text[i:i+3] == "```" && (i+3 >= len(text) || text[i+3] == '\n') {
			start = i + 3
			break
		}
	}
	if start > 0 {
		for i := start; i < len(text)-2; i++ {
			if text[i:i+3] == "```" {
				return strings.TrimSpace(text[start:i])
			}
		}
		return strings.TrimSpace(text[start:])
	}
	return text
}

func extractJSONCandidate(text string) string {
	first := -1
	last := -1
	for i, r := range text {
		if r == '{' && first == -1 {
			first = i
		}
		if r == '}' {
			last = i
		}
	}
	if first >= 0 && last > first {
		return text[first : last+1]
	}
	return text
}

func parseSummaryJSON(candidate string, out *Summary) bool {
	if parseSummaryJSONCandidate(candidate, out) {
		return true
	}
	repaired := repairLikelyMalformedSummaryJSON(candidate)
	return repaired != candidate && parseSummaryJSONCandidate(repaired, out)
}

func parseSummaryJSONCandidate(candidate string, out *Summary) bool {
	*out = Summary{}

	if decodeSummaryPayload([]byte(candidate), out) && (out.Title != "" || len(out.Highlights) > 0) {
		return true
	}

	var raw map[string]json.RawMessage
	if json.Unmarshal([]byte(candidate), &raw) != nil {
		return false
	}
	for _, wrapper := range []string{"reply", "text", "content", "response"} {
		if value, ok := raw[wrapper]; ok {
			var inner string
			if json.Unmarshal(value, &inner) == nil && strings.HasPrefix(strings.TrimSpace(inner), "{") {
				if parseSummaryJSON(extractJSONCandidate(inner), out) {
					return true
				}
			}
		}
	}
	if _, ok := raw["key_points"]; !ok {
		for _, alt := range []string{"main_points", "meeting_minutes", "highlights"} {
			if value, ok := raw[alt]; ok {
				raw["key_points"] = value
				break
			}
		}
	}
	if _, ok := raw["key_points"]; !ok {
		if value, ok := raw["summary"]; ok {
			raw["key_points"], _ = json.Marshal([]json.RawMessage{value})
		}
	}
	normalized, err := json.Marshal(raw)
	if err != nil {
		return false
	}
	*out = Summary{}
	return decodeSummaryPayload(normalized, out) && (out.Title != "" || len(out.Highlights) > 0)
}

func decodeSummaryPayload(payload []byte, out *Summary) bool {
	var raw struct {
		Title        string            `json:"title"`
		MeetURL      string            `json:"meet_url"`
		Attendees    []string          `json:"attendees"`
		Participants []string          `json:"participants"`
		KeyPoints    []string          `json:"key_points"`
		Highlights   []string          `json:"highlights"`
		Decisions    []string          `json:"decisions"`
		ActionItems  []json.RawMessage `json:"action_items"`
		SummaryText  string            `json:"summary_text"`
	}
	if json.Unmarshal(payload, &raw) != nil {
		return false
	}
	out.Title = strings.TrimSpace(raw.Title)
	out.MeetURL = strings.TrimSpace(raw.MeetURL)
	out.Participants = dedupeStrings(append(raw.Participants, raw.Attendees...))
	out.Highlights = dedupeStrings(append(raw.Highlights, raw.KeyPoints...))
	out.Decisions = dedupeStrings(raw.Decisions)
	out.ActionItems = decodeSummaryActionItems(raw.ActionItems)
	out.SummaryText = strings.TrimSpace(raw.SummaryText)
	if out.SummaryText == "" {
		out.SummaryText = strings.Join(out.Highlights, "\n")
	}
	return true
}

func decodeSummaryActionItems(items []json.RawMessage) []string {
	values := make([]string, 0, len(items))
	for _, item := range items {
		var text string
		if json.Unmarshal(item, &text) == nil {
			values = append(values, text)
			continue
		}
		var object struct {
			Description string `json:"description"`
			Owner       string `json:"owner"`
			Deadline    string `json:"deadline"`
		}
		if json.Unmarshal(item, &object) == nil {
			description := strings.TrimSpace(object.Description)
			if description == "" {
				continue
			}
			extras := make([]string, 0, 2)
			if owner := strings.TrimSpace(object.Owner); owner != "" {
				extras = append(extras, "owner: "+owner)
			}
			if deadline := strings.TrimSpace(object.Deadline); deadline != "" {
				extras = append(extras, "deadline: "+deadline)
			}
			if len(extras) > 0 {
				description += " (" + strings.Join(extras, ", ") + ")"
			}
			values = append(values, description)
		}
	}
	return dedupeStrings(values)
}

func repairLikelyMalformedSummaryJSON(candidate string) string {
	if !strings.Contains(candidate, `"`) {
		return candidate
	}

	var out strings.Builder
	out.Grow(len(candidate) + 16)
	inString := false
	escaped := false
	for i := 0; i < len(candidate); i++ {
		ch := candidate[i]
		if !inString {
			out.WriteByte(ch)
			if ch == '"' {
				inString = true
			}
			continue
		}
		if escaped {
			out.WriteByte(ch)
			escaped = false
			continue
		}
		switch ch {
		case '\\':
			out.WriteByte(ch)
			escaped = true
		case '"':
			if isLikelyJSONStringTerminator(candidate, i+1) {
				out.WriteByte(ch)
				inString = false
			} else {
				out.WriteString(`\"`)
			}
		case '\n':
			out.WriteString(`\n`)
		case '\r':
			out.WriteString(`\r`)
		case '\t':
			out.WriteString(`\t`)
		default:
			out.WriteByte(ch)
		}
	}
	return out.String()
}

func isLikelyJSONStringTerminator(s string, start int) bool {
	for i := start; i < len(s); i++ {
		switch s[i] {
		case ' ', '\n', '\r', '\t':
			continue
		case ',', '}', ']', ':':
			return true
		default:
			return false
		}
	}
	return true
}

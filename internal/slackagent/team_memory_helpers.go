package slackagent

import "strings"

func formatMeetingMemoryActionItems(items []MeetingActionItem) []string {
	var out []string
	for _, item := range items {
		desc := firstNonEmpty(item.Description, item.Text, item.Title)
		if desc == "" {
			continue
		}
		parts := []string{desc}
		if item.Owner != "" {
			parts = append(parts, "owner: "+item.Owner)
		}
		if due := firstNonEmpty(item.Deadline, item.Due); due != "" {
			parts = append(parts, "deadline: "+due)
		}
		out = append(out, strings.Join(parts, " — "))
	}
	return compactUniqueStrings(out)
}

func compactUniqueStrings(items []string) []string {
	seen := map[string]struct{}{}
	var out []string
	for _, item := range items {
		item = strings.TrimSpace(strings.Join(strings.Fields(item), " "))
		if item == "" {
			continue
		}
		key := strings.ToLower(item)
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = struct{}{}
		out = append(out, item)
	}
	return out
}

func firstNStrings(items []string, limit int) []string {
	if limit <= 0 || len(items) <= limit {
		return items
	}
	return items[:limit]
}

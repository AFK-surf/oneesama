package slackagent

import (
	"context"
	"fmt"
	"path/filepath"
	"sort"
	"strings"
)

func findPersonMemoryProfiles(workspaceDir string, query string, limit int) ([]personMemoryProfile, error) {
	if err := RefreshPeopleMemoryProjection(workspaceDir); err != nil {
		return nil, err
	}
	profiles, err := loadPeopleMemoryProfiles(workspaceDir)
	if err != nil {
		return nil, err
	}
	queryKey := compactPersonKey(query)
	var matches []personMemoryProfile
	type scoredProfile struct {
		profile personMemoryProfile
		score   int
	}
	var scored []scoredProfile
	for _, profile := range profiles {
		if queryKey == "" {
			matches = append(matches, profile)
			continue
		}
		score := personMemoryProfileScore(profile, queryKey)
		if score > 0 {
			scored = append(scored, scoredProfile{profile: profile, score: score})
		}
	}
	sort.SliceStable(scored, func(i, j int) bool {
		if scored[i].score == scored[j].score {
			return scored[i].profile.Name < scored[j].profile.Name
		}
		return scored[i].score > scored[j].score
	})
	for _, item := range scored {
		matches = append(matches, item.profile)
	}
	if limit > 0 && len(matches) > limit {
		matches = matches[:limit]
	}
	return matches, nil
}

func personMemoryProfileScore(profile personMemoryProfile, queryKey string) int {
	if queryKey == "" {
		return 1
	}
	nameKey := compactPersonKey(profile.Name)
	switch {
	case queryKey == nameKey:
		return 120
	case strings.Contains(nameKey, queryKey):
		return 90
	}
	fileKey := compactPersonKey(strings.TrimSuffix(filepath.Base(profile.Source), filepath.Ext(profile.Source)))
	switch {
	case queryKey == fileKey:
		return 115
	case strings.Contains(fileKey, queryKey):
		return 88
	}
	best := 0
	for _, value := range profile.IdentityMap {
		valueKey := compactPersonKey(value)
		switch {
		case queryKey == valueKey:
			best = maxInt(best, 95)
		case strings.Contains(valueKey, queryKey):
			best = maxInt(best, 80)
		}
	}
	searchKey := compactPersonKey(personMemorySearchText(profile))
	if strings.Contains(searchKey, queryKey) {
		best = maxInt(best, 60)
	}
	return best
}

func personMemorySearchText(profile personMemoryProfile) string {
	parts := []string{profile.Name, profile.Source}
	parts = append(parts, profile.IdentityMap...)
	parts = append(parts, profile.DurableContext...)
	parts = append(parts, profile.CurrentResponsibilities...)
	parts = append(parts, profile.RecentMeetings...)
	parts = append(parts, profile.OperatorNotes...)
	return strings.Join(parts, "\n")
}

func renderPersonMemoryLookup(profile personMemoryProfile) string {
	var sb strings.Builder
	_, _ = fmt.Fprintf(&sb, "Person: %s\n", profile.Name)
	if profile.Source != "" {
		sb.WriteString("Source: " + profile.Source + "\n")
	}
	appendPersonMemorySection(&sb, "Identity", profile.IdentityMap, 4)
	appendPersonMemorySection(&sb, "Operator notes", profile.OperatorNotes, 4)
	appendPersonMemorySection(&sb, "Durable context", profile.DurableContext, 4)
	appendPersonMemorySection(&sb, "Current responsibilities", profile.CurrentResponsibilities, 5)
	appendPersonMemorySection(&sb, "Recent meetings", profile.RecentMeetings, 4)
	return strings.TrimSpace(sb.String())
}

func renderPersonMemoryBriefing(profile personMemoryProfile) string {
	var sb strings.Builder
	_, _ = fmt.Fprintf(&sb, "Briefing for %s\n", profile.Name)
	appendPersonMemorySection(&sb, "Who they are", profile.IdentityMap, 2)
	appendPersonMemorySection(&sb, "Operator notes", profile.OperatorNotes, 2)
	if len(profile.CurrentResponsibilities) > 0 {
		appendPersonMemorySection(&sb, "Likely current focus", profile.CurrentResponsibilities, 3)
	} else {
		appendPersonMemorySection(&sb, "Relevant durable context", profile.DurableContext, 3)
	}
	appendPersonMemorySection(&sb, "Recent context", profile.RecentMeetings, 2)
	if profile.Source != "" {
		sb.WriteString("Source: " + profile.Source + "\n")
	}
	return strings.TrimSpace(sb.String())
}

func appendPersonMemorySection(sb *strings.Builder, title string, items []string, limit int) {
	items = personMemoryTop(items, limit)
	if len(items) == 0 {
		return
	}
	sb.WriteString(title + ":\n")
	for _, item := range items {
		sb.WriteString("- " + item + "\n")
	}
}

func personMemoryTop(items []string, limit int) []string {
	items = compactUniqueStrings(items)
	if limit > 0 && len(items) > limit {
		return items[:limit]
	}
	return items
}

func recordPersonMemoryCorrection(workspaceDir string, person string, note string, author string) (string, error) {
	if err := RefreshPeopleMemoryProjection(workspaceDir); err != nil {
		return "", err
	}
	profiles, err := loadPeopleMemoryProfiles(workspaceDir)
	if err != nil {
		return "", err
	}
	var known []string
	for _, profile := range profiles {
		known = append(known, profile.Name)
	}
	canonical := canonicalPersonName(person, known)
	if canonical == "" {
		return "", nil
	}
	noteLine := strings.TrimSpace(note)
	if author != "" {
		noteLine = fmt.Sprintf("%s: %s", author, noteLine)
	}
	var selected *personMemoryProfile
	for i := range profiles {
		if profiles[i].Name == canonical {
			selected = &profiles[i]
			break
		}
	}
	if selected == nil {
		selected = &personMemoryProfile{Name: canonical, Source: filepath.ToSlash(filepath.Join("memory", "people", normalizeMemoryTag(canonical)+".md"))}
	}
	selected.OperatorNotes = compactUniqueStrings(append(selected.OperatorNotes, noteLine))
	if err := writePeopleMemoryProfile(workspaceDir, selected); err != nil {
		return "", err
	}
	return canonical, nil
}

type personMemoryTool struct {
	workspaceDir string
}

func (t *personMemoryTool) Execute(ctx context.Context, args map[string]any) (slackAPIToolResult, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	select {
	case <-ctx.Done():
		return slackAPIToolResult{}, ctx.Err()
	default:
	}
	action := stringFromAny(args["action"])
	switch action {
	case "lookup", "briefing":
		matches, err := findPersonMemoryProfiles(t.workspaceDir, stringFromAny(args["person"]), 1)
		if err != nil {
			return slackAPIToolResult{}, err
		}
		if len(matches) == 0 {
			return slackAPIToolResult{Success: false, Text: "No matching person memory found."}, nil
		}
		if action == "briefing" {
			return slackAPIToolResult{Success: true, Text: renderPersonMemoryBriefing(matches[0])}, nil
		}
		return slackAPIToolResult{Success: true, Text: renderPersonMemoryLookup(matches[0])}, nil
	case "list":
		limit := intFromAny(args["limit"])
		matches, err := findPersonMemoryProfiles(t.workspaceDir, "", limit)
		if err != nil {
			return slackAPIToolResult{}, err
		}
		var lines []string
		lines = append(lines, "Known people")
		for _, profile := range matches {
			lines = append(lines, "- "+profile.Name)
		}
		return slackAPIToolResult{Success: true, Text: strings.Join(lines, "\n")}, nil
	case "correct":
		canonical, err := recordPersonMemoryCorrection(t.workspaceDir, stringFromAny(args["person"]), stringFromAny(args["note"]), stringFromAny(args["author"]))
		if err != nil {
			return slackAPIToolResult{}, err
		}
		return slackAPIToolResult{Success: true, Text: "Saved operator note for " + canonical}, nil
	default:
		return slackAPIToolResult{Success: false, Text: "unsupported person memory action"}, nil
	}
}

func intFromAny(value any) int {
	switch typed := value.(type) {
	case int:
		return typed
	case int64:
		return int(typed)
	case float64:
		return int(typed)
	default:
		return 0
	}
}

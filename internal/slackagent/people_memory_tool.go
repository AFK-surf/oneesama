package slackagent

import (
	"context"
	"fmt"
	"path/filepath"
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
	for _, profile := range profiles {
		if queryKey == "" || strings.Contains(compactPersonKey(profile.Name), queryKey) || profileContainsQuery(profile, queryKey) {
			matches = append(matches, profile)
		}
	}
	if limit > 0 && len(matches) > limit {
		matches = matches[:limit]
	}
	return matches, nil
}

func profileContainsQuery(profile personMemoryProfile, queryKey string) bool {
	for _, value := range append(append([]string{}, profile.IdentityMap...), profile.OperatorNotes...) {
		if strings.Contains(compactPersonKey(value), queryKey) {
			return true
		}
	}
	return false
}

func renderPersonMemoryBriefing(profile personMemoryProfile) string {
	var sb strings.Builder
	sb.WriteString(fmt.Sprintf("Briefing for %s\n\n", profile.Name))
	sb.WriteString(fmt.Sprintf("Person: %s\n\n", profile.Name))
	appendPlainBullets(&sb, "Who they are:", append(profile.IdentityMap, profile.DurableContext...))
	appendPlainBullets(&sb, "Likely current focus:", profile.CurrentResponsibilities)
	appendPlainBullets(&sb, "Recent meetings:", profile.RecentMeetings)
	appendPlainBullets(&sb, "Operator notes:", profile.OperatorNotes)
	if profile.Source != "" {
		sb.WriteString("Source: " + profile.Source + "\n")
	}
	return strings.TrimSpace(sb.String())
}

func appendPlainBullets(sb *strings.Builder, title string, items []string) {
	items = compactUniqueStrings(items)
	if len(items) == 0 {
		return
	}
	sb.WriteString(title + "\n")
	for _, item := range items {
		sb.WriteString("- " + item + "\n")
	}
	sb.WriteString("\n")
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
	case "lookup":
		matches, err := findPersonMemoryProfiles(t.workspaceDir, stringFromAny(args["person"]), 1)
		if err != nil {
			return slackAPIToolResult{}, err
		}
		if len(matches) == 0 {
			return slackAPIToolResult{Success: false, Text: "No matching person memory found."}, nil
		}
		return slackAPIToolResult{Success: true, Text: renderPersonMemoryBriefing(matches[0])}, nil
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

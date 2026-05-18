package slackagent

import (
	"bytes"
	"embed"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"text/template"
)

//go:embed templates/triage/*.tmpl templates/triage/README.md
var triageReplyTemplateFS embed.FS

type triageReplyTemplateData struct {
	Classification string
	MessageText    string
	Snippet        string
	Title          string
	Subject        string
	Excerpt        string
	URL            string
	Language       string
}

func renderTriageReplyTemplate(name string, language string, data triageReplyTemplateData) (string, error) {
	raw, err := loadTriageReplyTemplate(name, language)
	if err != nil {
		return "", err
	}
	tmpl, err := template.New(name).Parse(raw)
	if err != nil {
		return "", fmt.Errorf("parse triage template %s: %w", name, err)
	}
	var buf bytes.Buffer
	if err := tmpl.Execute(&buf, data); err != nil {
		return "", fmt.Errorf("execute triage template %s: %w", name, err)
	}
	return strings.TrimSpace(buf.String()), nil
}

func loadTriageReplyTemplate(name string, language string) (string, error) {
	name = sanitizeTriageTemplateName(name)
	if name == "" {
		return "", fmt.Errorf("triage template name required")
	}
	language = normalizeTriageTemplateLanguage(language)
	filenames := []string{fmt.Sprintf("%s.%s.tmpl", name, language)}
	if language != "en" {
		filenames = append(filenames, fmt.Sprintf("%s.en.tmpl", name))
	}
	for _, dir := range triageTemplateOverrideDirs() {
		for _, filename := range filenames {
			raw, err := os.ReadFile(filepath.Join(dir, filename))
			if err == nil {
				return string(raw), nil
			}
			if !os.IsNotExist(err) {
				return "", fmt.Errorf("read triage template override %s: %w", filename, err)
			}
		}
	}
	for _, filename := range filenames {
		raw, err := triageReplyTemplateFS.ReadFile("templates/triage/" + filename)
		if err == nil {
			return string(raw), nil
		}
	}
	return "", fmt.Errorf("triage template %s (%s) not found", name, language)
}

func triageTemplateOverrideDirs() []string {
	var dirs []string
	if dir := strings.TrimSpace(os.Getenv("ONEESAMA_TRIAGE_TEMPLATE_DIR")); dir != "" {
		dirs = append(dirs, dir)
	}
	if workspaceDir := strings.TrimSpace(os.Getenv("ONEESAMA_SLACK_WORKSPACE_DIR")); workspaceDir != "" {
		dirs = append(dirs, filepath.Join(workspaceDir, "templates", "triage"))
	}
	return dirs
}

func defaultTriageWorkspaceTemplates() []WorkspaceTemplate {
	entries, err := triageReplyTemplateFS.ReadDir("templates/triage")
	if err != nil {
		return nil
	}
	out := make([]WorkspaceTemplate, 0, len(entries))
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		filename := entry.Name()
		raw, err := triageReplyTemplateFS.ReadFile("templates/triage/" + filename)
		if err != nil {
			continue
		}
		out = append(out, WorkspaceTemplate{
			Path:    filepath.ToSlash(filepath.Join("templates", "triage", filename)),
			Content: string(raw),
		})
	}
	return out
}

func sanitizeTriageTemplateName(name string) string {
	name = strings.TrimSpace(name)
	for _, r := range name {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '_' || r == '-' {
			continue
		}
		return ""
	}
	return name
}

func normalizeTriageTemplateLanguage(language string) string {
	switch strings.ToLower(strings.TrimSpace(language)) {
	case "zh", "cn", "zh-cn", "zh_hans", "zh-hans":
		return "zh"
	default:
		return "en"
	}
}

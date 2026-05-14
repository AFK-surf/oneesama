package slackagent

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

type WorkspaceTemplate struct {
	Path    string
	Content string
}

type EnsureWorkspaceFilesOptions struct {
	WorkspaceDir string
	Templates    []WorkspaceTemplate
}

type WorkspaceBootstrapResult struct {
	OK            bool     `json:"ok"`
	WorkspaceDir  string   `json:"workspace_dir,omitempty"`
	TemplateCount int      `json:"template_count,omitempty"`
	Created       []string `json:"created,omitempty"`
	Existing      []string `json:"existing,omitempty"`
	Error         string   `json:"error,omitempty"`
}

func EnsureWorkspaceFiles(options EnsureWorkspaceFilesOptions) WorkspaceBootstrapResult {
	workspaceDir := strings.TrimSpace(options.WorkspaceDir)
	if workspaceDir == "" {
		return WorkspaceBootstrapResult{OK: false, Error: "workspace_dir_required"}
	}

	templates := options.Templates
	if len(templates) == 0 {
		templates = DefaultWorkspaceTemplates
	}
	if err := os.MkdirAll(workspaceDir, 0o755); err != nil {
		return WorkspaceBootstrapResult{OK: false, Error: fmt.Sprintf("create workspace dir: %v", err)}
	}

	created := make([]string, 0, len(templates))
	existing := make([]string, 0, len(templates))
	for _, template := range templates {
		relPath := strings.TrimSpace(template.Path)
		if relPath == "" {
			continue
		}
		targetPath, err := assertPathInside(workspaceDir, relPath)
		if err != nil {
			return WorkspaceBootstrapResult{OK: false, Error: err.Error()}
		}
		if err := os.MkdirAll(filepath.Dir(targetPath), 0o755); err != nil {
			return WorkspaceBootstrapResult{OK: false, Error: fmt.Sprintf("create template dir: %v", err)}
		}
		if _, err := os.Stat(targetPath); err == nil {
			existing = append(existing, relPath)
			continue
		}
		if err := os.WriteFile(targetPath, []byte(template.Content), 0o644); err != nil {
			return WorkspaceBootstrapResult{OK: false, Error: fmt.Sprintf("write template file: %v", err)}
		}
		created = append(created, relPath)
	}

	absoluteDir, _ := filepath.Abs(workspaceDir)
	return WorkspaceBootstrapResult{
		OK:            true,
		WorkspaceDir:  absoluteDir,
		TemplateCount: len(templates),
		Created:       created,
		Existing:      existing,
	}
}

func assertPathInside(rootDir string, relativePath string) (string, error) {
	root := filepath.Clean(rootDir)
	target := filepath.Clean(filepath.Join(root, relativePath))
	rel, err := filepath.Rel(root, target)
	if err != nil {
		return "", fmt.Errorf("resolve workspace template path: %w", err)
	}
	if rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return "", fmt.Errorf("workspace template path escapes root: %s", relativePath)
	}
	return target, nil
}

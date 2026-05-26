package slackagent

import (
	"crypto/sha256"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

type slackWorkspaceFileResolver struct {
	workspaceDir string
}

func uploadPathParam(params map[string]any) string {
	path := strings.TrimSpace(stringFromContext(params, "path"))
	if path != "" {
		return path
	}
	return strings.TrimSpace(stringFromContext(params, "file_path"))
}

func (r slackWorkspaceFileResolver) resolveLocalUploadPath(path string) (string, error) {
	path = strings.TrimSpace(path)
	if path == "" {
		return "", fmt.Errorf("path is required")
	}

	var resolvedPath string
	if filepath.IsAbs(path) {
		resolvedPath = filepath.Clean(path)
	} else {
		if strings.TrimSpace(r.workspaceDir) == "" {
			return "", fmt.Errorf("relative upload paths require a configured workspace directory")
		}
		resolvedPath = filepath.Clean(filepath.Join(r.workspaceDir, path))
	}

	if err := r.ensurePathWithinWorkspace(resolvedPath); err == nil {
		return resolvedPath, nil
	} else if filepath.IsAbs(path) {
		stagedPath, staged, stageErr := r.stageTempUploadPath(resolvedPath)
		if staged {
			if stageErr != nil {
				return "", stageErr
			}
			return stagedPath, nil
		}
		return "", err
	}
	return resolvedPath, nil
}

func (r slackWorkspaceFileResolver) ensurePathWithinWorkspace(path string) error {
	if strings.TrimSpace(r.workspaceDir) == "" {
		return fmt.Errorf("workspace-scoped uploads require a configured workspace directory")
	}

	workspaceRoot, err := filepath.Abs(filepath.Clean(r.workspaceDir))
	if err != nil {
		return fmt.Errorf("resolve workspace directory: %w", err)
	}
	if realWorkspaceRoot, err := filepath.EvalSymlinks(workspaceRoot); err == nil {
		workspaceRoot = realWorkspaceRoot
	}

	resolvedPath, err := filepath.Abs(filepath.Clean(path))
	if err != nil {
		return fmt.Errorf("resolve upload path: %w", err)
	}
	if realResolvedPath, err := filepath.EvalSymlinks(resolvedPath); err == nil {
		resolvedPath = realResolvedPath
	}

	rel, err := filepath.Rel(workspaceRoot, resolvedPath)
	if err != nil {
		return fmt.Errorf("check upload path scope: %w", err)
	}
	if rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return fmt.Errorf("slack-triggered file uploads must stay within the Slack agent workspace: %s", workspaceRoot)
	}
	return nil
}

func (r slackWorkspaceFileResolver) stageTempUploadPath(path string) (string, bool, error) {
	if strings.TrimSpace(r.workspaceDir) == "" {
		return "", false, nil
	}

	resolvedPath, err := filepath.Abs(filepath.Clean(path))
	if err != nil {
		return "", false, fmt.Errorf("resolve upload path: %w", err)
	}
	if realResolvedPath, err := filepath.EvalSymlinks(resolvedPath); err == nil {
		resolvedPath = realResolvedPath
	}

	if !isAutoStagingTempPath(resolvedPath) {
		return "", false, nil
	}

	info, err := os.Stat(resolvedPath)
	if err != nil {
		return "", true, fmt.Errorf("stat %s: %w", resolvedPath, err)
	}
	if info.IsDir() {
		return "", true, fmt.Errorf("path is a directory, not a file: %s", resolvedPath)
	}

	stagingDir := filepath.Join(r.workspaceDir, ".tmp", "slack-upload-staging")
	if err := os.MkdirAll(stagingDir, 0o755); err != nil {
		return "", true, fmt.Errorf("mkdir upload staging dir: %w", err)
	}

	ext := filepath.Ext(resolvedPath)
	base := strings.TrimSuffix(filepath.Base(resolvedPath), ext)
	base = sanitizeFileArtifactTitle(strings.TrimSpace(base))
	if base == "" {
		base = "artifact"
	}
	ref := fileTextReference(strings.Join([]string{
		resolvedPath,
		fmt.Sprintf("%d", info.Size()),
		fmt.Sprintf("%d", info.ModTime().UTC().UnixNano()),
	}, "\n"))
	stagedPath := filepath.Join(stagingDir, fmt.Sprintf("%s-%s%s", base, ref[:8], ext))
	if err := copyFileForSlackUpload(resolvedPath, stagedPath); err != nil {
		return "", true, err
	}
	return stagedPath, true, nil
}

func isAutoStagingTempPath(path string) bool {
	if !isTrustedTempUploadArtifact(filepath.Base(path)) {
		return false
	}
	for _, root := range []string{os.TempDir(), "/tmp", "/var/tmp"} {
		if pathDirectChildOfRoot(root, path) {
			return true
		}
	}
	return false
}

func isTrustedTempUploadArtifact(name string) bool {
	for _, prefix := range []string{"oneesama-upload-", "cueboard-upload-"} {
		if strings.HasPrefix(name, prefix) {
			return true
		}
	}
	return false
}

func pathDirectChildOfRoot(root, path string) bool {
	root = strings.TrimSpace(root)
	if root == "" {
		return false
	}
	cleanRoot, err := filepath.Abs(filepath.Clean(root))
	if err != nil {
		return false
	}
	if realRoot, err := filepath.EvalSymlinks(cleanRoot); err == nil {
		cleanRoot = realRoot
	}

	cleanPath, err := filepath.Abs(filepath.Clean(path))
	if err != nil {
		return false
	}
	if realPath, err := filepath.EvalSymlinks(cleanPath); err == nil {
		cleanPath = realPath
	}

	rel, err := filepath.Rel(cleanRoot, cleanPath)
	if err != nil || rel == "." || rel == ".." {
		return false
	}
	return !strings.Contains(rel, string(filepath.Separator))
}

func pathWithinRoot(root, path string) bool {
	root = strings.TrimSpace(root)
	if root == "" {
		return false
	}
	cleanRoot, err := filepath.Abs(filepath.Clean(root))
	if err != nil {
		return false
	}
	if realRoot, err := filepath.EvalSymlinks(cleanRoot); err == nil {
		cleanRoot = realRoot
	}

	cleanPath, err := filepath.Abs(filepath.Clean(path))
	if err != nil {
		return false
	}
	if realPath, err := filepath.EvalSymlinks(cleanPath); err == nil {
		cleanPath = realPath
	}

	rel, err := filepath.Rel(cleanRoot, cleanPath)
	if err != nil {
		return false
	}
	return rel == "." || (rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)))
}

func copyFileForSlackUpload(srcPath, dstPath string) error {
	src, err := os.Open(srcPath)
	if err != nil {
		return fmt.Errorf("open source file %s: %w", srcPath, err)
	}
	defer func() { _ = src.Close() }()

	dst, err := os.OpenFile(dstPath, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o644)
	if err != nil {
		return fmt.Errorf("create staged upload %s: %w", dstPath, err)
	}
	if _, err := io.Copy(dst, src); err != nil {
		_ = dst.Close()
		return fmt.Errorf("copy staged upload %s: %w", dstPath, err)
	}
	if err := dst.Close(); err != nil {
		return fmt.Errorf("close staged upload %s: %w", dstPath, err)
	}
	return nil
}

func sanitizeFileArtifactTitle(title string) string {
	safeTitle := strings.Map(func(r rune) rune {
		switch r {
		case '/', '\\', ':', '*', '?', '"', '<', '>', '|':
			return '_'
		default:
			return r
		}
	}, title)
	if safeTitle == "" {
		return "meeting"
	}
	return safeTitle
}

func fileTextReference(text string) string {
	normalized := strings.ToLower(strings.TrimSpace(text))
	hash := sha256.Sum256([]byte(normalized))
	return fmt.Sprintf("%x", hash[:8])
}

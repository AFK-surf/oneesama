package meetingagent

import (
	"fmt"
	"path/filepath"
	"strings"
)

type InvalidArtifactsDirError struct {
	Path string
}

func (e InvalidArtifactsDirError) Error() string {
	return fmt.Sprintf("artifacts_dir escapes configured artifacts root: %q", e.Path)
}

func (s *Service) artifactsDirUnderRoot(path string) (string, error) {
	path = strings.TrimSpace(path)
	if path == "" {
		return "", nil
	}
	rootDir, err := filepath.Abs(filepath.Clean(s.pipeline.RootDir()))
	if err != nil {
		return "", fmt.Errorf("resolve artifacts root: %w", err)
	}
	if !filepath.IsAbs(path) {
		path = filepath.Join(rootDir, path)
	}
	cleanPath, err := filepath.Abs(filepath.Clean(path))
	if err != nil {
		return "", fmt.Errorf("resolve artifacts_dir: %w", err)
	}
	if !pathWithinDir(rootDir, cleanPath) {
		return "", InvalidArtifactsDirError{Path: path}
	}
	return cleanPath, nil
}

func (s *Service) artifactFileUnderRoot(path string) (string, error) {
	path = strings.TrimSpace(path)
	if path == "" {
		return "", nil
	}
	rootDir, err := filepath.Abs(filepath.Clean(s.pipeline.RootDir()))
	if err != nil {
		return "", fmt.Errorf("resolve artifacts root: %w", err)
	}
	if !filepath.IsAbs(path) {
		path = filepath.Join(rootDir, path)
	}
	cleanPath, err := filepath.Abs(filepath.Clean(path))
	if err != nil {
		return "", fmt.Errorf("resolve artifact file: %w", err)
	}
	if !pathWithinDir(rootDir, cleanPath) {
		return "", InvalidArtifactsDirError{Path: path}
	}
	if realRoot, err := filepath.EvalSymlinks(rootDir); err == nil {
		if realPath, err := filepath.EvalSymlinks(cleanPath); err == nil && !pathWithinDir(realRoot, realPath) {
			return "", InvalidArtifactsDirError{Path: path}
		}
	}
	return cleanPath, nil
}

func (s *Service) artifactFileUnderArtifactDir(artifactID string, path string) (string, error) {
	if err := validatePostMeetingArtifactID(artifactID); err != nil {
		return "", err
	}
	artifactDir := filepath.Join(s.pipeline.RootDir(), artifactID)
	cleanPath, err := artifactFileUnderDir(artifactDir, path)
	if err != nil {
		return "", err
	}
	if cleanPath == "" {
		return "", nil
	}
	if realDir, err := filepath.EvalSymlinks(artifactDir); err == nil {
		if realPath, err := filepath.EvalSymlinks(cleanPath); err == nil && !pathWithinDir(realDir, realPath) {
			return "", InvalidArtifactsDirError{Path: path}
		}
	}
	return cleanPath, nil
}

func artifactFileUnderDir(dir string, path string) (string, error) {
	path = strings.TrimSpace(path)
	if path == "" {
		return "", nil
	}
	cleanDir, err := filepath.Abs(filepath.Clean(dir))
	if err != nil {
		return "", fmt.Errorf("resolve artifact dir: %w", err)
	}
	if !filepath.IsAbs(path) {
		path = filepath.Join(cleanDir, path)
	}
	cleanPath, err := filepath.Abs(filepath.Clean(path))
	if err != nil {
		return "", fmt.Errorf("resolve artifact file: %w", err)
	}
	if !pathWithinDir(cleanDir, cleanPath) {
		return "", InvalidArtifactsDirError{Path: path}
	}
	return cleanPath, nil
}

func validatePostMeetingArtifactID(id string) error {
	if strings.TrimSpace(id) == "" ||
		strings.TrimSpace(id) != id ||
		id == "." ||
		id == ".." ||
		strings.ContainsAny(id, `/\`) ||
		filepath.Clean(id) != id {
		return fmt.Errorf("invalid artifact id: %q", id)
	}
	return nil
}

func pathWithinDir(dir string, path string) bool {
	rel, err := filepath.Rel(dir, path)
	if err != nil {
		return false
	}
	return rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) && !filepath.IsAbs(rel)
}

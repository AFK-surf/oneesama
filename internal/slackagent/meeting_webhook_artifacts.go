package slackagent

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

type meetingArtifactMaterializer struct {
	workspaceDir string
	meetAgentURL string
	httpClient   *http.Client
}

func (m meetingArtifactMaterializer) materializeMeetingArtifact(ctx context.Context, meetingID int64, localPath, artifactName string) (string, func(), error) {
	if path, cleanup, ok, err := m.materializeLocalMeetingArtifact(localPath, meetingID, artifactName); ok || err != nil {
		return path, cleanup, err
	}
	return m.downloadMeetingArtifact(ctx, meetingID, localPath, artifactName)
}

func (m meetingArtifactMaterializer) materializeLocalMeetingArtifact(localPath string, meetingID int64, artifactName string) (string, func(), bool, error) {
	cleanup := func() {}
	localPath = strings.TrimSpace(localPath)
	if localPath == "" {
		return "", cleanup, false, nil
	}
	info, err := os.Stat(localPath)
	if err != nil || info.IsDir() {
		return "", cleanup, false, nil
	}
	if strings.TrimSpace(m.workspaceDir) == "" || m.ensurePathWithinWorkspace(localPath) == nil {
		return localPath, cleanup, true, nil
	}
	stagedPath, stagedCleanup, err := m.stageMeetingArtifactFromFile(localPath, meetingID, artifactName)
	if err != nil {
		return "", cleanup, true, fmt.Errorf("stage local %s artifact: %w", artifactName, err)
	}
	return stagedPath, stagedCleanup, true, nil
}

func (m meetingArtifactMaterializer) downloadMeetingArtifact(ctx context.Context, meetingID int64, localPath, artifactName string) (string, func(), error) {
	cleanup := func() {}
	baseURL := strings.TrimRight(strings.TrimSpace(m.meetAgentURL), "/")
	if baseURL == "" {
		if strings.TrimSpace(localPath) != "" {
			return "", cleanup, fmt.Errorf("local artifact %q is not readable and no meeting agent URL is configured", localPath)
		}
		return "", cleanup, fmt.Errorf("no meeting agent URL configured for remote %s download", artifactName)
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, fmt.Sprintf("%s/meetings/%d/artifacts/%s", baseURL, meetingID, artifactName), nil)
	if err != nil {
		return "", cleanup, fmt.Errorf("create remote %s artifact request: %w", artifactName, err)
	}
	client := m.httpClient
	if client == nil {
		client = http.DefaultClient
	}
	response, err := client.Do(request)
	if err != nil {
		return "", cleanup, fmt.Errorf("download remote %s artifact: %w", artifactName, err)
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return "", cleanup, fmt.Errorf("download remote %s artifact: status %d", artifactName, response.StatusCode)
	}
	body, err := io.ReadAll(response.Body)
	if err != nil {
		return "", cleanup, fmt.Errorf("read remote %s artifact: %w", artifactName, err)
	}
	tmpDir, err := m.meetingArtifactStagingDir(meetingID, artifactName)
	if err != nil {
		return "", cleanup, fmt.Errorf("create temp dir for %s artifact: %w", artifactName, err)
	}
	cleanup = func() { _ = os.RemoveAll(tmpDir) }
	tmpPath := filepath.Join(tmpDir, meetingArtifactFileName(artifactName, body))
	if err := os.WriteFile(tmpPath, body, 0o644); err != nil {
		cleanup()
		return "", func() {}, fmt.Errorf("write temp %s artifact: %w", artifactName, err)
	}
	return tmpPath, cleanup, nil
}

func (m meetingArtifactMaterializer) stageMeetingArtifactFromFile(srcPath string, meetingID int64, artifactName string) (string, func(), error) {
	tmpDir, err := m.meetingArtifactStagingDir(meetingID, artifactName)
	if err != nil {
		return "", func() {}, err
	}
	cleanup := func() { _ = os.RemoveAll(tmpDir) }
	dstPath := filepath.Join(tmpDir, filepath.Base(srcPath))
	if err := copyFileForSlackUpload(srcPath, dstPath); err != nil {
		cleanup()
		return "", func() {}, err
	}
	return dstPath, cleanup, nil
}

func (m meetingArtifactMaterializer) meetingArtifactStagingDir(meetingID int64, artifactName string) (string, error) {
	if strings.TrimSpace(m.workspaceDir) != "" {
		baseDir := filepath.Join(m.workspaceDir, ".tmp", "meeting-artifacts")
		if err := os.MkdirAll(baseDir, 0o755); err != nil {
			return "", fmt.Errorf("mkdir workspace artifact staging dir: %w", err)
		}
		return os.MkdirTemp(baseDir, fmt.Sprintf("meeting-%d-%s-", meetingID, artifactName))
	}
	return os.MkdirTemp("", fmt.Sprintf("oneesama-meeting-%d-%s-", meetingID, artifactName))
}

func (m meetingArtifactMaterializer) ensurePathWithinWorkspace(path string) error {
	return slackWorkspaceFileResolver{workspaceDir: m.workspaceDir}.ensurePathWithinWorkspace(path)
}

func meetingArtifactFileName(artifactName string, body []byte) string {
	switch artifactName {
	case "transcript":
		return "transcript.txt"
	case "audio":
		return "audio" + sniffMeetingAudioArtifactExtension(body)
	default:
		return "artifact.bin"
	}
}

func sniffMeetingAudioArtifactExtension(body []byte) string {
	if len(body) >= 12 && bytes.Equal(body[:4], []byte("RIFF")) && bytes.Equal(body[8:12], []byte("WAVE")) {
		return ".wav"
	}
	if len(body) >= 3 && bytes.Equal(body[:3], []byte("ID3")) {
		return ".mp3"
	}
	if len(body) >= 2 && body[0] == 0xff && body[1]&0xe0 == 0xe0 {
		return ".mp3"
	}
	return ".wav"
}

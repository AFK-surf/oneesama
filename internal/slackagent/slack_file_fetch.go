package slackagent

import (
	"context"
	"encoding/base64"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

const (
	defaultFileDownloadByteCap = int64(64 * 1024 * 1024) // 64 MiB hard cap
	defaultFileInlineBudget    = int64(512 * 1024)       // 512 KiB inline base64 budget
)

func (t *slackAPITool) actionFetchFile(ctx context.Context, params map[string]any) slackAPIToolResult {
	fileID := strings.TrimSpace(firstNonEmpty(
		stringFromAny(params["file_id"]),
		stringFromAny(params["fileId"]),
		stringFromAny(params["file"]),
		stringFromAny(params["id"]),
	))
	if fileID == "" {
		return slackAPIToolResult{
			Success: false,
			Text:    "file_id is required for slack.fetchFile (Slack file ID, e.g. F0ABCDEF)",
		}
	}

	info, err := t.fetchSlackFileInfo(ctx, fileID)
	if err != nil {
		return slackAPIToolResult{Success: false, Text: "Failed to fetch file: " + err.Error()}
	}
	if !info.OK {
		return slackAPIToolResult{Success: false, Text: "Failed to fetch file: " + firstNonEmpty(info.Error, "slack_api_error")}
	}

	downloadURL := strings.TrimSpace(firstNonEmpty(info.File.URLPrivateDownload, info.File.URLPrivate))
	if downloadURL == "" {
		return slackAPIToolResult{
			Success: false,
			Text:    "Slack file has no downloadable URL; check that the bot is in the channel hosting the file.",
		}
	}

	download := boolFromAny(params["download"], true)
	inline := boolFromAny(params["inline"], false)
	inlineBudget := defaultFileInlineBudget
	if limit := intFromAny(params["inline_limit"]); limit > 0 {
		inlineBudget = int64(limit)
	}
	downloadCap := defaultFileDownloadByteCap
	if limit := intFromAny(params["max_bytes"]); limit > 0 {
		downloadCap = int64(limit)
	}

	payload := map[string]any{
		"ok":         true,
		"file_id":    info.File.ID,
		"title":      firstNonEmpty(info.File.Title, info.File.Name),
		"name":       info.File.Name,
		"permalink":  info.File.Permalink,
		"mimetype":   info.File.Mimetype,
		"filetype":   info.File.Filetype,
		"size_bytes": info.File.Size,
		"url":        downloadURL,
		"downloaded": false,
		"inline":     false,
	}

	if download {
		localPath, downloadedBytes, downloadErr := t.downloadSlackFileToLocalArtifact(ctx, info.File, downloadURL, downloadCap)
		if downloadErr != nil {
			return slackAPIToolResult{Success: false, Text: "Failed to download file: " + downloadErr.Error()}
		}
		payload["downloaded"] = true
		payload["downloaded_bytes"] = downloadedBytes
		payload["local_path"] = localPath
		if inline {
			if downloadedBytes > inlineBudget {
				payload["inline_skipped_reason"] = fmt.Sprintf("file %d bytes exceeds inline budget %d; use local_path", downloadedBytes, inlineBudget)
			} else {
				raw, readErr := os.ReadFile(localPath)
				if readErr != nil {
					return slackAPIToolResult{Success: false, Text: "Failed to inline downloaded file: " + readErr.Error()}
				}
				encoded := base64.StdEncoding.EncodeToString(raw)
				payload["inline"] = true
				payload["base64"] = encoded
				payload["base64_bytes"] = len(encoded)
				payload["mime_data_url"] = fmt.Sprintf("data:%s;base64,%s", firstNonEmpty(info.File.Mimetype, "application/octet-stream"), encoded)
			}
		}
	}

	result, jsonErr := slackAPIJSONTextResult(payload)
	if jsonErr != nil {
		return slackAPIToolResult{Success: false, Text: "Failed to encode file result: " + jsonErr.Error()}
	}
	return result
}

func (t *slackAPITool) downloadSlackFileToLocalArtifact(ctx context.Context, file slackImageFileBody, downloadURL string, byteCap int64) (string, int64, error) {
	if byteCap <= 0 {
		byteCap = defaultFileDownloadByteCap
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, downloadURL, nil)
	if err != nil {
		return "", 0, fmt.Errorf("build file request: %w", err)
	}
	if token := strings.TrimSpace(t.token); token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	client := &http.Client{Transport: t.httpTransport}
	if client.Transport == nil {
		client.Transport = http.DefaultTransport
	}
	resp, err := client.Do(req)
	if err != nil {
		return "", 0, fmt.Errorf("file request failed: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return "", 0, fmt.Errorf("file download returned %s", resp.Status)
	}
	if resp.ContentLength > byteCap {
		return "", 0, fmt.Errorf("file exceeds %d byte safety cap", byteCap)
	}

	dir, err := t.slackFileArtifactDir()
	if err != nil {
		return "", 0, err
	}
	base := sanitizeSlackDownloadedFileName(firstNonEmpty(file.Name, file.Title, file.ID, "slack-file"))
	ref := fileTextReference(strings.Join([]string{file.ID, file.Name, file.Permalink, downloadURL}, "\n"))
	fileID := sanitizeSlackDownloadedFileName(firstNonEmpty(file.ID, "file"))
	localPath := filepath.Join(dir, fmt.Sprintf("%s-%s-%s", fileID, ref[:8], base))
	out, err := os.OpenFile(localPath, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o644)
	if err != nil {
		return "", 0, fmt.Errorf("create artifact: %w", err)
	}
	limited := io.LimitReader(resp.Body, byteCap+1)
	written, copyErr := io.Copy(out, limited)
	closeErr := out.Close()
	if copyErr != nil {
		_ = os.Remove(localPath)
		return "", 0, fmt.Errorf("write artifact: %w", copyErr)
	}
	if closeErr != nil {
		_ = os.Remove(localPath)
		return "", 0, fmt.Errorf("close artifact: %w", closeErr)
	}
	if written > byteCap {
		_ = os.Remove(localPath)
		return "", 0, fmt.Errorf("file exceeds %d byte safety cap", byteCap)
	}
	return localPath, written, nil
}

func (t *slackAPITool) slackFileArtifactDir() (string, error) {
	root := strings.TrimSpace(t.workspaceDir)
	if root == "" {
		root = filepath.Join(os.TempDir(), "oneesama-slack-file-fetch")
	} else {
		root = filepath.Join(root, ".tmp", "slack-file-fetch")
	}
	if err := os.MkdirAll(root, 0o755); err != nil {
		return "", fmt.Errorf("mkdir slack file artifact dir: %w", err)
	}
	return root, nil
}

func sanitizeSlackDownloadedFileName(name string) string {
	name = strings.TrimSpace(filepath.Base(name))
	name = sanitizeFileArtifactTitle(name)
	name = strings.TrimSpace(name)
	if name == "" || name == "." || name == string(filepath.Separator) {
		return "slack-file"
	}
	return name
}

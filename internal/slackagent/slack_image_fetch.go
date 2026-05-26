package slackagent

import (
	"context"
	"encoding/base64"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path"
	"strings"
)

// slack.fetch_image implementation. Mirrors the canvas-fetch shape — discover
// the file via files.info, GET the protected URL with the bot token, and
// return a structured tool result the model can consume as a workspace
// context artifact. This is NOT image generation; it is read-only ingestion
// of an image that already exists in Slack so the LLM can "see" it.

const (
	defaultImageDownloadByteCap = int64(8 * 1024 * 1024) // 8 MiB hard cap
	defaultImageInlineBudget    = int64(512 * 1024)      // 512 KiB inline base64 budget
)

var slackImageMimePrefixes = []string{"image/"}
var slackImageFiletypes = map[string]struct{}{
	"png":  {},
	"jpg":  {},
	"jpeg": {},
	"gif":  {},
	"webp": {},
	"bmp":  {},
	"heic": {},
	"heif": {},
	"svg":  {},
}

type slackImageFileBody struct {
	ID                 string `json:"id,omitempty"`
	Name               string `json:"name,omitempty"`
	Title              string `json:"title,omitempty"`
	Mimetype           string `json:"mimetype,omitempty"`
	Filetype           string `json:"filetype,omitempty"`
	Size               int64  `json:"size,omitempty"`
	Permalink          string `json:"permalink,omitempty"`
	URLPrivate         string `json:"url_private,omitempty"`
	URLPrivateDownload string `json:"url_private_download,omitempty"`
}

type slackImageFile struct {
	OK    bool               `json:"ok"`
	File  slackImageFileBody `json:"file"`
	Error string             `json:"error,omitempty"`
}

func (t *slackAPITool) actionFetchImage(ctx context.Context, params map[string]any) slackAPIToolResult {
	fileID := strings.TrimSpace(firstNonEmpty(
		stringFromAny(params["file_id"]),
		stringFromAny(params["fileId"]),
		stringFromAny(params["image_id"]),
		stringFromAny(params["imageId"]),
		stringFromAny(params["file"]),
	))
	if fileID == "" {
		return slackAPIToolResult{
			Success: false,
			Text:    "file_id is required for slack.fetch_image (Slack image file ID, e.g. F0ABCDEF)",
		}
	}

	inline := boolFromAny(params["inline"], true)
	inlineBudget := defaultImageInlineBudget
	if limit := intFromAny(params["inline_limit"]); limit > 0 {
		inlineBudget = int64(limit)
	}

	info, err := t.fetchSlackFileInfo(ctx, fileID)
	if err != nil {
		return slackAPIToolResult{Success: false, Text: "Failed to fetch image: " + err.Error()}
	}
	if !info.OK {
		return slackAPIToolResult{Success: false, Text: "Failed to fetch image: " + firstNonEmpty(info.Error, "slack_api_error")}
	}
	if !imageFileBodyIsImage(info.File) {
		return slackAPIToolResult{
			Success: false,
			Text:    fmt.Sprintf("File %s is not an image (filetype=%q, mimetype=%q)", fileID, info.File.Filetype, info.File.Mimetype),
		}
	}

	downloadURL := strings.TrimSpace(firstNonEmpty(info.File.URLPrivateDownload, info.File.URLPrivate))
	if downloadURL == "" {
		return slackAPIToolResult{
			Success: false,
			Text:    "Image file has no downloadable URL; check that the bot is in the channel hosting the file.",
		}
	}

	download := boolFromAny(params["download"], true)
	payload := map[string]any{
		"ok":                    true,
		"file_id":               info.File.ID,
		"title":                 firstNonEmpty(info.File.Title, info.File.Name),
		"name":                  info.File.Name,
		"permalink":             info.File.Permalink,
		"mimetype":              info.File.Mimetype,
		"filetype":              info.File.Filetype,
		"size_bytes":            info.File.Size,
		"protected_url_omitted": true,
		"url_access":            "slack_bot_token_required",
		"worker_hint":           "Use local_path for worker-side image inspection. Protected Slack image URLs are omitted from worker-visible results because they require the bot token.",
		"downloaded":            false,
		"inline":                false,
		"local_path":            "",
		"downloaded_bytes":      0,
		"download_disabled":     !download,
	}

	if download {
		localPath, downloadedBytes, downloadErr := t.downloadSlackFileToLocalArtifact(ctx, info.File, downloadURL, defaultImageDownloadByteCap)
		if downloadErr != nil {
			return slackAPIToolResult{Success: false, Text: "Failed to download image: " + downloadErr.Error()}
		}
		payload["downloaded"] = true
		payload["downloaded_bytes"] = downloadedBytes
		payload["local_path"] = localPath
		if inline && downloadedBytes <= inlineBudget {
			raw, readErr := os.ReadFile(localPath)
			if readErr != nil {
				return slackAPIToolResult{Success: false, Text: "Failed to inline downloaded image: " + readErr.Error()}
			}
			payload["inline"] = true
			payload["base64"] = base64.StdEncoding.EncodeToString(raw)
			payload["base64_bytes"] = len(payload["base64"].(string))
			payload["mime_data_url"] = fmt.Sprintf("data:%s;base64,%s", firstNonEmpty(info.File.Mimetype, "application/octet-stream"), payload["base64"])
		} else if inline {
			payload["inline_skipped_reason"] = fmt.Sprintf("image %d bytes exceeds inline budget %d; use local_path", downloadedBytes, inlineBudget)
		}
	}

	result, jsonErr := slackAPIJSONTextResult(payload)
	if jsonErr != nil {
		return slackAPIToolResult{Success: false, Text: "Failed to encode image result: " + jsonErr.Error()}
	}
	return result
}

func (t *slackAPITool) fetchSlackFileInfo(ctx context.Context, fileID string) (*slackImageFile, error) {
	values := url.Values{"file": {fileID}}
	var info slackImageFile
	result := t.callSlackGET(ctx, t.apiURL, "files.info", values, &info)
	if !result.OK {
		return nil, fmt.Errorf("%s", firstNonEmpty(result.Error, result.Detail, "files.info_failed"))
	}
	return &info, nil
}

func (t *slackAPITool) downloadImageBytes(ctx context.Context, downloadURL string) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, downloadURL, nil)
	if err != nil {
		return nil, fmt.Errorf("build image request: %w", err)
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
		return nil, fmt.Errorf("image request failed: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("image download returned %s", resp.Status)
	}
	limited := io.LimitReader(resp.Body, defaultImageDownloadByteCap+1)
	body, err := io.ReadAll(limited)
	if err != nil {
		return nil, fmt.Errorf("image read failed: %w", err)
	}
	if int64(len(body)) > defaultImageDownloadByteCap {
		return nil, fmt.Errorf("image exceeds %d byte safety cap", defaultImageDownloadByteCap)
	}
	return body, nil
}

func imageFileBodyIsImage(file slackImageFileBody) bool {
	mime := strings.ToLower(strings.TrimSpace(file.Mimetype))
	for _, prefix := range slackImageMimePrefixes {
		if strings.HasPrefix(mime, prefix) {
			return true
		}
	}
	filetype := strings.ToLower(strings.TrimSpace(file.Filetype))
	if _, ok := slackImageFiletypes[filetype]; ok {
		return true
	}
	// As a final fallback, accept file extensions on the name when mimetype
	// and filetype both came back empty — Slack occasionally omits them for
	// files attached from outside the workspace.
	ext := strings.ToLower(strings.TrimPrefix(path.Ext(file.Name), "."))
	if _, ok := slackImageFiletypes[ext]; ok {
		return true
	}
	return false
}

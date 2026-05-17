package slackagent

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
)

// slack.fetch_canvas implementation. Walks files.info to discover the
// canvas's private HTML download URL, downloads it with the bot token,
// converts HTML→markdown, and trims to a safety budget so a single canvas
// cannot blow out the assistant prompt or tool result size limits.

const (
	defaultCanvasMarkdownSizeLimit = 8000
	defaultCanvasHTMLFetchLimit    = int64(512 * 1024) // 512 KiB raw HTML cap
)

type slackCanvasFile struct {
	OK    bool `json:"ok"`
	File  slackCanvasFileBody
	Error string `json:"error,omitempty"`
}

type slackCanvasFileBody struct {
	ID                       string `json:"id,omitempty"`
	Title                    string `json:"title,omitempty"`
	Filetype                 string `json:"filetype,omitempty"`
	Mimetype                 string `json:"mimetype,omitempty"`
	Mode                     string `json:"mode,omitempty"`
	Permalink                string `json:"permalink,omitempty"`
	URLPrivate               string `json:"url_private,omitempty"`
	URLPrivateDownload       string `json:"url_private_download,omitempty"`
	CanvasURLPrivateDownload string `json:"canvas_url_private_download,omitempty"`
}

// UnmarshalJSON lets the response decode "file" either as a struct or as a
// top-level alias depending on whether Slack returned files.info with a
// single file or wrapped form. Both paths land in s.File so callers don't
// have to know the variant.
func (s *slackCanvasFile) UnmarshalJSON(data []byte) error {
	var probe struct {
		OK    bool                `json:"ok"`
		Error string              `json:"error,omitempty"`
		File  slackCanvasFileBody `json:"file"`
	}
	if err := json.Unmarshal(data, &probe); err != nil {
		return err
	}
	s.OK = probe.OK
	s.Error = probe.Error
	s.File = probe.File
	return nil
}

func (t *slackAPITool) actionFetchCanvas(ctx context.Context, params map[string]any) slackAPIToolResult {
	fileID := strings.TrimSpace(firstNonEmpty(
		stringFromAny(params["file_id"]),
		stringFromAny(params["fileId"]),
		stringFromAny(params["canvas_id"]),
		stringFromAny(params["canvasId"]),
		stringFromAny(params["file"]),
	))
	if fileID == "" {
		return slackAPIToolResult{
			Success: false,
			Text:    "file_id is required for slack.fetch_canvas (Slack canvas file ID, e.g. F0ABCDEF)",
		}
	}
	sizeLimit := intFromAny(params["limit"])
	if sizeLimit <= 0 {
		sizeLimit = defaultCanvasMarkdownSizeLimit
	}

	info, err := t.fetchCanvasFileInfo(ctx, fileID)
	if err != nil {
		return slackAPIToolResult{Success: false, Text: "Failed to fetch canvas: " + err.Error()}
	}
	if !info.OK {
		return slackAPIToolResult{Success: false, Text: "Failed to fetch canvas: " + firstNonEmpty(info.Error, "slack_api_error")}
	}
	if !canvasFileBodyIsCanvas(info.File) {
		return slackAPIToolResult{
			Success: false,
			Text:    fmt.Sprintf("File %s is not a Slack canvas (mode=%q, filetype=%q)", fileID, info.File.Mode, info.File.Filetype),
		}
	}

	downloadURL := strings.TrimSpace(firstNonEmpty(
		info.File.CanvasURLPrivateDownload,
		info.File.URLPrivateDownload,
		info.File.URLPrivate,
	))
	if downloadURL == "" {
		return slackAPIToolResult{Success: false, Text: "Canvas file has no downloadable URL; check that the bot is in the channel hosting the canvas."}
	}

	html, err := t.downloadCanvasHTML(ctx, downloadURL)
	if err != nil {
		return slackAPIToolResult{Success: false, Text: "Failed to download canvas: " + err.Error()}
	}
	markdown := strings.TrimSpace(htmlToMarkdown(html))
	if markdown == "" {
		return slackAPIToolResult{Success: false, Text: "Canvas body was empty after HTML conversion"}
	}
	truncated, didTrim := truncateCanvasMarkdown(markdown, sizeLimit)
	result, jsonErr := slackAPIJSONTextResult(map[string]any{
		"ok":         true,
		"file_id":    info.File.ID,
		"title":      info.File.Title,
		"permalink":  info.File.Permalink,
		"markdown":   truncated,
		"size_bytes": len(truncated),
		"truncated":  didTrim,
	})
	if jsonErr != nil {
		return slackAPIToolResult{Success: false, Text: "Failed to encode canvas result: " + jsonErr.Error()}
	}
	return result
}

func (t *slackAPITool) fetchCanvasFileInfo(ctx context.Context, fileID string) (*slackCanvasFile, error) {
	values := url.Values{"file": {fileID}}
	var info slackCanvasFile
	result := t.callSlackGET(ctx, t.apiURL, "files.info", values, &info)
	if !result.OK {
		return nil, fmt.Errorf("%s", firstNonEmpty(result.Error, result.Detail, "files.info_failed"))
	}
	return &info, nil
}

func (t *slackAPITool) downloadCanvasHTML(ctx context.Context, downloadURL string) (string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, downloadURL, nil)
	if err != nil {
		return "", fmt.Errorf("build canvas request: %w", err)
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
		return "", fmt.Errorf("canvas request failed: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return "", fmt.Errorf("canvas download returned %s", resp.Status)
	}
	limited := io.LimitReader(resp.Body, defaultCanvasHTMLFetchLimit+1)
	body, err := io.ReadAll(limited)
	if err != nil {
		return "", fmt.Errorf("canvas read failed: %w", err)
	}
	if int64(len(body)) > defaultCanvasHTMLFetchLimit {
		return "", fmt.Errorf("canvas HTML exceeds %d byte safety cap", defaultCanvasHTMLFetchLimit)
	}
	return string(body), nil
}

func canvasFileBodyIsCanvas(file slackCanvasFileBody) bool {
	mode := strings.ToLower(strings.TrimSpace(file.Mode))
	if mode == "canvas" || mode == "channel_canvas" {
		return true
	}
	filetype := strings.ToLower(strings.TrimSpace(file.Filetype))
	if filetype == "canvas" || filetype == "quip" {
		return true
	}
	if strings.Contains(strings.ToLower(file.Mimetype), "canvas") {
		return true
	}
	return false
}

// truncateCanvasMarkdown trims a converted canvas body to the configured
// byte budget. The cut happens on a UTF-8 boundary so the returned string is
// always valid UTF-8, and the helper appends a short "[truncated …]" tag so
// downstream readers can see the artifact was clipped.
func truncateCanvasMarkdown(markdown string, limit int) (string, bool) {
	if limit <= 0 || len(markdown) <= limit {
		return markdown, false
	}
	cut := limit
	for cut > 0 && !validUTF8Boundary(markdown[:cut]) {
		cut--
	}
	if cut <= 0 {
		cut = limit
	}
	return markdown[:cut] + "\n\n[truncated — canvas exceeded fetch budget]", true
}

func validUTF8Boundary(s string) bool {
	if len(s) == 0 {
		return true
	}
	r := []rune(s)
	return len(string(r)) == len(s)
}

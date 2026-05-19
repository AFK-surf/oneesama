package slackagent

import (
	"context"
	"net/http"
	"strings"
)

func (t *slackAPITool) actionCreateCanvas(ctx context.Context, params map[string]any) slackAPIToolResult {
	title := strings.TrimSpace(stringFromAny(params["title"]))
	markdown := strings.TrimSpace(stringFromAny(params["markdown"]))
	channel := strings.TrimSpace(firstNonEmpty(
		stringFromAny(params["channel"]),
		stringFromAny(params["channel_id"]),
		stringFromAny(params["channelId"]),
	))
	if title == "" || markdown == "" {
		return slackAPIToolResult{
			Success: false,
			Text:    "title and markdown are required for slack.create_canvas",
		}
	}
	result := t.createSlackCanvasWithRetry(ctx, title, markdown, channel)
	return t.slackCanvasToolResult(result, map[string]any{
		"ok":        result.OK,
		"method":    result.Method,
		"canvas_id": result.CanvasID,
		"team_id":   result.TeamID,
		"permalink": slackCanvasToolPermalink(result),
		"error":     result.Error,
		"detail":    result.Detail,
		"shared_to": channel,
	})
}

func (t *slackAPITool) actionEditCanvas(ctx context.Context, params map[string]any) slackAPIToolResult {
	canvasID := strings.TrimSpace(firstNonEmpty(
		stringFromAny(params["canvas_id"]),
		stringFromAny(params["canvasId"]),
		stringFromAny(params["file_id"]),
		stringFromAny(params["fileId"]),
	))
	markdown := strings.TrimSpace(stringFromAny(params["markdown"]))
	operation := strings.TrimSpace(firstNonEmpty(
		stringFromAny(params["operation"]),
		stringFromAny(params["op"]),
	))
	if operation == "" {
		operation = "insert_at_end"
	}
	sectionID := strings.TrimSpace(firstNonEmpty(
		stringFromAny(params["section_id"]),
		stringFromAny(params["sectionId"]),
	))
	if canvasID == "" || markdown == "" {
		return slackAPIToolResult{
			Success: false,
			Text:    "canvas_id and markdown are required for slack.edit_canvas",
		}
	}
	result := t.editSlackCanvasWithRetry(ctx, canvasID, markdown, operation, sectionID)
	return t.slackCanvasToolResult(result, map[string]any{
		"ok":         result.OK,
		"method":     result.Method,
		"canvas_id":  canvasID,
		"operation":  operation,
		"section_id": sectionID,
		"error":      result.Error,
		"detail":     result.Detail,
	})
}

func (t *slackAPITool) createSlackCanvasWithRetry(ctx context.Context, title string, markdown string, channel string) SlackCanvasAPIResult {
	result := CreateSlackCanvas(ctx, t.slackCanvasHTTPClient(), t.token, t.apiURL, title, markdown, channel)
	if !result.OK && canvasErrorIsValidationFailure(result.Error) {
		sanitized := sanitizeMarkdownForSlackCanvas(markdown)
		if sanitized != "" && sanitized != markdown {
			retry := CreateSlackCanvas(ctx, t.slackCanvasHTTPClient(), t.token, t.apiURL, title, sanitized, channel)
			if retry.OK {
				retry.Detail = recordCanvasSanitizeFallback(retry.Detail, result.Error)
				return retry
			}
		}
	}
	return result
}

func (t *slackAPITool) editSlackCanvasWithRetry(ctx context.Context, canvasID string, markdown string, operation string, sectionID string) SlackCanvasAPIResult {
	result := EditSlackCanvas(ctx, t.slackCanvasHTTPClient(), t.token, t.apiURL, canvasID, markdown, operation, sectionID)
	if !result.OK && canvasErrorIsValidationFailure(result.Error) {
		sanitized := sanitizeMarkdownForSlackCanvas(markdown)
		if sanitized != "" && sanitized != markdown {
			retry := EditSlackCanvas(ctx, t.slackCanvasHTTPClient(), t.token, t.apiURL, canvasID, sanitized, operation, sectionID)
			if retry.OK {
				retry.Detail = recordCanvasSanitizeFallback(retry.Detail, result.Error)
				return retry
			}
		}
	}
	return result
}

func (t *slackAPITool) slackCanvasHTTPClient() *http.Client {
	client := &http.Client{Transport: t.httpTransport}
	if client.Transport == nil {
		client.Transport = http.DefaultTransport
	}
	return client
}

func (t *slackAPITool) slackCanvasToolResult(result SlackCanvasAPIResult, payload map[string]any) slackAPIToolResult {
	encoded, err := slackAPIJSONTextResult(payload)
	if err != nil {
		return slackAPIToolResult{Success: false, Text: "Failed to encode canvas result: " + err.Error()}
	}
	encoded.Success = result.OK
	return encoded
}

func slackCanvasToolPermalink(result SlackCanvasAPIResult) string {
	permalink := strings.TrimSpace(result.Permalink)
	if permalink != "" {
		return permalink
	}
	if result.Body != nil && strings.TrimSpace(result.Body.URL) != "" {
		return strings.TrimSpace(result.Body.URL)
	}
	return slackCanvasPermalink(result.TeamID, result.CanvasID)
}

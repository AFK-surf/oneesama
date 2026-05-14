package meetingagent

import (
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"

	"github.com/gin-gonic/gin"
)

func (h *Handler) handleStageMediaVideo(c *gin.Context) {
	filePath, ok := h.resolveStageVideoPath(c.Query("path"))
	if !ok {
		c.JSON(http.StatusForbidden, gin.H{"ok": false, "error": "stage_video_path_forbidden"})
		return
	}
	if _, err := os.Stat(filePath); err != nil {
		c.JSON(http.StatusNotFound, gin.H{"ok": false, "error": "stage_video_not_found"})
		return
	}
	c.Header("Content-Type", videoContentType(filePath))
	c.File(filePath)
}

func (h *Handler) stageVideoURL(request *http.Request, raw string) string {
	trimmed := strings.TrimSpace(raw)
	if !isLocalVideoPath(trimmed) {
		return trimmed
	}
	absolute, err := filepath.Abs(trimmed)
	if err != nil {
		absolute = trimmed
	}
	return requestBaseURL(request) + "/stage-media/video?path=" + url.QueryEscape(absolute)
}

func (h *Handler) resolveStageVideoPath(raw string) (string, bool) {
	filePath, err := filepath.Abs(strings.TrimSpace(raw))
	if err != nil || filePath == "" {
		return "", false
	}
	for _, root := range h.stageVideoAllowedRoots() {
		if pathInside(root, filePath) {
			return filePath, true
		}
	}
	return "", false
}

func (h *Handler) stageVideoAllowedRoots() []string {
	return []string{
		"tmp",
		h.service.persistence.DataDir,
		h.service.pipeline.RootDir(),
		"/tmp",
	}
}

func isLocalVideoPath(value string) bool {
	raw := strings.TrimSpace(value)
	if raw == "" || strings.Contains(raw, "://") {
		return false
	}
	switch strings.ToLower(filepath.Ext(raw)) {
	case ".mp4", ".webm", ".mov", ".m4v":
		return true
	default:
		return false
	}
}

func videoContentType(filePath string) string {
	switch strings.ToLower(filepath.Ext(filePath)) {
	case ".webm":
		return "video/webm"
	case ".mov":
		return "video/quicktime"
	default:
		return "video/mp4"
	}
}

func pathInside(root string, target string) bool {
	absoluteRoot, err := filepath.Abs(strings.TrimSpace(root))
	if err != nil || absoluteRoot == "" {
		return false
	}
	rel, err := filepath.Rel(absoluteRoot, target)
	if err != nil {
		return false
	}
	return rel != "." && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator))
}

func requestBaseURL(request *http.Request) string {
	scheme := "http"
	if request.TLS != nil || strings.EqualFold(strings.TrimSpace(request.Header.Get("X-Forwarded-Proto")), "https") {
		scheme = "https"
	}
	host := request.Host
	if strings.HasPrefix(host, "0.0.0.0:") {
		host = "127.0.0.1:" + strings.TrimPrefix(host, "0.0.0.0:")
	}
	return scheme + "://" + host
}

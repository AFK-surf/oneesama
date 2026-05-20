package slackagent

import (
	"context"
	"fmt"
	"html"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/AFK-surf/oneesama/internal/httputil"
)

const (
	slackExternalLinkFetchLimit     = 3
	slackExternalLinkFetchBodyLimit = 512 << 10
)

var (
	slackExternalLinkHTTPClient   = httputil.NewHTTPClient(8 * time.Second)
	slackExternalLinkReaderURL    = func(rawURL string) string { return "https://r.jina.ai/http://" + rawURL }
	slackExternalSearchHTTPClient = httputil.NewHTTPClient(8 * time.Second)
	slackExternalSearchURL        = func(query string) string {
		return "https://r.jina.ai/http://duckduckgo.com/html/?q=" + url.QueryEscape(query)
	}
)

type SlackExternalLinkContext struct {
	URL     string `json:"url"`
	Title   string `json:"title,omitempty"`
	Excerpt string `json:"excerpt,omitempty"`
	Source  string `json:"source,omitempty"`
	Error   string `json:"error,omitempty"`
}

func fetchSlackExternalLinkContexts(ctx context.Context, messages []SlackInboundMessage) []SlackExternalLinkContext {
	urls := extractSlackExternalLinkURLs(messages)
	if len(urls) == 0 {
		return nil
	}
	if len(urls) > slackExternalLinkFetchLimit {
		urls = urls[:slackExternalLinkFetchLimit]
	}
	out := make([]SlackExternalLinkContext, 0, len(urls))
	for _, rawURL := range urls {
		out = append(out, fetchSlackExternalLinkContext(ctx, rawURL))
	}
	return out
}

func extractSlackExternalLinkURLs(messages []SlackInboundMessage) []string {
	seen := make(map[string]struct{})
	var urls []string
	for _, message := range messages {
		for _, match := range slackTriageURLPattern.FindAllString(message.Text, -1) {
			rawURL := normalizeSlackExternalLinkURL(match)
			if rawURL == "" || !isFetchableSlackExternalURL(rawURL) {
				continue
			}
			if _, ok := seen[rawURL]; ok {
				continue
			}
			seen[rawURL] = struct{}{}
			urls = append(urls, rawURL)
		}
	}
	return urls
}

func fetchSlackExternalLinkContext(ctx context.Context, rawURL string) SlackExternalLinkContext {
	result := SlackExternalLinkContext{URL: rawURL, Source: "jina_reader"}
	readerURL := slackExternalLinkReaderURL(rawURL)
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, readerURL, nil)
	if err != nil {
		result.Error = err.Error()
		return result
	}
	request.Header.Set("User-Agent", "oneesama-slack-triage/1.0")
	response, err := slackExternalLinkHTTPClient.Do(request)
	if err != nil {
		result.Error = err.Error()
		return result
	}
	defer response.Body.Close()
	body, err := io.ReadAll(io.LimitReader(response.Body, slackExternalLinkFetchBodyLimit))
	if err != nil {
		result.Error = err.Error()
		return result
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		result.Error = fmt.Sprintf("reader returned HTTP %d", response.StatusCode)
		result.Excerpt = truncateSlackContextText(normalizeExternalLinkText(string(body)), slackExternalLinkExcerptBudgetChars)
		return result
	}
	result.Title, result.Excerpt = summarizeExternalLinkReaderText(string(body))
	return result
}

func formatSlackExternalLinkContexts(contexts []SlackExternalLinkContext) string {
	var lines []string
	for index, context := range contexts {
		if strings.TrimSpace(context.URL) == "" {
			continue
		}
		lines = append(lines, fmt.Sprintf("%d. %s", index+1, context.URL))
		if context.Title != "" {
			lines = append(lines, "   title: "+context.Title)
		}
		if context.Excerpt != "" {
			lines = append(lines, "   excerpt: "+context.Excerpt)
		}
		if context.Error != "" {
			lines = append(lines, "   fetch_error: "+context.Error)
		}
	}
	return strings.Join(lines, "\n")
}

func summarizeExternalLinkReaderText(raw string) (string, string) {
	text := normalizeExternalLinkText(raw)
	var title string
	if strings.HasPrefix(text, "Title:") {
		line, rest, _ := strings.Cut(text, "\n")
		title = strings.TrimSpace(strings.TrimPrefix(line, "Title:"))
		text = strings.TrimSpace(rest)
	}
	if _, content, ok := strings.Cut(text, "Markdown Content:"); ok {
		text = strings.TrimSpace(content)
	}
	text = stripExternalLinkBoilerplate(text)
	return truncateSlackContextText(title, slackExternalLinkTitleBudgetChars), truncateSlackContextText(text, slackExternalLinkTextBudgetChars)
}

func normalizeExternalLinkText(raw string) string {
	text := html.UnescapeString(strings.TrimSpace(raw))
	text = strings.ReplaceAll(text, "\r\n", "\n")
	text = strings.ReplaceAll(text, "\r", "\n")
	lines := strings.Split(text, "\n")
	normalized := make([]string, 0, len(lines))
	for _, line := range lines {
		line = strings.Join(strings.Fields(line), " ")
		if line != "" {
			normalized = append(normalized, line)
		}
	}
	return strings.Join(normalized, "\n")
}

func stripExternalLinkBoilerplate(text string) string {
	lines := strings.Split(text, "\n")
	out := make([]string, 0, len(lines))
	for _, line := range lines {
		lower := strings.ToLower(strings.TrimSpace(line))
		switch {
		case lower == "":
			continue
		case lower == "don’t miss what’s happening", lower == "don't miss what's happening":
			continue
		case lower == "people on x are the first to know.":
			continue
		case strings.Contains(lower, "log in") && strings.Contains(lower, "sign up"):
			continue
		default:
			out = append(out, line)
		}
	}
	return strings.Join(out, "\n")
}

func normalizeSlackExternalLinkURL(rawURL string) string {
	rawURL = strings.TrimSpace(rawURL)
	rawURL = strings.Trim(rawURL, "<>|.,，。)）]】")
	return rawURL
}

func isFetchableSlackExternalURL(rawURL string) bool {
	parsed, err := url.Parse(normalizeSlackExternalLinkURL(rawURL))
	if err != nil {
		return false
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return false
	}
	host := strings.ToLower(parsed.Hostname())
	if host == "" || isInternalSlackArchiveURL(rawURL) || isGoogleMeetURLHost(host) || isPrivateSlackFetchHost(host) {
		return false
	}
	return true
}

func isGoogleMeetURLHost(host string) bool {
	return host == "meet.google.com" || strings.HasSuffix(host, ".meet.google.com")
}

func isPrivateSlackFetchHost(host string) bool {
	if host == "localhost" || strings.HasSuffix(host, ".localhost") || strings.HasSuffix(host, ".local") {
		return true
	}
	ip := net.ParseIP(host)
	if ip == nil {
		return false
	}
	return ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast()
}

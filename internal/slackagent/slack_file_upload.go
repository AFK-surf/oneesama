package slackagent

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/AFK-surf/oneesama/internal/httputil"
)

type SlackFileUploadInput struct {
	Path           string
	Filename       string
	Title          string
	Channel        string
	ThreadTS       string
	InitialComment string
}

type SlackUploadedFile struct {
	OK        bool
	FileID    string
	Title     string
	Filename  string
	Permalink string
	Error     string
	Detail    string
}

func UploadSlackFile(ctx context.Context, client *http.Client, botToken string, apiBaseURL string, input SlackFileUploadInput) SlackUploadedFile {
	if strings.TrimSpace(botToken) == "" {
		return SlackUploadedFile{Error: "missing_slack_bot_token"}
	}
	path := strings.TrimSpace(input.Path)
	raw, err := os.ReadFile(path)
	if err != nil {
		return SlackUploadedFile{Error: "read_file_failed", Detail: err.Error()}
	}
	filename := firstNonEmpty(input.Filename, filepath.Base(path))
	title := firstNonEmpty(input.Title, filename)
	httpClient := client
	if httpClient == nil {
		httpClient = httputil.NewHTTPClient(30 * time.Second)
	}

	prepared := slackGetUploadURLExternal(ctx, httpClient, botToken, apiBaseURL, filename, len(raw))
	if !prepared.OK {
		return SlackUploadedFile{Error: firstNonEmpty(prepared.Error, "get_upload_url_failed"), Detail: prepared.Detail}
	}
	if err := slackUploadToExternalURL(ctx, httpClient, botToken, prepared.UploadURL, filename, bytes.NewReader(raw)); err != nil {
		return SlackUploadedFile{Error: "upload_to_url_failed", Detail: err.Error()}
	}
	completed := slackCompleteUploadExternal(ctx, httpClient, botToken, apiBaseURL, prepared.FileID, title, input.Channel, input.ThreadTS, input.InitialComment)
	if !completed.OK {
		return SlackUploadedFile{Error: firstNonEmpty(completed.Error, "complete_upload_failed"), Detail: completed.Detail, FileID: prepared.FileID, Filename: filename, Title: title}
	}
	permalink := slackFileInfoPermalink(ctx, httpClient, botToken, apiBaseURL, prepared.FileID)
	return SlackUploadedFile{OK: true, FileID: prepared.FileID, Filename: filename, Title: title, Permalink: firstNonEmpty(permalink, completed.Permalink)}
}

type slackUploadURLResult struct {
	OK        bool
	FileID    string
	UploadURL string
	Error     string
	Detail    string
}

func slackGetUploadURLExternal(ctx context.Context, client *http.Client, botToken string, apiBaseURL string, filename string, size int) slackUploadURLResult {
	values := url.Values{
		"filename": {filename},
		"length":   {strconv.Itoa(size)},
	}
	var body struct {
		OK        bool   `json:"ok"`
		Error     string `json:"error,omitempty"`
		FileID    string `json:"file_id,omitempty"`
		UploadURL string `json:"upload_url,omitempty"`
	}
	result := callSlackFormAPI(ctx, client, botToken, apiBaseURL, "files.getUploadURLExternal", values, &body)
	if !result.OK || !body.OK {
		return slackUploadURLResult{Error: firstNonEmpty(body.Error, result.Error), Detail: result.Detail}
	}
	if strings.TrimSpace(body.FileID) == "" || strings.TrimSpace(body.UploadURL) == "" {
		return slackUploadURLResult{Error: "upload_url_response_incomplete"}
	}
	return slackUploadURLResult{OK: true, FileID: body.FileID, UploadURL: body.UploadURL}
}

func slackUploadToExternalURL(ctx context.Context, client *http.Client, botToken string, uploadURL string, filename string, reader io.Reader) error {
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	fileWriter, err := writer.CreateFormFile("file", filename)
	if err != nil {
		return err
	}
	if _, err := io.Copy(fileWriter, reader); err != nil {
		return err
	}
	if err := writer.Close(); err != nil {
		return err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, uploadURL, &body)
	if err != nil {
		return err
	}
	request.Header.Set("Content-Type", writer.FormDataContentType())
	request.Header.Set("Authorization", "Bearer "+strings.TrimSpace(botToken))
	response, err := client.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return fmt.Errorf("upload http %d", response.StatusCode)
	}
	return nil
}

type slackCompleteUploadResult struct {
	OK        bool
	Error     string
	Detail    string
	Permalink string
}

func slackCompleteUploadExternal(ctx context.Context, client *http.Client, botToken string, apiBaseURL string, fileID string, title string, channel string, threadTS string, initialComment string) slackCompleteUploadResult {
	files, _ := json.Marshal([]map[string]string{{"id": fileID, "title": title}})
	values := url.Values{"files": {string(files)}}
	if strings.TrimSpace(channel) != "" {
		values.Set("channel_id", strings.TrimSpace(channel))
	}
	if strings.TrimSpace(threadTS) != "" {
		values.Set("thread_ts", strings.TrimSpace(threadTS))
	}
	if strings.TrimSpace(initialComment) != "" {
		values.Set("initial_comment", strings.TrimSpace(initialComment))
	}
	var body struct {
		OK    bool   `json:"ok"`
		Error string `json:"error,omitempty"`
		Files []struct {
			ID        string `json:"id,omitempty"`
			Title     string `json:"title,omitempty"`
			Permalink string `json:"permalink,omitempty"`
		} `json:"files,omitempty"`
	}
	result := callSlackFormAPI(ctx, client, botToken, apiBaseURL, "files.completeUploadExternal", values, &body)
	if !result.OK || !body.OK {
		return slackCompleteUploadResult{Error: firstNonEmpty(body.Error, result.Error), Detail: result.Detail}
	}
	permalink := ""
	if len(body.Files) > 0 {
		permalink = strings.TrimSpace(body.Files[0].Permalink)
	}
	return slackCompleteUploadResult{OK: true, Permalink: permalink}
}

func slackFileInfoPermalink(ctx context.Context, client *http.Client, botToken string, apiBaseURL string, fileID string) string {
	values := url.Values{"file": {fileID}, "count": {"1"}, "page": {"1"}}
	var body struct {
		OK    bool   `json:"ok"`
		Error string `json:"error,omitempty"`
		File  struct {
			Permalink string `json:"permalink,omitempty"`
		} `json:"file,omitempty"`
	}
	result := callSlackFormAPI(ctx, client, botToken, apiBaseURL, "files.info", values, &body)
	if !result.OK || !body.OK {
		return ""
	}
	return strings.TrimSpace(body.File.Permalink)
}

type slackFormAPIResult struct {
	OK     bool
	Status int
	Error  string
	Detail string
}

func callSlackFormAPI(ctx context.Context, client *http.Client, botToken string, apiBaseURL string, method string, values url.Values, target any) slackFormAPIResult {
	baseURL := strings.TrimRight(strings.TrimSpace(apiBaseURL), "/")
	if baseURL == "" {
		baseURL = defaultSlackAPIBaseURL
	}
	values = cloneURLValues(values)
	values.Set("token", strings.TrimSpace(botToken))
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, fmt.Sprintf("%s/%s", baseURL, method), strings.NewReader(values.Encode()))
	if err != nil {
		return slackFormAPIResult{Error: "build_request_failed", Detail: err.Error()}
	}
	request.Header.Set("Authorization", "Bearer "+strings.TrimSpace(botToken))
	request.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	response, err := client.Do(request)
	if err != nil {
		return slackFormAPIResult{Error: "request_failed", Detail: err.Error()}
	}
	defer response.Body.Close()
	if err := json.NewDecoder(response.Body).Decode(target); err != nil {
		return slackFormAPIResult{Status: response.StatusCode, Error: "decode_response_failed", Detail: err.Error()}
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return slackFormAPIResult{Status: response.StatusCode, Error: fmt.Sprintf("http_%d", response.StatusCode)}
	}
	return slackFormAPIResult{OK: true, Status: response.StatusCode}
}

func cloneURLValues(values url.Values) url.Values {
	clone := make(url.Values, len(values))
	for key, value := range values {
		clone[key] = append([]string(nil), value...)
	}
	return clone
}

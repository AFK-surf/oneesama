package slackagent

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
)

// TestEncodeSafeBlocksAcceptsLayoutTypes pins the allow-list so adding a
// genuinely new safe block type requires test coverage.
func TestEncodeSafeBlocksAcceptsLayoutTypes(t *testing.T) {
	for _, blockType := range []string{"section", "divider", "context", "header", "image", "rich_text", "file", "video"} {
		encoded, count, err := encodeSafeBlocks([]any{
			map[string]any{"type": blockType, "text": map[string]any{"type": "mrkdwn", "text": "ok"}},
		})
		if err != nil {
			t.Fatalf("encodeSafeBlocks(%q): unexpected error %v", blockType, err)
		}
		if count != 1 {
			t.Fatalf("encodeSafeBlocks(%q): count = %d, want 1", blockType, count)
		}
		if !strings.Contains(encoded, blockType) {
			t.Fatalf("encodeSafeBlocks(%q): JSON missing block type, got %q", blockType, encoded)
		}
	}
}

// TestEncodeSafeBlocksRejectsInteractiveBlockTypes confirms top-level
// interactive blocks (actions / input / call / workflow) are bounced before
// they reach chat.postMessage.
func TestEncodeSafeBlocksRejectsInteractiveBlockTypes(t *testing.T) {
	for _, blockType := range []string{"actions", "input", "call", "workflow"} {
		_, _, err := encodeSafeBlocks([]any{map[string]any{"type": blockType}})
		if err == nil {
			t.Fatalf("expected interactive block %q to be rejected", blockType)
		}
		if !strings.Contains(err.Error(), "interactive") {
			t.Fatalf("expected error to mention interactive, got %q", err.Error())
		}
	}
}

// TestEncodeSafeBlocksRejectsSectionWithButtonAccessory catches the most
// common smuggle path: a "section" layout block with a button accessory.
func TestEncodeSafeBlocksRejectsSectionWithButtonAccessory(t *testing.T) {
	blocks := []any{
		map[string]any{
			"type": "section",
			"text": map[string]any{"type": "mrkdwn", "text": "click me"},
			"accessory": map[string]any{
				"type":      "button",
				"text":      map[string]any{"type": "plain_text", "text": "Click"},
				"action_id": "smuggled",
			},
		},
	}
	_, _, err := encodeSafeBlocks(blocks)
	if err == nil {
		t.Fatalf("expected section+button to be rejected")
	}
	if !strings.Contains(err.Error(), "button") {
		t.Fatalf("expected error to mention button, got %q", err.Error())
	}
}

// TestEncodeSafeBlocksRejectsInteractiveElements covers context/actions
// elements arrays embedding select/datepicker/checkbox/etc.
func TestEncodeSafeBlocksRejectsInteractiveElements(t *testing.T) {
	for _, elementType := range []string{"static_select", "datepicker", "checkboxes", "users_select", "overflow", "workflow_button"} {
		blocks := []any{
			map[string]any{
				"type": "context",
				"elements": []any{
					map[string]any{"type": elementType},
				},
			},
		}
		_, _, err := encodeSafeBlocks(blocks)
		if err == nil {
			t.Fatalf("expected element type %q to be rejected", elementType)
		}
	}
}

// TestEncodeSafeBlocksParsesStringInput exercises the JSON-string fallback
// some callers use when forwarding tool arguments verbatim.
func TestEncodeSafeBlocksParsesStringInput(t *testing.T) {
	raw := `[{"type":"section","text":{"type":"mrkdwn","text":"hi"}}]`
	encoded, count, err := encodeSafeBlocks(raw)
	if err != nil {
		t.Fatalf("encodeSafeBlocks(string): %v", err)
	}
	if count != 1 {
		t.Fatalf("count = %d, want 1", count)
	}
	if !strings.Contains(encoded, "section") {
		t.Fatalf("encoded missing block content: %q", encoded)
	}
}

// TestEncodeSafeBlocksRejectsMissingType keeps malformed input from being
// silently forwarded to Slack.
func TestEncodeSafeBlocksRejectsMissingType(t *testing.T) {
	_, _, err := encodeSafeBlocks([]any{map[string]any{"text": "missing type"}})
	if err == nil {
		t.Fatalf("expected missing-type block to be rejected")
	}
}

// TestEncodeSafeBlocksRejectsUnknownLayoutType protects against future Slack
// block types that we haven't audited yet.
func TestEncodeSafeBlocksRejectsUnknownLayoutType(t *testing.T) {
	_, _, err := encodeSafeBlocks([]any{map[string]any{"type": "future_block_type"}})
	if err == nil {
		t.Fatalf("expected unknown block type to be rejected")
	}
}

// TestActionPostMessageForwardsSafeBlocksAsJSON wires the helper into the
// chat.postMessage form payload and confirms Slack receives a properly
// encoded `blocks` parameter for layout-only content.
func TestActionPostMessageForwardsSafeBlocksAsJSON(t *testing.T) {
	captured := struct {
		channel string
		text    string
		blocks  string
	}{}
	transport := roundTripperFunc(func(req *http.Request) (*http.Response, error) {
		raw, _ := io.ReadAll(req.Body)
		req.Body = io.NopCloser(bytes.NewReader(raw))
		values := mustParseForm(t, raw)
		captured.channel = values.Get("channel")
		captured.text = values.Get("text")
		captured.blocks = values.Get("blocks")
		return &http.Response{
			StatusCode: 200,
			Body:       io.NopCloser(strings.NewReader(`{"ok":true,"ts":"1.000001"}`)),
			Header:     http.Header{"Content-Type": []string{"application/json"}},
			Request:    req,
		}, nil
	})

	tool := &slackAPITool{
		role:          slackAPIRoleAssistant,
		apiURL:        "https://slack.example",
		token:         "xoxb-test",
		httpTransport: transport,
	}
	result, err := tool.actionPostMessage(context.Background(), map[string]any{
		"channel": "C123",
		"text":    "hi",
		"blocks": []any{
			map[string]any{"type": "section", "text": map[string]any{"type": "mrkdwn", "text": "*bold*"}},
		},
	})
	if err != nil {
		t.Fatalf("actionPostMessage: %v", err)
	}
	if !result.Success {
		t.Fatalf("expected success, got %q", result.Text)
	}
	if captured.blocks == "" {
		t.Fatalf("expected blocks form value to be set, got empty")
	}
	var decoded []map[string]any
	if err := json.Unmarshal([]byte(captured.blocks), &decoded); err != nil {
		t.Fatalf("decode forwarded blocks: %v", err)
	}
	if len(decoded) != 1 || decoded[0]["type"] != "section" {
		t.Fatalf("forwarded blocks unexpected: %+v", decoded)
	}
	if !strings.Contains(result.Text, "1 blocks") {
		t.Fatalf("expected result text to report 1 block, got %q", result.Text)
	}
}

// TestActionPostMessageRejectsInteractiveBlocksBeforeHTTP guards the entire
// chat.postMessage path: a request carrying a button block must not hit
// Slack at all.
func TestActionPostMessageRejectsInteractiveBlocksBeforeHTTP(t *testing.T) {
	calls := 0
	transport := roundTripperFunc(func(req *http.Request) (*http.Response, error) {
		calls++
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(`{"ok":true}`)), Header: http.Header{}}, nil
	})
	tool := &slackAPITool{
		role:          slackAPIRoleAssistant,
		apiURL:        "https://slack.example",
		token:         "xoxb-test",
		httpTransport: transport,
	}
	result, err := tool.actionPostMessage(context.Background(), map[string]any{
		"channel": "C123",
		"text":    "hi",
		"blocks": []any{
			map[string]any{
				"type": "actions",
				"elements": []any{
					map[string]any{"type": "button", "text": map[string]any{"type": "plain_text", "text": "Go"}},
				},
			},
		},
	})
	if err != nil {
		t.Fatalf("actionPostMessage: %v", err)
	}
	if result.Success {
		t.Fatalf("expected interactive blocks rejection, got success: %q", result.Text)
	}
	if calls != 0 {
		t.Fatalf("expected zero HTTP calls for rejected blocks, got %d", calls)
	}
	if !strings.Contains(strings.ToLower(result.Text), "interactive") {
		t.Fatalf("expected error text to mention interactive, got %q", result.Text)
	}
}

type roundTripperFunc func(*http.Request) (*http.Response, error)

func (f roundTripperFunc) RoundTrip(req *http.Request) (*http.Response, error) {
	return f(req)
}

func mustParseForm(t *testing.T, body []byte) (values formValues) {
	t.Helper()
	values = formValues{}
	for _, pair := range strings.Split(string(body), "&") {
		if pair == "" {
			continue
		}
		eq := strings.IndexByte(pair, '=')
		if eq < 0 {
			continue
		}
		key, err := percentDecode(pair[:eq])
		if err != nil {
			t.Fatalf("decode key: %v", err)
		}
		val, err := percentDecode(pair[eq+1:])
		if err != nil {
			t.Fatalf("decode value: %v", err)
		}
		values[key] = val
	}
	return values
}

type formValues map[string]string

func (v formValues) Get(key string) string { return v[key] }

func percentDecode(s string) (string, error) {
	// url.QueryUnescape would also do this; we keep an inline helper so the
	// tests do not depend on net/url to verify what was sent over the wire.
	out := make([]byte, 0, len(s))
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch c {
		case '+':
			out = append(out, ' ')
		case '%':
			if i+2 >= len(s) {
				return "", io.ErrUnexpectedEOF
			}
			hi, ok1 := fromHex(s[i+1])
			lo, ok2 := fromHex(s[i+2])
			if !ok1 || !ok2 {
				return "", io.ErrUnexpectedEOF
			}
			out = append(out, byte(hi<<4|lo))
			i += 2
		default:
			out = append(out, c)
		}
	}
	return string(out), nil
}

func fromHex(c byte) (int, bool) {
	switch {
	case c >= '0' && c <= '9':
		return int(c - '0'), true
	case c >= 'a' && c <= 'f':
		return int(c-'a') + 10, true
	case c >= 'A' && c <= 'F':
		return int(c-'A') + 10, true
	}
	return 0, false
}

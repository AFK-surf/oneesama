package slackagent

import (
	"encoding/json"
	"testing"
)

func TestSlackBlockTextDecodesStringElementText(t *testing.T) {
	raw := []byte(`{
		"type": "event_callback",
		"event_id": "Ev123",
		"team_id": "T123",
		"event": {
			"type": "message",
			"subtype": "message_changed",
			"channel": "C123",
			"ts": "123.456",
			"message": {
				"type": "message",
				"ts": "123.456",
				"text": "fallback",
				"blocks": [{
					"type": "context",
					"elements": [{
						"type": "mrkdwn",
						"text": "_Onee Sama Meeting Bot_"
					}]
				}]
			}
		}
	}`)

	var envelope SlackEventEnvelope
	if err := json.Unmarshal(raw, &envelope); err != nil {
		t.Fatalf("unmarshal SlackEventEnvelope: %v", err)
	}
	if envelope.Event.Message == nil {
		t.Fatal("event message is nil")
	}
	if got := envelope.Event.Message.Blocks[0].Elements[0].Text.Text; got != "_Onee Sama Meeting Bot_" {
		t.Fatalf("element text = %q, want string block text", got)
	}
}

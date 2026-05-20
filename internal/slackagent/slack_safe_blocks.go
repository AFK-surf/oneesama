package slackagent

import (
	"encoding/json"
	"fmt"
	"strings"
)

// Slack chat.postMessage safe-blocks support.
//
// Mirrors Cueboard's behavior of accepting non-interactive layout blocks
// (section / divider / context / header / image / rich_text) for assistant-
// initiated posts while refusing interactive blocks (actions / input / any
// section with a button/select accessory). Interactive blocks belong to the
// pending-action card flow, where the side-effecting writers add their own
// callback wiring; letting the model post them directly would create
// orphaned clickable UI.

// safeBlockTypes is the allow-list of Slack block layout types that
// chat.postMessage may surface without a callback target. Keep it small —
// adding a new type should be a deliberate decision tied to test coverage.
var safeBlockTypes = map[string]struct{}{
	"section":   {},
	"divider":   {},
	"context":   {},
	"header":    {},
	"image":     {},
	"rich_text": {},
	"file":      {},
	"video":     {},
}

// interactiveBlockTypes is the explicit reject-list. Anything in this set
// MUST go through the pending-action card writer, not chat.postMessage.
var interactiveBlockTypes = map[string]struct{}{
	"actions":  {},
	"input":    {},
	"call":     {},
	"workflow": {},
}

// encodeSafeBlocks validates a `blocks` parameter and returns its JSON
// encoding plus the count of attached blocks. The first argument typically
// comes straight from the tool params map and may be `[]any`, `[]map`, a
// JSON string, or another wire-time variant — we normalize via
// json.Marshal/Unmarshal so each individual block is a `map[string]any`
// before validation.
func encodeSafeBlocks(raw any) (string, int, error) {
	if raw == nil {
		return "", 0, nil
	}
	normalized, err := normalizeBlocksInput(raw)
	if err != nil {
		return "", 0, err
	}
	if len(normalized) == 0 {
		return "", 0, nil
	}
	normalized = sanitizeSlackVisibleBlockMaps(normalized)
	for index, block := range normalized {
		if err := validateSafeBlock(block, index); err != nil {
			return "", 0, err
		}
	}
	encoded, err := json.Marshal(normalized)
	if err != nil {
		return "", 0, fmt.Errorf("encode blocks: %w", err)
	}
	return string(encoded), len(normalized), nil
}

func normalizeBlocksInput(raw any) ([]map[string]any, error) {
	switch value := raw.(type) {
	case []map[string]any:
		return value, nil
	case []any:
		out := make([]map[string]any, 0, len(value))
		for index, item := range value {
			block, ok := item.(map[string]any)
			if !ok {
				return nil, fmt.Errorf("block %d: expected object, got %T", index, item)
			}
			out = append(out, block)
		}
		return out, nil
	case string:
		trimmed := strings.TrimSpace(value)
		if trimmed == "" {
			return nil, nil
		}
		var parsed []map[string]any
		if err := json.Unmarshal([]byte(trimmed), &parsed); err != nil {
			return nil, fmt.Errorf("decode blocks JSON: %w", err)
		}
		return parsed, nil
	default:
		// Fall back to round-trip via JSON for any other slice-like shape
		// (e.g. typed Slack block structs deserialized elsewhere). This
		// keeps the helper resilient to caller variants without exploding
		// the type switch.
		encoded, err := json.Marshal(raw)
		if err != nil {
			return nil, fmt.Errorf("encode blocks input: %w", err)
		}
		var parsed []map[string]any
		if err := json.Unmarshal(encoded, &parsed); err != nil {
			return nil, fmt.Errorf("decode blocks input: %w", err)
		}
		return parsed, nil
	}
}

func validateSafeBlock(block map[string]any, index int) error {
	if block == nil {
		return fmt.Errorf("block %d is nil", index)
	}
	blockType := strings.TrimSpace(strings.ToLower(stringFromAny(block["type"])))
	if blockType == "" {
		return fmt.Errorf("block %d: missing type", index)
	}
	if _, blocked := interactiveBlockTypes[blockType]; blocked {
		return fmt.Errorf("block %d type %q is interactive and not allowed on chat.postMessage; use suggest_action to post a card", index, blockType)
	}
	if _, allowed := safeBlockTypes[blockType]; !allowed {
		return fmt.Errorf("block %d type %q is not in the safe-block allow-list; allowed: section/divider/context/header/image/rich_text/file/video", index, blockType)
	}
	return validateNoInteractiveElements(block, index)
}

// validateNoInteractiveElements rejects section blocks whose `accessory` or
// `elements` introduce buttons, selects, datepickers, or any other element
// type that Slack treats as interactive. This catches the common case where
// a layout block is allow-listed but its embedded element opens a callback
// channel the bot can't service.
func validateNoInteractiveElements(block map[string]any, index int) error {
	if accessory, ok := block["accessory"].(map[string]any); ok && len(accessory) > 0 {
		if err := requireNonInteractiveElement(accessory, fmt.Sprintf("block %d accessory", index)); err != nil {
			return err
		}
	}
	if elementsRaw, ok := block["elements"].([]any); ok {
		for elementIndex, item := range elementsRaw {
			element, ok := item.(map[string]any)
			if !ok {
				continue
			}
			if err := requireNonInteractiveElement(element, fmt.Sprintf("block %d element %d", index, elementIndex)); err != nil {
				return err
			}
		}
	}
	return nil
}

func requireNonInteractiveElement(element map[string]any, label string) error {
	elementType := strings.TrimSpace(strings.ToLower(stringFromAny(element["type"])))
	if elementType == "" {
		return nil
	}
	if isInteractiveElementType(elementType) {
		return fmt.Errorf("%s type %q is interactive; chat.postMessage rejects buttons/selects/datepickers — route them through suggest_action", label, elementType)
	}
	return nil
}

func isInteractiveElementType(elementType string) bool {
	switch elementType {
	case "button",
		"static_select",
		"users_select",
		"channels_select",
		"conversations_select",
		"external_select",
		"multi_static_select",
		"multi_users_select",
		"multi_channels_select",
		"multi_conversations_select",
		"multi_external_select",
		"overflow",
		"datepicker",
		"timepicker",
		"datetimepicker",
		"radio_buttons",
		"checkboxes",
		"plain_text_input",
		"number_input",
		"email_text_input",
		"url_text_input",
		"file_input",
		"workflow_button",
		"rich_text_input":
		return true
	}
	return false
}

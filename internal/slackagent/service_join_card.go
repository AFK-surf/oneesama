package slackagent

import (
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
)

const (
	joinSetupKind             = "oneesama_join_setup"
	joinSetupCaptionBlockID   = "oneesama_join_caption"
	joinSetupCaptionActionID  = "oneesama_join_caption_language"
	joinSetupActionsBlockID   = "oneesama_join_actions"
	joinSetupPlainActionID    = "oneesama_join_without_realtime"
	joinSetupRealtimeActionID = "oneesama_join_with_realtime"
	defaultCaptionLanguage    = "English"
)

type joinSetupActionValue struct {
	Kind            string `json:"kind"`
	CardID          string `json:"card_id,omitempty"`
	MeetingURL      string `json:"meeting_url"`
	SessionID       string `json:"session_id,omitempty"`
	BotName         string `json:"bot_name,omitempty"`
	DryRun          bool   `json:"dry_run"`
	CaptionLanguage string `json:"caption_language,omitempty"`
	Realtime        bool   `json:"realtime"`
	ConfirmJoin     bool   `json:"confirm_join"`
	SourceChannelID string `json:"source_channel_id,omitempty"`
	SourceThreadTS  string `json:"source_thread_ts,omitempty"`
	SourceMessageTS string `json:"source_message_ts,omitempty"`
}

var slackJoinCaptionLanguages = []string{
	"English",
	"Chinese (Simplified)",
	"Chinese (Traditional)",
	"Japanese",
	"Korean",
	"French",
	"German",
	"Spanish",
	"Portuguese",
	"Italian",
	"Dutch",
	"Russian",
}

func (s *Service) shouldShowJoinSetupCard(input AvatarCommandInput, parsed parsedAvatarCommand) bool {
	if parsed.ConfirmJoin {
		return false
	}
	switch strings.TrimSpace(input.Command) {
	case "app_mention", "message_mention", "dm_command":
		return true
	default:
		return false
	}
}

func (s *Service) joinSetupResponse(input AvatarCommandInput, parsed parsedAvatarCommand) AvatarCommandResponse {
	captionLanguage := s.effectiveCaptionLanguage(parsed.CaptionLanguage)
	card := joinSetupCardContextFromInput(input, parsed)
	blocks := buildJoinSetupBlocks(parsed, captionLanguage, card)
	return AvatarCommandResponse{
		OK:           true,
		ResponseType: "ephemeral",
		Text:         fmt.Sprintf("Join Google Meet: %s", parsed.MeetURL),
		Blocks:       blocks,
		Metadata: map[string]any{
			"join_setup": map[string]any{
				"meeting_url":       parsed.MeetURL,
				"caption_language":  captionLanguage,
				"realtime":          parsed.RealtimeJoin,
				"dry_run":           parsed.DryRunJoiner,
				"requested_by":      input.UserID,
				"card_id":           card.CardID,
				"source_channel_id": card.ChannelID,
				"source_thread_ts":  card.ThreadTS,
				"source_message_ts": card.MessageTS,
				"capture_captions":  true,
				"action_items":      true,
				"canvas_publishing": true,
			},
		},
	}
}

func (s *Service) effectiveCaptionLanguage(raw string) string {
	return firstNonEmpty(strings.TrimSpace(raw), s.defaultCaptionLanguage, defaultCaptionLanguage)
}

type joinSetupCardContext struct {
	CardID    string
	ChannelID string
	ThreadTS  string
	MessageTS string
}

func joinSetupCardContextFromInput(input AvatarCommandInput, parsed parsedAvatarCommand) joinSetupCardContext {
	threadTS := firstNonEmpty(strings.TrimSpace(input.ThreadTS), strings.TrimSpace(input.ReactionTS), "root")
	messageTS := firstNonEmpty(strings.TrimSpace(input.ReactionTS), strings.TrimSpace(input.ThreadTS))
	return joinSetupCardContext{
		CardID: strings.Join([]string{
			"join-card",
			firstNonEmpty(strings.TrimSpace(input.ChannelID), "channel"),
			threadTS,
			sanitizeJoinSetupIDPart(parsed.MeetURL),
		}, ":"),
		ChannelID: strings.TrimSpace(input.ChannelID),
		ThreadTS:  threadTS,
		MessageTS: messageTS,
	}
}

func sanitizeJoinSetupIDPart(value string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return "meet"
	}
	replacer := strings.NewReplacer(":", "_", "/", "_", "?", "_", "&", "_", "=", "_", " ", "_")
	return replacer.Replace(value)
}

func buildJoinSetupBlocks(parsed parsedAvatarCommand, captionLanguage string, card joinSetupCardContext) []map[string]any {
	captionOption := joinCaptionOption(captionLanguage)
	return []map[string]any{
		{
			"type":     "section",
			"block_id": joinSetupCaptionBlockID,
			"text": map[string]any{
				"type": "mrkdwn",
				"text": fmt.Sprintf("*Join Google Meet*\n<%s|Open meeting>\nI'll record captions and post the summary back in this thread.", parsed.MeetURL),
			},
			"accessory": map[string]any{
				"type":           "static_select",
				"action_id":      joinSetupCaptionActionID,
				"placeholder":    plainTextObject("Caption language"),
				"initial_option": captionOption,
				"options":        joinCaptionOptions(captionLanguage),
			},
		},
		joinSetupContextBlock(captionLanguage),
		{
			"type":     "actions",
			"block_id": joinSetupActionsBlockID,
			"elements": []map[string]any{
				joinSetupButton("Join", joinSetupPlainActionID, parsed, captionLanguage, card, false, "primary"),
				joinSetupButton("Join with realtime", joinSetupRealtimeActionID, parsed, captionLanguage, card, true, ""),
			},
		},
	}
}

func joinSetupContextBlock(captionLanguage string) map[string]any {
	return map[string]any{
		"type": "context",
		"elements": []map[string]any{{
			"type": "mrkdwn",
			"text": fmt.Sprintf(":closed_caption: %s captions · :page_facing_up: transcript, audio, and Canvas notes", firstNonEmpty(captionLanguage, defaultCaptionLanguage)),
		}},
	}
}

func plainTextObject(text string) map[string]any {
	return map[string]any{
		"type": "plain_text",
		"text": text,
	}
}

func joinSetupButton(label string, actionID string, parsed parsedAvatarCommand, captionLanguage string, card joinSetupCardContext, realtime bool, style string) map[string]any {
	button := map[string]any{
		"type":      "button",
		"action_id": actionID,
		"text": map[string]any{
			"type": "plain_text",
			"text": label,
		},
		"value": joinSetupActionValueJSON(joinSetupActionValue{
			Kind:            joinSetupKind,
			CardID:          card.CardID,
			MeetingURL:      parsed.MeetURL,
			SessionID:       parsed.SessionID,
			BotName:         parsed.BotName,
			DryRun:          parsed.DryRunJoiner,
			CaptionLanguage: captionLanguage,
			Realtime:        realtime,
			ConfirmJoin:     true,
			SourceChannelID: card.ChannelID,
			SourceThreadTS:  card.ThreadTS,
			SourceMessageTS: card.MessageTS,
		}),
	}
	if style != "" {
		button["style"] = style
	}
	return button
}

func joinCaptionOptions(initial string) []map[string]any {
	languages := make([]string, 0, len(slackJoinCaptionLanguages)+1)
	if strings.TrimSpace(initial) != "" {
		languages = append(languages, strings.TrimSpace(initial))
	}
	for _, language := range slackJoinCaptionLanguages {
		if !strings.EqualFold(strings.TrimSpace(language), strings.TrimSpace(initial)) {
			languages = append(languages, language)
		}
	}
	options := make([]map[string]any, 0, len(languages))
	for _, language := range languages {
		options = append(options, joinCaptionOption(language))
	}
	return options
}

func joinCaptionOption(language string) map[string]any {
	label := firstNonEmpty(strings.TrimSpace(language), defaultCaptionLanguage)
	return map[string]any{
		"text": map[string]any{
			"type": "plain_text",
			"text": label,
		},
		"value": label,
	}
}

func joinSetupActionValueJSON(value joinSetupActionValue) string {
	raw, err := json.Marshal(value)
	if err != nil {
		return ""
	}
	return string(raw)
}

func joinSetupCommandInputFromInteraction(payload SlackInteractionPayload) (AvatarCommandInput, bool) {
	if len(payload.Actions) == 0 {
		return AvatarCommandInput{}, false
	}
	action := payload.Actions[0]
	var value joinSetupActionValue
	rawValue := joinSetupInteractionActionValue(payload, action)
	if err := json.Unmarshal([]byte(rawValue), &value); err != nil {
		return AvatarCommandInput{}, false
	}
	if value.Kind != joinSetupKind || strings.TrimSpace(value.MeetingURL) == "" {
		return AvatarCommandInput{}, false
	}
	captionLanguage := firstNonEmpty(joinSetupSelectedCaptionLanguage(payload), value.CaptionLanguage, defaultCaptionLanguage)
	command := []string{
		"join",
		strconv.Quote(value.MeetingURL),
		"--confirm",
		"--caption-language",
		strconv.Quote(captionLanguage),
		"--dry-run",
		strconv.FormatBool(value.DryRun),
		"--realtime",
		strconv.FormatBool(value.Realtime),
	}
	if strings.TrimSpace(value.SessionID) != "" {
		command = append(command, "--session", strconv.Quote(value.SessionID))
	}
	if strings.TrimSpace(value.BotName) != "" {
		command = append(command, "--bot-name", strconv.Quote(value.BotName))
	}
	input := avatarCommandInputFromInteraction(payload)
	input.ChannelID = firstNonEmpty(input.ChannelID, value.SourceChannelID)
	input.ThreadTS = firstNonEmpty(input.ThreadTS, value.SourceThreadTS)
	input.Text = strings.Join(command, " ")
	return input, true
}

func joinSetupInteractionActionValue(payload SlackInteractionPayload, action SlackInteractionAction) string {
	if raw := strings.TrimSpace(action.Value); raw != "" {
		return raw
	}
	actionID := strings.TrimSpace(action.ActionID)
	if actionID == "" || payload.Message == nil {
		return ""
	}
	for _, block := range payload.Message.Blocks {
		for _, element := range block.Elements {
			if strings.TrimSpace(element.ActionID) == actionID && strings.TrimSpace(element.Value) != "" {
				return strings.TrimSpace(element.Value)
			}
		}
	}
	return ""
}

func joinSetupSelectedCaptionLanguage(payload SlackInteractionPayload) string {
	if payload.State == nil {
		return ""
	}
	for _, block := range payload.State.Values {
		if action, ok := block[joinSetupCaptionActionID]; ok {
			return selectedOptionValue(action.SelectedOption)
		}
	}
	return ""
}

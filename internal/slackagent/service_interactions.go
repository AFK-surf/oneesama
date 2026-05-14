package slackagent

import (
	"encoding/json"
	"strings"
)

func parseSlackInteractionPayload(raw string) (*SlackInteractionPayload, error) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return nil, nil
	}
	var payload SlackInteractionPayload
	if err := json.Unmarshal([]byte(trimmed), &payload); err != nil {
		return nil, err
	}
	return &payload, nil
}

func avatarCommandInputFromInteraction(payload SlackInteractionPayload) AvatarCommandInput {
	action := SlackInteractionAction{}
	if len(payload.Actions) > 0 {
		action = payload.Actions[0]
	}
	value := firstNonEmpty(
		strings.TrimSpace(action.Value),
		strings.TrimSpace(selectedOptionValue(action.SelectedOption)),
	)
	if strings.HasPrefix(value, "{") {
		var embedded struct {
			CommandText string `json:"commandText"`
			Command     string `json:"command"`
			Text        string `json:"text"`
		}
		if err := json.Unmarshal([]byte(value), &embedded); err == nil {
			value = firstNonEmpty(
				strings.TrimSpace(embedded.CommandText),
				strings.TrimSpace(embedded.Command),
				strings.TrimSpace(embedded.Text),
				value,
			)
		}
	}
	return AvatarCommandInput{
		Text:        strings.TrimSpace(value),
		TeamID:      firstNonEmpty(strings.TrimSpace(payload.TeamID), teamID(payload.Team)),
		ChannelID:   firstNonEmpty(strings.TrimSpace(payload.ChannelID), channelID(payload.Channel)),
		ChannelName: channelName(payload.Channel),
		ThreadTS:    interactionThreadTS(payload.Message),
		UserID:      firstNonEmpty(strings.TrimSpace(payload.UserID), userID(payload.User)),
		UserName:    firstNonEmpty(userUsername(payload.User), userName(payload.User)),
		Command:     "interaction",
	}
}

func selectedOptionValue(option *SlackInteractionSelectedValue) string {
	if option == nil {
		return ""
	}
	return option.Value
}

func teamID(team *SlackInteractionTeam) string {
	if team == nil {
		return ""
	}
	return team.ID
}

func channelID(channel *SlackInteractionChannel) string {
	if channel == nil {
		return ""
	}
	return channel.ID
}

func channelName(channel *SlackInteractionChannel) string {
	if channel == nil {
		return ""
	}
	return channel.Name
}

func userID(user *SlackInteractionUser) string {
	if user == nil {
		return ""
	}
	return user.ID
}

func userUsername(user *SlackInteractionUser) string {
	if user == nil {
		return ""
	}
	return user.Username
}

func userName(user *SlackInteractionUser) string {
	if user == nil {
		return ""
	}
	return user.Name
}

func interactionThreadTS(message *SlackInteractionMessage) string {
	if message == nil {
		return ""
	}
	return firstNonEmpty(strings.TrimSpace(message.ThreadTS), strings.TrimSpace(message.TS))
}

package slackagent

import (
	"context"
	"encoding/json"
	"strings"
	"time"

	"github.com/gorilla/websocket"
)

func (r *SocketModeRunner) handleMessage(ctx context.Context, conn *websocket.Conn, message []byte) error {
	var envelope SlackSocketEnvelope
	if err := json.Unmarshal(message, &envelope); err != nil {
		r.setLastError("invalid_socket_mode_json: " + err.Error())
		return nil
	}

	ack := func(payload any) error {
		if strings.TrimSpace(envelope.EnvelopeID) == "" {
			return nil
		}
		return r.writeJSON(conn, SlackSocketAck{
			EnvelopeID: envelope.EnvelopeID,
			Payload:    payload,
		})
	}
	return r.handleEnvelope(ctx, envelope, ack)
}

func (r *SocketModeRunner) handleEnvelope(ctx context.Context, envelope SlackSocketEnvelope, ack func(any) error) error {
	r.updateState(func(state *SlackSocketModeStatus) {
		state.EventsHandled++
		state.LastEventAt = time.Now().UTC().Format(time.RFC3339Nano)
	})

	switch strings.TrimSpace(envelope.Type) {
	case "hello":
		return nil
	case "disconnect":
		r.setLastError(firstNonEmpty(strings.TrimSpace(envelope.Reason), "slack requested disconnect"))
		return errSlackSocketDisconnect
	case "events_api":
		if err := ack(nil); err != nil {
			return err
		}
		return r.handleEventsAPI(context.WithoutCancel(ctx), envelope.Payload)
	case "slash_commands":
		r.updateState(func(state *SlackSocketModeStatus) {
			state.SlashCommandsHandled++
		})
		return r.handleSlashCommand(ctx, envelope.Payload, ack)
	case "interactive":
		r.updateState(func(state *SlackSocketModeStatus) {
			state.InteractionsHandled++
		})
		return r.handleInteractive(ctx, envelope.Payload, ack)
	default:
		r.updateState(func(state *SlackSocketModeStatus) {
			state.IgnoredEnvelopes++
		})
		return ack(nil)
	}
}

func (r *SocketModeRunner) handleEventsAPI(ctx context.Context, payload []byte) error {
	var envelope SlackEventEnvelope
	if err := json.Unmarshal(payload, &envelope); err != nil {
		r.setLastError("decode events_api payload: " + err.Error())
		return nil
	}
	r.service.HandleSlackEvent(ctx, envelope, SlackEventHeaders{})
	return nil
}

func (r *SocketModeRunner) handleSlashCommand(ctx context.Context, payload []byte, ack func(any) error) error {
	var command SlackSocketSlashCommand
	if err := json.Unmarshal(payload, &command); err != nil {
		return ack(AvatarCommandResponse{
			OK:           false,
			ResponseType: "ephemeral",
			Text:         "Invalid socket mode slash command payload.",
		})
	}
	return ack(r.service.RunAvatarCommand(ctx, AvatarCommandInput{
		Text:      command.Text,
		TeamID:    command.TeamID,
		ChannelID: command.ChannelID,
		ThreadTS:  command.ThreadTS,
		UserID:    command.UserID,
		UserName:  command.UserName,
		Command:   "socket_mode_slash_command",
	}))
}

func (r *SocketModeRunner) handleInteractive(ctx context.Context, payload []byte, ack func(any) error) error {
	var interaction SlackInteractionPayload
	if err := json.Unmarshal(payload, &interaction); err != nil {
		return ack(AvatarCommandResponse{
			OK:           false,
			ResponseType: "ephemeral",
			Text:         "Invalid socket mode interaction payload.",
		})
	}
	if command, ok := joinSetupCommandInputFromInteraction(interaction); ok {
		actionID := ""
		if len(interaction.Actions) > 0 {
			actionID = interaction.Actions[0].ActionID
		}
		r.service.logger.Info(
			"slack socket interaction join setup",
			"action_id", actionID,
			"channel", command.ChannelID,
			"thread_ts", command.ThreadTS,
			"response_url_present", strings.TrimSpace(interaction.ResponseURL) != "",
		)
		r.service.StartJoinSetupSocketInteraction(context.WithoutCancel(ctx), command, interaction.ResponseURL)
		return ack(nil)
	}
	return ack(r.service.HandleSlackInteraction(context.WithoutCancel(ctx), interaction))
}

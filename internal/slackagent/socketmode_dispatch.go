// Socket Mode envelope dispatcher.
//
// IMPORTANT — protocol boundary discipline:
//
// Slack Socket Mode requires the agent to ACK every envelope within ~3
// seconds of receipt. If we miss that window Slack re-sends the envelope
// (double-processing) and the user sees the originating button as "no
// reaction" because no `response_action` is rendered. Every handler in
// this file MUST call `ack(...)` quickly. Slow work (HTTP POST to
// response_url, agent runner spawn, meeting-agent calls, follow-up
// fetches) MUST happen on a goroutine spawned BEFORE the ack returns.
// Helper: see `Service.launchAsyncInteraction` in service_interaction_async.go
// for the standard ack-first pattern + log line. New handlers added here
// must either go through that helper or document why they can ack
// inline.
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
	actionID, blockID, valueLen := slackInteractionFirstActionSummary(interaction)
	r.service.logger.Info(
		"slack socket interaction received",
		"action_id", actionID,
		"block_id", blockID,
		"value_len", valueLen,
		"channel", slackInteractionChannelID(interaction),
		"thread_ts", slackInteractionThreadTS(interaction),
		"response_url_present", strings.TrimSpace(interaction.ResponseURL) != "",
	)
	if command, ok := joinSetupCommandInputFromInteraction(interaction); ok {
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
	if response, ok := joinSetupCaptionSelectionResponse(interaction); ok {
		r.service.logger.Info(
			"slack socket interaction join setup caption update",
			"action_id", actionID,
			"channel", slackInteractionChannelID(interaction),
			"thread_ts", slackInteractionThreadTS(interaction),
			"response_url_present", strings.TrimSpace(interaction.ResponseURL) != "",
		)
		r.service.StartJoinSetupCaptionSocketInteraction(context.WithoutCancel(ctx), response, interaction.ResponseURL)
		return ack(nil)
	}
	return ack(r.service.HandleSlackInteraction(context.WithoutCancel(ctx), interaction))
}

func slackInteractionFirstActionSummary(payload SlackInteractionPayload) (string, string, int) {
	if len(payload.Actions) == 0 {
		return "", "", 0
	}
	action := payload.Actions[0]
	return strings.TrimSpace(action.ActionID), strings.TrimSpace(action.BlockID), len(strings.TrimSpace(action.Value))
}

func slackInteractionChannelID(payload SlackInteractionPayload) string {
	if payload.Channel != nil && strings.TrimSpace(payload.Channel.ID) != "" {
		return strings.TrimSpace(payload.Channel.ID)
	}
	return strings.TrimSpace(payload.ChannelID)
}

func slackInteractionThreadTS(payload SlackInteractionPayload) string {
	if payload.Message != nil {
		return firstNonEmpty(strings.TrimSpace(payload.Message.ThreadTS), strings.TrimSpace(payload.Message.TS))
	}
	return ""
}

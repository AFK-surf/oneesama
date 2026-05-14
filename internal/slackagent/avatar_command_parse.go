package slackagent

import (
	"strconv"
	"strings"
)

type parsedAvatarCommand struct {
	Action           string
	Task             string
	SessionID        string
	JobID            string
	MeetURL          string
	ValidMeetURL     bool
	BotName          string
	CaptionLanguage  string
	Reason           string
	DryRunJoiner     bool
	StartJoiner      bool
	ConfirmJoin      bool
	RealtimeJoin     bool
	RequestedMode    string
	AllowCodeChanges bool
}

func parseAvatarCommand(text string) parsedAvatarCommand {
	tokens := tokenizeAvatarCommand(text)
	if len(tokens) == 0 {
		return parsedAvatarCommand{Action: "help", StartJoiner: true}
	}

	parsed := parsedAvatarCommand{
		Action:      strings.ToLower(strings.TrimSpace(tokens[0])),
		StartJoiner: true,
	}
	taskParts := make([]string, 0)

	for index := 1; index < len(tokens); index++ {
		token := tokens[index]
		switch {
		case flagToken(token, "--session", "--session-id", "--sessionId") && index+1 < len(tokens):
			index++
			parsed.SessionID = tokens[index]
		case flagValue(token, "--session", "--session-id", "--sessionId") != "":
			parsed.SessionID = flagValue(token, "--session", "--session-id", "--sessionId")
		case flagToken(token, "--meet-url", "--meetUrl") && index+1 < len(tokens):
			index++
			parsed.MeetURL = normalizeSlackMeetURLToken(tokens[index])
		case flagValue(token, "--meet-url", "--meetUrl") != "":
			parsed.MeetURL = normalizeSlackMeetURLToken(flagValue(token, "--meet-url", "--meetUrl"))
		case flagToken(token, "--bot-name", "--botName", "--name") && index+1 < len(tokens):
			index++
			parsed.BotName = tokens[index]
		case flagValue(token, "--bot-name", "--botName", "--name") != "":
			parsed.BotName = flagValue(token, "--bot-name", "--botName", "--name")
		case flagToken(token, "--caption-language", "--captionLanguage", "--captions-language") && index+1 < len(tokens):
			index++
			parsed.CaptionLanguage = tokens[index]
		case flagValue(token, "--caption-language", "--captionLanguage", "--captions-language") != "":
			parsed.CaptionLanguage = flagValue(token, "--caption-language", "--captionLanguage", "--captions-language")
		case flagToken(token, "--reason") && index+1 < len(tokens):
			index++
			parsed.Reason = tokens[index]
		case flagValue(token, "--reason") != "":
			parsed.Reason = flagValue(token, "--reason")
		case token == "--mode" && index+1 < len(tokens):
			index++
			parsed.RequestedMode = tokens[index]
		case strings.HasPrefix(token, "--mode="):
			parsed.RequestedMode = strings.TrimSpace(strings.TrimPrefix(token, "--mode="))
		case token == "--job" && index+1 < len(tokens):
			index++
			parsed.JobID = tokens[index]
		case strings.HasPrefix(token, "--job="):
			parsed.JobID = strings.TrimSpace(strings.TrimPrefix(token, "--job="))
		case token == "--write" || token == "--allow-code-changes" || token == "--allowCodeChanges":
			parsed.AllowCodeChanges = true
			if index+1 < len(tokens) && !strings.HasPrefix(tokens[index+1], "--") {
				index++
				parsed.AllowCodeChanges = parseOptionalBool(tokens[index], true)
			}
		case strings.HasPrefix(token, "--write="):
			parsed.AllowCodeChanges = parseOptionalBool(strings.TrimPrefix(token, "--write="), true)
		case strings.HasPrefix(token, "--allow-code-changes="):
			parsed.AllowCodeChanges = parseOptionalBool(strings.TrimPrefix(token, "--allow-code-changes="), true)
		case strings.HasPrefix(token, "--allowCodeChanges="):
			parsed.AllowCodeChanges = parseOptionalBool(strings.TrimPrefix(token, "--allowCodeChanges="), true)
		case token == "--dry-run" || token == "--dryRun":
			parsed.DryRunJoiner = true
			if index+1 < len(tokens) && !strings.HasPrefix(tokens[index+1], "--") {
				index++
				parsed.DryRunJoiner = parseOptionalBool(tokens[index], true)
			}
		case strings.HasPrefix(token, "--dry-run="):
			parsed.DryRunJoiner = parseOptionalBool(strings.TrimPrefix(token, "--dry-run="), true)
		case strings.HasPrefix(token, "--dryRun="):
			parsed.DryRunJoiner = parseOptionalBool(strings.TrimPrefix(token, "--dryRun="), true)
		case token == "--real":
			parsed.DryRunJoiner = false
		case token == "--start-joiner" || token == "--startJoiner":
			parsed.StartJoiner = true
			if index+1 < len(tokens) && !strings.HasPrefix(tokens[index+1], "--") {
				index++
				parsed.StartJoiner = parseOptionalBool(tokens[index], true)
			}
		case strings.HasPrefix(token, "--start-joiner="):
			parsed.StartJoiner = parseOptionalBool(strings.TrimPrefix(token, "--start-joiner="), true)
		case strings.HasPrefix(token, "--startJoiner="):
			parsed.StartJoiner = parseOptionalBool(strings.TrimPrefix(token, "--startJoiner="), true)
		case token == "--confirm" || token == "--confirmed":
			parsed.ConfirmJoin = true
		case token == "--realtime" || token == "--realtime-join" || token == "--realtimeJoin":
			parsed.RealtimeJoin = true
			if index+1 < len(tokens) && !strings.HasPrefix(tokens[index+1], "--") {
				index++
				parsed.RealtimeJoin = parseOptionalBool(tokens[index], true)
			}
		case strings.HasPrefix(token, "--realtime="):
			parsed.RealtimeJoin = parseOptionalBool(strings.TrimPrefix(token, "--realtime="), true)
		case strings.HasPrefix(token, "--realtime-join="):
			parsed.RealtimeJoin = parseOptionalBool(strings.TrimPrefix(token, "--realtime-join="), true)
		case strings.HasPrefix(token, "--realtimeJoin="):
			parsed.RealtimeJoin = parseOptionalBool(strings.TrimPrefix(token, "--realtimeJoin="), true)
		case parsed.Action == "cancel" && parsed.JobID == "":
			parsed.JobID = token
		case parsed.Action == "join" && parsed.MeetURL == "":
			if meetURL := normalizeSlackMeetURLToken(token); meetURL != "" {
				parsed.MeetURL = meetURL
			} else {
				taskParts = append(taskParts, token)
			}
		case parsed.Action == "delegate" && parsed.SessionID == "" && strings.HasPrefix(token, "meet_"):
			parsed.SessionID = token
		case (parsed.Action == "status" || parsed.Action == "jobs" || parsed.Action == "stop") && parsed.SessionID == "":
			parsed.SessionID = token
		default:
			taskParts = append(taskParts, token)
		}
	}

	if strings.TrimSpace(parsed.RequestedMode) == "" {
		parsed.RequestedMode = "analysis"
	}
	parsed.ValidMeetURL = parsed.MeetURL != "" && slackMeetURLPattern.MatchString(parsed.MeetURL)
	if !parsed.StartJoiner {
		parsed.DryRunJoiner = true
	}
	parsed.Task = strings.TrimSpace(strings.Join(taskParts, " "))
	return parsed
}

func normalizeSlackMeetURLToken(token string) string {
	return findSlackMeetURL(strings.TrimSpace(token))
}

func flagToken(token string, names ...string) bool {
	for _, name := range names {
		if token == name {
			return true
		}
	}
	return false
}

func flagValue(token string, names ...string) string {
	for _, name := range names {
		prefix := name + "="
		if strings.HasPrefix(token, prefix) {
			return strings.TrimSpace(strings.TrimPrefix(token, prefix))
		}
	}
	return ""
}

func tokenizeAvatarCommand(text string) []string {
	source := strings.TrimSpace(text)
	if source == "" {
		return nil
	}

	tokens := make([]string, 0)
	var current strings.Builder
	var quote rune
	escaped := false
	slackEntity := false

	flush := func() {
		if current.Len() == 0 {
			return
		}
		tokens = append(tokens, current.String())
		current.Reset()
	}

	for _, char := range source {
		switch {
		case escaped:
			current.WriteRune(char)
			escaped = false
		case char == '\\':
			escaped = true
		case quote != 0:
			if char == quote {
				quote = 0
			} else {
				current.WriteRune(char)
			}
		case slackEntity:
			current.WriteRune(char)
			if char == '>' {
				slackEntity = false
			}
		case char == '"' || char == '\'':
			quote = char
		case char == '<' && (current.Len() == 0 || strings.HasSuffix(current.String(), "=")):
			current.WriteRune(char)
			slackEntity = true
		case char == ' ' || char == '\t' || char == '\n':
			flush()
		default:
			current.WriteRune(char)
		}
	}

	flush()
	return tokens
}

func parseOptionalBool(raw string, fallback bool) bool {
	value, err := strconv.ParseBool(strings.TrimSpace(raw))
	if err != nil {
		return fallback
	}
	return value
}

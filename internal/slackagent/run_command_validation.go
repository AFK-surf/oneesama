package slackagent

import (
	"errors"
	"fmt"
	"net"
	"net/url"
	"regexp"
	"strings"
)

var allowedRunCommandPrograms = map[string]struct{}{
	"gh":   {},
	"curl": {},
	"date": {},
}

var allowedGHSubcommands = map[string]map[string]struct{}{
	"run":      {"list": {}, "view": {}, "watch": {}},
	"pr":       {"list": {}, "view": {}, "checks": {}, "status": {}, "diff": {}},
	"issue":    {"list": {}, "view": {}},
	"repo":     {"view": {}},
	"search":   {"prs": {}, "issues": {}, "repos": {}, "code": {}, "commits": {}},
	"workflow": {"list": {}, "view": {}},
	"auth":     {"status": {}},
}

var shellOperatorTokens = map[string]struct{}{
	"|": {}, "||": {}, "&": {}, "&&": {}, ";": {}, ">": {}, ">>": {}, "<": {}, "<<": {},
}

var envAssignmentPattern = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*=.*$`)

type validatedRunCommand struct {
	env  []string
	name string
	args []string
}

func validateRunCommand(command string) (*validatedRunCommand, error) {
	tokens, err := splitCommandTokens(command)
	if err != nil {
		return nil, err
	}

	env, argv, err := splitEnvAssignments(tokens)
	if err != nil {
		return nil, err
	}
	for _, token := range argv {
		if _, blocked := shellOperatorTokens[token]; blocked {
			return nil, fmt.Errorf("blocked command: shell operators like %q are not allowed", token)
		}
	}

	name := argv[0]
	if _, ok := allowedRunCommandPrograms[name]; !ok {
		return nil, fmt.Errorf("blocked command: only gh, curl, and date are allowed")
	}
	switch name {
	case "gh":
		if err := validateGHCommand(argv); err != nil {
			return nil, err
		}
	case "curl":
		if err := validateCurlCommand(argv); err != nil {
			return nil, err
		}
	case "date":
	default:
		return nil, fmt.Errorf("blocked command: %s is not allowed", name)
	}

	return &validatedRunCommand{env: env, name: name, args: argv[1:]}, nil
}

func splitCommandTokens(command string) ([]string, error) {
	var tokens []string
	var current strings.Builder
	var quote rune
	escaped := false
	flush := func() {
		if current.Len() == 0 {
			return
		}
		tokens = append(tokens, current.String())
		current.Reset()
	}

	for _, r := range command {
		switch {
		case escaped:
			current.WriteRune(r)
			escaped = false
		case quote != 0:
			if r == quote {
				quote = 0
				continue
			}
			if quote == '"' && r == '\\' {
				escaped = true
				continue
			}
			current.WriteRune(r)
		default:
			switch r {
			case '\\':
				escaped = true
			case '\'', '"':
				quote = r
			case ' ', '\t':
				flush()
			case '\n', '\r':
				return nil, errors.New("blocked command: newlines are not allowed")
			default:
				current.WriteRune(r)
			}
		}
	}
	if escaped {
		return nil, errors.New("blocked command: unterminated escape sequence")
	}
	if quote != 0 {
		return nil, errors.New("blocked command: unterminated quote")
	}
	flush()
	if len(tokens) == 0 {
		return nil, errors.New("command is required")
	}
	return tokens, nil
}

func splitEnvAssignments(tokens []string) ([]string, []string, error) {
	var env []string
	i := 0
	for i < len(tokens) && envAssignmentPattern.MatchString(tokens[i]) {
		env = append(env, tokens[i])
		i++
	}
	if i >= len(tokens) {
		return nil, nil, errors.New("blocked command: missing executable after environment assignments")
	}
	return env, tokens[i:], nil
}

func validateGHCommand(argv []string) error {
	if len(argv) < 3 {
		return errors.New("blocked command: gh is limited to specific read-only subcommands")
	}
	group := argv[1]
	action := argv[2]
	actions, ok := allowedGHSubcommands[group]
	if !ok {
		return fmt.Errorf("blocked command: gh %s is not allowed", group)
	}
	if _, ok := actions[action]; !ok {
		return fmt.Errorf("blocked command: gh %s %s is not allowed", group, action)
	}
	return nil
}

func validateCurlCommand(argv []string) error {
	hasURL := false
	for i := 1; i < len(argv); i++ {
		token := argv[i]
		switch {
		case token == "--url":
			i++
			if i >= len(argv) {
				return errors.New("blocked command: curl --url requires a value")
			}
			if err := validatePublicHTTPSURL(argv[i]); err != nil {
				return err
			}
			hasURL = true
		case strings.HasPrefix(token, "--url="):
			if err := validatePublicHTTPSURL(strings.TrimPrefix(token, "--url=")); err != nil {
				return err
			}
			hasURL = true
		case isBlockedCurlFlag(token):
			return fmt.Errorf("blocked command: curl flag %q is not allowed", token)
		case strings.HasPrefix(token, "https://"):
			if err := validatePublicHTTPSURL(token); err != nil {
				return err
			}
			hasURL = true
		case strings.HasPrefix(token, "http://"), strings.HasPrefix(token, "file://"):
			return errors.New("blocked command: curl may only access public https URLs")
		}
	}
	if !hasURL {
		return errors.New("blocked command: curl requires a public https URL")
	}
	return nil
}

func isBlockedCurlFlag(token string) bool {
	switch token {
	case "-d", "--data", "--data-raw", "--data-binary", "--data-urlencode",
		"-F", "--form",
		"-T", "--upload-file",
		"-o", "--output", "-O", "--remote-name", "--remote-name-all",
		"-K", "--config",
		"-X", "--request":
		return true
	}
	return strings.HasPrefix(token, "--data=") ||
		strings.HasPrefix(token, "--data-raw=") ||
		strings.HasPrefix(token, "--data-binary=") ||
		strings.HasPrefix(token, "--data-urlencode=") ||
		strings.HasPrefix(token, "--form=") ||
		strings.HasPrefix(token, "--upload-file=") ||
		strings.HasPrefix(token, "--output=") ||
		strings.HasPrefix(token, "--request=") ||
		strings.HasPrefix(token, "--config=")
}

func validatePublicHTTPSURL(raw string) error {
	parsed, err := url.Parse(raw)
	if err != nil {
		return fmt.Errorf("blocked command: invalid URL %q", raw)
	}
	if parsed.Scheme != "https" {
		return errors.New("blocked command: curl may only access public https URLs")
	}
	host := strings.ToLower(parsed.Hostname())
	if host == "" {
		return fmt.Errorf("blocked command: invalid URL %q", raw)
	}
	if host == "localhost" || strings.HasSuffix(host, ".local") || strings.HasSuffix(host, ".internal") || strings.HasSuffix(host, ".lan") {
		return errors.New("blocked command: curl may not access local network hosts")
	}
	if ip := net.ParseIP(host); ip != nil && isPrivateNetworkIP(ip) {
		return errors.New("blocked command: curl may not access private or loopback IPs")
	}
	return nil
}

func isPrivateNetworkIP(ip net.IP) bool {
	return ip.IsPrivate() ||
		ip.IsLoopback() ||
		ip.IsLinkLocalMulticast() ||
		ip.IsLinkLocalUnicast() ||
		ip.IsUnspecified() ||
		ip.IsMulticast()
}

//go:build cueboardparity

package slackagent

import "testing"

func TestCueboardParityValidateRunCommand(t *testing.T) {
	tests := []struct {
		name    string
		command string
		blocked bool
	}{
		{name: "allow gh run list", command: "gh run list --limit 5"},
		{name: "allow gh pr view", command: "gh pr view 123 --repo OWNER/REPO"},
		{name: "allow gh with env", command: "GH_REPO=OWNER/REPO gh run view 123"},
		{name: "allow curl public https", command: "curl https://api.github.com/repos/OWNER/REPO"},
		{name: "allow quoted curl query", command: `curl "https://api.github.com/search/issues?q=repo:OWNER/REPO+is:open&per_page=1"`},
		{name: "allow date", command: "date -u"},
		{name: "block python http server", command: "python3 -m http.server 8888", blocked: true},
		{name: "block python inline http server", command: `python3 -c "import http.server; http.server.test()"`, blocked: true},
		{name: "block nc listen", command: "nc -l 4444", blocked: true},
		{name: "block screencapture", command: "screencapture -x /tmp/desktop.png", blocked: true},
		{name: "block osascript", command: `osascript -e 'tell application "Finder" to activate'`, blocked: true},
		{name: "block disallowed program", command: "bash -c 'echo hi'", blocked: true},
		{name: "block shell pipe", command: "curl https://api.github.com | jq .", blocked: true},
		{name: "block git", command: "git status --short", blocked: true},
		{name: "block gh mutation-like subcommand", command: "gh pr create --title test --body test", blocked: true},
		{name: "block gh api", command: "gh api graphql -f query='{viewer{login}}'", blocked: true},
		{name: "block curl private ip", command: "curl https://127.0.0.1:8080/health", blocked: true},
		{name: "block curl localhost hostname", command: "curl https://localhost:3000/health", blocked: true},
		{name: "block curl local domain", command: "curl https://devbox.local/health", blocked: true},
		{name: "block curl file scheme", command: "curl file:///tmp/secret.txt", blocked: true},
		{name: "block curl post body", command: "curl -d '{\"query\":\"{}\"}' https://api.github.com/graphql", blocked: true},
		{name: "block curl explicit request", command: "curl --request POST https://api.github.com/graphql", blocked: true},
		{name: "block malformed quoting", command: `gh run list --repo "OWNER/REPO`, blocked: true},
	}

	for _, tt := range tests {
		tt := tt
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			_, err := validateRunCommand(tt.command)
			if tt.blocked && err == nil {
				t.Fatalf("validateRunCommand(%q) should block", tt.command)
			}
			if !tt.blocked && err != nil {
				t.Fatalf("validateRunCommand(%q) should allow, got %v", tt.command, err)
			}
		})
	}
}

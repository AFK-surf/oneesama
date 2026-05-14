package integration

import (
	"bytes"
	"context"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/AFK-surf/oneesama/internal/httpserver"
	"github.com/AFK-surf/oneesama/internal/internalauth"
	"github.com/AFK-surf/oneesama/internal/meetingagent"
	"github.com/AFK-surf/oneesama/pkg/config"
)

func TestMeetingManagedServerShutdownStopsMeetRunnerChild(t *testing.T) {
	requireMeetRunnerRuntime(t)
	requireProcessInspectionTools(t)

	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	rootDir := t.TempDir()

	cfg := config.Config{
		MeetingAgent: config.ServiceConfig{AllowedOrigins: []string{"*"}},
		Slack: config.SlackConfig{
			InternalAuthKey: "integration-key",
		},
		Persistence: config.PersistenceConfig{
			Provider: "json-file",
			DataDir:  rootDir + "/state",
		},
		Paths: config.PathsConfig{
			MeetRunnerDir: repoPath(t, "meet-runner"),
		},
	}

	listener := newListener(t)
	cfg.MeetingAgent.Listen = listener.Addr().String()
	managed := meetingagent.NewServer(cfg, logger.With("service", "meeting-agent"))
	baseURL := serveManagedServer(t, managed, listener)

	parentPID := os.Getpid()
	before := meetRunnerChildPIDs(t, parentPID)

	joinResponse := postJSON(t, baseURL+"/join/google-meet", `{
		"session_id":"session_shutdown_smoke",
		"meeting_url":"https://meet.google.com/abc-defg-hij",
		"display_name":"Onee-sama",
		"title":"Shutdown Smoke",
		"dry_run":true
	}`, map[string]string{
		internalauth.HeaderName: "integration-key",
	})
	if joinResponse.StatusCode != http.StatusOK {
		t.Fatalf("join status = %d, want 200", joinResponse.StatusCode)
	}
	joinBody := readBody(t, joinResponse)
	if !bytes.Contains(joinBody, []byte(`"accepted":true`)) {
		t.Fatalf("join body = %s, want accepted response", joinBody)
	}

	childPID := waitForNewMeetRunnerChildPID(t, parentPID, before)
	shutdownManagedServerNow(t, managed)
	waitForProcessExit(t, childPID)
}

func requireProcessInspectionTools(t *testing.T) {
	t.Helper()
	if _, err := exec.LookPath("pgrep"); err != nil {
		t.Skip("pgrep not available")
	}
	if _, err := exec.LookPath("ps"); err != nil {
		t.Skip("ps not available")
	}
}

func shutdownManagedServerNow(t *testing.T, managed *httpserver.ManagedServer) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	if err := managed.Server.Shutdown(ctx); err != nil && !errors.Is(err, http.ErrServerClosed) {
		t.Fatalf("shutdown server: %v", err)
	}
	if managed.Shutdown != nil {
		if err := managed.Shutdown(ctx); err != nil {
			t.Fatalf("shutdown managed cleanup: %v", err)
		}
	}
}

func waitForNewMeetRunnerChildPID(t *testing.T, parentPID int, before map[int]struct{}) int {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		for pid := range meetRunnerChildPIDs(t, parentPID) {
			if _, existed := before[pid]; !existed {
				return pid
			}
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatal("timed out waiting for meet-runner child process")
	return 0
}

func waitForProcessExit(t *testing.T, pid int) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if !processExists(t, pid) {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatalf("process %d still running after managed shutdown", pid)
}

func meetRunnerChildPIDs(t *testing.T, parentPID int) map[int]struct{} {
	t.Helper()
	output, err := exec.Command("pgrep", "-P", strconv.Itoa(parentPID)).Output()
	if err != nil {
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) && exitErr.ExitCode() == 1 {
			return map[int]struct{}{}
		}
		t.Fatalf("pgrep children of %d: %v", parentPID, err)
	}

	childPIDs := make(map[int]struct{})
	for _, field := range strings.Fields(string(output)) {
		pid, err := strconv.Atoi(field)
		if err != nil {
			t.Fatalf("parse child pid %q: %v", field, err)
		}
		commandLine, err := processCommandLine(pid)
		if err != nil {
			continue
		}
		if strings.Contains(commandLine, "node") && strings.Contains(commandLine, "src/index.ts") {
			childPIDs[pid] = struct{}{}
		}
	}
	return childPIDs
}

func processExists(t *testing.T, pid int) bool {
	t.Helper()
	output, err := exec.Command("ps", "-o", "pid=", "-p", strconv.Itoa(pid)).Output()
	if err != nil {
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) {
			return false
		}
		t.Fatalf("ps pid %d: %v", pid, err)
	}
	return strings.TrimSpace(string(output)) != ""
}

func processCommandLine(pid int) (string, error) {
	output, err := exec.Command("ps", "-o", "command=", "-p", strconv.Itoa(pid)).Output()
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(output)), nil
}

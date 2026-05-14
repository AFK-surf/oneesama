package meetrunner

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

const defaultTimeout = 10 * time.Second
const joinLaunchTimeout = 4 * time.Minute

type Config struct {
	Dir     string
	Command string
	Timeout time.Duration
}

type Manager struct {
	dir     string
	command string
	timeout time.Duration

	mu       sync.Mutex
	sessions map[string]*Session
}

func New(cfg Config) *Manager {
	dir := strings.TrimSpace(cfg.Dir)
	if dir == "" {
		dir = "./meet-runner"
	}
	if absoluteDir, err := filepath.Abs(dir); err == nil {
		dir = absoluteDir
	}
	timeout := cfg.Timeout
	if timeout <= 0 {
		timeout = defaultTimeout
	}
	return &Manager{
		dir:      dir,
		command:  strings.TrimSpace(cfg.Command),
		timeout:  timeout,
		sessions: make(map[string]*Session),
	}
}

func (m *Manager) Ping(_ context.Context) (RunnerStatus, error) {
	entry := m.entrypoint()
	commandPath, _, err := resolveRunnerCommand(m.dir, m.command)
	if err != nil {
		return RunnerStatus{}, err
	}
	if _, err := os.Stat(commandPath); err != nil {
		return RunnerStatus{}, fmt.Errorf("stat meet-runner command %s: %w", commandPath, err)
	}
	if _, err := os.Stat(entry); err != nil {
		return RunnerStatus{}, fmt.Errorf("stat meet-runner entrypoint %s: %w", entry, err)
	}
	return RunnerStatus{
		OK:         true,
		Name:       "meet-runner",
		Entry:      entry,
		BridgeMode: "persistent-session",
		Capabilities: []string{
			"runner.ping", "join.google_meet.prepare", "join.session.status", "join.session.stop",
			"worker.result.inject", "screen_share.start", "screen_share.present",
			"screen_share.video", "screen_share.stop",
		},
	}, nil
}

func (m *Manager) PrepareGoogleMeet(ctx context.Context, input PrepareGoogleMeetInput) (PrepareGoogleMeetResult, error) {
	if _, err := m.Ping(ctx); err != nil {
		return PrepareGoogleMeetResult{}, err
	}
	sessionID := strings.TrimSpace(firstNonEmpty(input.SessionID, newEphemeralSessionID()))
	worker, err := m.ensureSession(sessionID)
	if err != nil {
		return PrepareGoogleMeetResult{}, err
	}

	request := input
	request.SessionID = sessionID

	var result PrepareGoogleMeetResult
	timeout := time.Duration(0)
	if !input.DryRun {
		timeout = joinLaunchTimeout
	}
	if err := worker.CallWithTimeout(ctx, timeout, "join.google_meet.prepare", request, &result); err != nil {
		_ = m.dropSession(sessionID)
		return PrepareGoogleMeetResult{}, err
	}
	return result, nil
}

func (m *Manager) InjectWorkerResult(ctx context.Context, input WorkerResultInput) (WorkerResultDelivery, error) {
	worker, err := m.resolveCallSession(input.SessionID)
	if err != nil {
		return WorkerResultDelivery{}, err
	}
	var result WorkerResultDelivery
	if err := worker.Call(ctx, "worker.result.inject", input, &result); err != nil {
		return WorkerResultDelivery{}, err
	}
	return result, nil
}

func (m *Manager) StartScreenShare(ctx context.Context, input ScreenShareInput) (ScreenShareResult, error) {
	return m.callScreenShare(ctx, input.SessionID, "screen_share.start", input)
}

func (m *Manager) PresentScreenShare(ctx context.Context, input ScreenShareInput) (ScreenShareResult, error) {
	return m.callScreenShare(ctx, input.SessionID, "screen_share.present", input)
}

func (m *Manager) PresentVideoStage(ctx context.Context, input VideoStageInput) (ScreenShareResult, error) {
	return m.callScreenShare(ctx, input.SessionID, "screen_share.video", input)
}

func (m *Manager) StopScreenShare(ctx context.Context, input ScreenShareInput) (ScreenShareResult, error) {
	return m.callScreenShare(ctx, input.SessionID, "screen_share.stop", input)
}

func (m *Manager) callScreenShare(ctx context.Context, sessionID string, method string, input any) (ScreenShareResult, error) {
	worker, err := m.resolveCallSession(sessionID)
	if err != nil {
		return nil, err
	}
	var result ScreenShareResult
	if err := worker.Call(ctx, method, input, &result); err != nil {
		return nil, err
	}
	return result, nil
}

func (m *Manager) StopSession(ctx context.Context, input StopSessionInput) (StopSessionResult, error) {
	sessionID := strings.TrimSpace(input.SessionID)
	if sessionID == "" {
		return StopSessionResult{}, fmt.Errorf("session_id is required")
	}

	worker, ok := m.session(sessionID)
	if !ok {
		return StopSessionResult{}, fmt.Errorf("meet-runner session %s not found", sessionID)
	}

	var result StopSessionResult
	err := worker.Call(ctx, "join.session.stop", input, &result)
	closeErr := m.dropSession(sessionID)
	if err != nil {
		return StopSessionResult{}, err
	}
	if closeErr != nil {
		return StopSessionResult{}, closeErr
	}
	return result, nil
}

func (m *Manager) Shutdown(ctx context.Context) error {
	workers := m.takeAllSessions()
	var shutdownErr error
	for _, worker := range workers {
		select {
		case <-ctx.Done():
			return errors.Join(shutdownErr, ctx.Err())
		default:
		}
		if err := worker.Close(); err != nil {
			shutdownErr = errors.Join(shutdownErr, err)
		}
	}
	return shutdownErr
}

func (m *Manager) ensureSession(sessionID string) (*Session, error) {
	if worker, ok := m.session(sessionID); ok {
		return worker, nil
	}

	m.mu.Lock()
	defer m.mu.Unlock()

	if worker, ok := m.sessions[sessionID]; ok {
		return worker, nil
	}

	worker, err := NewSession(SessionConfig{
		ID:      sessionID,
		Dir:     m.dir,
		Command: m.command,
		Timeout: m.timeout,
	})
	if err != nil {
		return nil, err
	}
	m.sessions[sessionID] = worker
	return worker, nil
}

func (m *Manager) session(sessionID string) (*Session, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	worker, ok := m.sessions[sessionID]
	return worker, ok
}

func (m *Manager) resolveCallSession(sessionID string) (*Session, error) {
	trimmedID := strings.TrimSpace(sessionID)
	m.mu.Lock()
	defer m.mu.Unlock()
	if trimmedID != "" {
		worker, ok := m.sessions[trimmedID]
		if !ok {
			return nil, fmt.Errorf("meet-runner session %s not found", trimmedID)
		}
		return worker, nil
	}
	if len(m.sessions) == 0 {
		return nil, fmt.Errorf("no_active_join")
	}
	if len(m.sessions) > 1 {
		return nil, fmt.Errorf("session_id is required")
	}
	for _, worker := range m.sessions {
		return worker, nil
	}
	return nil, fmt.Errorf("no_active_join")
}

func (m *Manager) dropSession(sessionID string) error {
	m.mu.Lock()
	worker, ok := m.sessions[sessionID]
	if ok {
		delete(m.sessions, sessionID)
	}
	m.mu.Unlock()
	if !ok {
		return nil
	}
	return worker.Close()
}

func (m *Manager) takeAllSessions() []*Session {
	m.mu.Lock()
	defer m.mu.Unlock()

	workers := make([]*Session, 0, len(m.sessions))
	for sessionID, worker := range m.sessions {
		workers = append(workers, worker)
		delete(m.sessions, sessionID)
	}
	return workers
}

func (m *Manager) entrypoint() string {
	return filepath.Join(m.dir, "src", "index.ts")
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if trimmed := strings.TrimSpace(value); trimmed != "" {
			return trimmed
		}
	}
	return ""
}

func newEphemeralSessionID() string {
	buffer := make([]byte, 4)
	if _, err := rand.Read(buffer); err != nil {
		return fmt.Sprintf("session_%d", time.Now().UTC().UnixNano())
	}
	return "session_" + hex.EncodeToString(buffer)
}

func resolveRunnerCommand(dir string, override string) (string, []string, error) {
	if trimmed := strings.TrimSpace(override); trimmed != "" {
		return trimmed, []string{"src/index.ts"}, nil
	}
	nodePath, err := exec.LookPath("node")
	if err != nil {
		return "", nil, fmt.Errorf("look up node runtime: %w", err)
	}
	return nodePath, []string{"src/index.ts"}, nil
}

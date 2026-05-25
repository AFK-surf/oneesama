package meetingagent

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os/exec"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/AFK-surf/oneesama/internal/processutil"
)

const kwwkAppControlMethod = "app_control.control_shared_app_window"
const maxKWWKAppControlMessageBytes = 1 << 20
const defaultKWWKAppControlTimeout = 2 * time.Second

type KWWKStdioAppControlConfig struct {
	Command string
	Dir     string
	Timeout time.Duration
}

type KWWKStdioAppControlBackend struct {
	command string
	dir     string
	timeout time.Duration

	mu      sync.Mutex
	session *kwwkStdioSession
}

func NewKWWKStdioAppControlBackend(cfg KWWKStdioAppControlConfig) *KWWKStdioAppControlBackend {
	timeout := cfg.Timeout
	if timeout <= 0 {
		timeout = defaultKWWKAppControlTimeout
	}
	return &KWWKStdioAppControlBackend{
		command: strings.TrimSpace(cfg.Command),
		dir:     strings.TrimSpace(cfg.Dir),
		timeout: timeout,
	}
}

func (b *KWWKStdioAppControlBackend) Name() string {
	return "kwwk"
}

func (b *KWWKStdioAppControlBackend) ControlSharedApp(ctx context.Context, req AppControlRequest) (AppControlResult, error) {
	if b == nil || strings.TrimSpace(b.command) == "" {
		return AppControlResult{
			OK:       false,
			Provider: "kwwk",
			Status:   appControlStatusFailed,
			Error:    "kwwk_app_control_unconfigured",
			Blocker:  "kwwk_app_control_unconfigured",
		}, nil
	}
	timeout := req.Timeout
	if timeout <= 0 || timeout > b.timeout {
		timeout = b.timeout
	}
	session, err := b.ensureSession(ctx)
	if err != nil {
		return AppControlResult{
			OK:       false,
			Provider: "kwwk",
			Status:   appControlStatusFailed,
			Error:    "kwwk_app_control_start_failed",
			Blocker:  err.Error(),
		}, nil
	}
	params := kwwkAppControlRequest{
		SessionID:   req.SessionID,
		Instruction: req.Instruction,
		Target:      KWWKTargetFromAppControl(req.Target),
		Operations:  append([]KWWKAppControlOperation(nil), req.Operations...),
		Context:     req.Context,
	}
	var response kwwkAppControlResponse
	if err := session.Call(ctx, timeout, kwwkAppControlMethod, params, &response); err != nil {
		b.resetSession()
		return AppControlResult{
			OK:       false,
			Provider: "kwwk",
			Status:   appControlStatusFailed,
			Error:    "kwwk_app_control_unavailable",
			Blocker:  err.Error(),
		}, nil
	}
	return response.appControlResult(), nil
}

func (b *KWWKStdioAppControlBackend) Shutdown(ctx context.Context) error {
	b.mu.Lock()
	session := b.session
	b.session = nil
	b.mu.Unlock()
	if session == nil {
		return nil
	}
	return session.Close(ctx)
}

func (b *KWWKStdioAppControlBackend) ensureSession(ctx context.Context) (*kwwkStdioSession, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.session != nil && !b.session.closed.Load() {
		return b.session, nil
	}
	session, err := newKWWKStdioSession(ctx, kwwkStdioSessionConfig{
		Command: b.command,
		Dir:     b.dir,
	})
	if err != nil {
		return nil, err
	}
	b.session = session
	return session, nil
}

func (b *KWWKStdioAppControlBackend) resetSession() {
	b.mu.Lock()
	session := b.session
	b.session = nil
	b.mu.Unlock()
	if session != nil {
		_ = session.Close(context.Background())
	}
}

type kwwkAppControlRequest struct {
	SessionID   string                    `json:"session_id,omitempty"`
	Instruction string                    `json:"instruction"`
	Target      KWWKAppControlTarget      `json:"target"`
	Operations  []KWWKAppControlOperation `json:"operations,omitempty"`
	Context     map[string]any            `json:"context,omitempty"`
}

type kwwkAppControlResponse struct {
	OK         bool                      `json:"ok"`
	Summary    string                    `json:"summary,omitempty"`
	Actions    []string                  `json:"actions,omitempty"`
	Confidence float64                   `json:"confidence,omitempty"`
	Blocker    string                    `json:"blocker,omitempty"`
	Operations []KWWKAppControlOperation `json:"operations,omitempty"`
	Metadata   map[string]any            `json:"metadata,omitempty"`
}

func (r kwwkAppControlResponse) appControlResult() AppControlResult {
	status := appControlStatusCompleted
	errorText := ""
	if !r.OK {
		status = appControlStatusFailed
		errorText = "app_control_blocked"
	}
	raw := map[string]any{
		"operations": r.Operations,
		"metadata":   r.Metadata,
	}
	return AppControlResult{
		OK:         r.OK,
		Provider:   "kwwk",
		Status:     status,
		Summary:    strings.TrimSpace(r.Summary),
		Actions:    append([]string(nil), r.Actions...),
		Confidence: r.Confidence,
		Blocker:    strings.TrimSpace(r.Blocker),
		Error:      errorText,
		Raw:        raw,
	}
}

type kwwkStdioSessionConfig struct {
	Command string
	Dir     string
}

type kwwkStdioSession struct {
	command *exec.Cmd
	stdin   io.WriteCloser
	stderr  *bytes.Buffer

	mu         sync.Mutex
	closed     atomic.Bool
	closeOnce  sync.Once
	requestSeq atomic.Uint64
	responses  chan kwwkRPCResponse
	readErr    chan error
	waitDone   chan error
}

type kwwkRPCRequest struct {
	JSONRPC string `json:"jsonrpc"`
	ID      string `json:"id"`
	Method  string `json:"method"`
	Params  any    `json:"params,omitempty"`
}

type kwwkRPCResponse struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      string          `json:"id"`
	Result  json.RawMessage `json:"result,omitempty"`
	Error   *kwwkRPCError   `json:"error,omitempty"`
}

type kwwkRPCError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

func newKWWKStdioSession(_ context.Context, cfg kwwkStdioSessionConfig) (*kwwkStdioSession, error) {
	command := exec.Command("/bin/sh", "-c", cfg.Command)
	if strings.TrimSpace(cfg.Dir) != "" {
		command.Dir = strings.TrimSpace(cfg.Dir)
	}
	processutil.PrepareGroup(command)
	stdin, err := command.StdinPipe()
	if err != nil {
		return nil, fmt.Errorf("create kwwk stdin pipe: %w", err)
	}
	stdout, err := command.StdoutPipe()
	if err != nil {
		return nil, fmt.Errorf("create kwwk stdout pipe: %w", err)
	}
	stderr := &bytes.Buffer{}
	command.Stderr = stderr
	if err := command.Start(); err != nil {
		return nil, fmt.Errorf("start kwwk app-control helper: %w", err)
	}
	session := &kwwkStdioSession{
		command:   command,
		stdin:     stdin,
		stderr:    stderr,
		responses: make(chan kwwkRPCResponse),
		readErr:   make(chan error, 1),
		waitDone:  make(chan error, 1),
	}
	go session.readLoop(stdout)
	go func() {
		session.waitDone <- command.Wait()
	}()
	return session, nil
}

func (s *kwwkStdioSession) Call(ctx context.Context, timeout time.Duration, method string, params any, target any) error {
	if timeout <= 0 {
		timeout = defaultRealtimeAppControlTimeout
	}
	callCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	requestID := fmt.Sprintf("%d", s.requestSeq.Add(1))
	payload, err := json.Marshal(kwwkRPCRequest{
		JSONRPC: "2.0",
		ID:      requestID,
		Method:  method,
		Params:  params,
	})
	if err != nil {
		return fmt.Errorf("marshal kwwk %s request: %w", method, err)
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed.Load() {
		return fmt.Errorf("kwwk app-control helper is closed")
	}
	if _, err := s.stdin.Write(append(payload, '\n')); err != nil {
		return fmt.Errorf("write kwwk %s request: %w", method, err)
	}
	for {
		select {
		case response := <-s.responses:
			if response.ID != requestID {
				continue
			}
			if response.Error != nil {
				return fmt.Errorf("kwwk %s failed: %s", method, response.Error.Message)
			}
			if target == nil {
				return nil
			}
			if err := json.Unmarshal(response.Result, target); err != nil {
				return fmt.Errorf("decode kwwk %s result: %w", method, err)
			}
			return nil
		case err := <-s.readErr:
			if err == nil {
				return fmt.Errorf("kwwk %s closed without response", method)
			}
			return fmt.Errorf("kwwk %s stream failed: %w (%s)", method, err, strings.TrimSpace(s.stderr.String()))
		case <-callCtx.Done():
			_ = s.Close(context.Background())
			return fmt.Errorf("kwwk %s timed out after %s: %w", method, timeout, callCtx.Err())
		}
	}
}

func (s *kwwkStdioSession) Close(_ context.Context) error {
	var closeErr error
	s.closeOnce.Do(func() {
		s.closed.Store(true)
		if s.stdin != nil {
			_ = s.stdin.Close()
		}
		timer := time.NewTimer(250 * time.Millisecond)
		defer timer.Stop()
		select {
		case err := <-s.waitDone:
			closeErr = err
		case <-timer.C:
			closeErr = processutil.KillGroup("kwwk-app-control", s.command)
			<-s.waitDone
		}
	})
	return closeErr
}

func (s *kwwkStdioSession) readLoop(stdout io.Reader) {
	scanner := bufio.NewScanner(stdout)
	scanner.Buffer(make([]byte, 0, 64*1024), maxKWWKAppControlMessageBytes)
	for scanner.Scan() {
		trimmed := strings.TrimSpace(scanner.Text())
		if trimmed == "" {
			continue
		}
		if !strings.HasPrefix(trimmed, "{") || !strings.Contains(trimmed, `"jsonrpc"`) || !strings.Contains(trimmed, `"id"`) {
			_, _ = s.stderr.Write([]byte("[kwwk stdout] " + trimmed + "\n"))
			continue
		}
		var response kwwkRPCResponse
		if err := json.Unmarshal([]byte(trimmed), &response); err != nil {
			_, _ = s.stderr.Write([]byte("[kwwk stdout malformed jsonrpc-like] " + trimmed + "\n"))
			continue
		}
		s.responses <- response
	}
	if err := scanner.Err(); err != nil {
		s.readErr <- err
		return
	}
	s.readErr <- nil
}

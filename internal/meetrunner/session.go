package meetrunner

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os/exec"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

const maxRPCMessageBytes = 1 << 20
const closeGracePeriod = 250 * time.Millisecond

type SessionConfig struct {
	ID      string
	Dir     string
	Command string
	Timeout time.Duration
}

type Session struct {
	id      string
	timeout time.Duration
	command *exec.Cmd
	stdin   io.WriteCloser
	stderr  *limitedBuffer

	mu        sync.Mutex
	closeOnce sync.Once
	closed    atomic.Bool
	responses chan rpcResponse
	readErr   chan error
	waitDone  chan error
}

type rpcRequest struct {
	JSONRPC string `json:"jsonrpc"`
	ID      string `json:"id"`
	Method  string `json:"method"`
	Params  any    `json:"params,omitempty"`
}

type rpcResponse struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      string          `json:"id"`
	Result  json.RawMessage `json:"result,omitempty"`
	Error   *rpcError       `json:"error,omitempty"`
}

type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

func NewSession(cfg SessionConfig) (*Session, error) {
	commandPath, commandArgs, err := resolveRunnerCommand(cfg.Dir, cfg.Command)
	if err != nil {
		return nil, err
	}
	command := exec.Command(commandPath, commandArgs...)
	command.Dir = cfg.Dir
	prepareCommand(command)

	stdin, err := command.StdinPipe()
	if err != nil {
		return nil, fmt.Errorf("create meet-runner stdin pipe: %w", err)
	}
	stdout, err := command.StdoutPipe()
	if err != nil {
		return nil, fmt.Errorf("create meet-runner stdout pipe: %w", err)
	}
	stderr := newLimitedBuffer(maxRPCMessageBytes)
	command.Stderr = stderr

	if err := command.Start(); err != nil {
		return nil, fmt.Errorf("start meet-runner session %s: %w", cfg.ID, err)
	}

	session := &Session{
		id:        cfg.ID,
		timeout:   cfg.Timeout,
		command:   command,
		stdin:     stdin,
		stderr:    stderr,
		responses: make(chan rpcResponse),
		readErr:   make(chan error, 1),
		waitDone:  make(chan error, 1),
	}
	go session.readLoop(stdout)
	go func() {
		session.waitDone <- command.Wait()
	}()
	return session, nil
}

func (s *Session) Call(ctx context.Context, method string, params any, target any) error {
	return s.CallWithTimeout(ctx, 0, method, params, target)
}

func (s *Session) CallWithTimeout(
	ctx context.Context,
	timeout time.Duration,
	method string,
	params any,
	target any,
) error {
	callTimeout := timeout
	if callTimeout <= 0 {
		callTimeout = s.timeout
	}
	callCtx, cancel := context.WithTimeout(ctx, callTimeout)
	defer cancel()

	payload, err := json.Marshal(rpcRequest{
		JSONRPC: "2.0",
		ID:      "1",
		Method:  method,
		Params:  params,
	})
	if err != nil {
		return fmt.Errorf("marshal %s request: %w", method, err)
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	if s.closed.Load() {
		return fmt.Errorf("meet-runner session %s is closed", s.id)
	}
	if _, err := s.stdin.Write(append(payload, '\n')); err != nil {
		return fmt.Errorf("write meet-runner %s request: %w", method, err)
	}

	select {
	case response := <-s.responses:
		if response.Error != nil {
			return fmt.Errorf("meet-runner %s failed: %s", method, response.Error.Message)
		}
		if target == nil {
			return nil
		}
		if err := json.Unmarshal(response.Result, target); err != nil {
			return fmt.Errorf("decode meet-runner %s result: %w", method, err)
		}
		return nil
	case err := <-s.readErr:
		if err == nil {
			return fmt.Errorf("meet-runner %s closed without response", method)
		}
		return fmt.Errorf("meet-runner %s stream failed: %w (%s)", method, err, strings.TrimSpace(s.stderr.String()))
	case <-callCtx.Done():
		closeErr := s.Close()
		if closeErr != nil {
			return fmt.Errorf("meet-runner %s canceled: %w", method, closeErr)
		}
		if stderr := strings.TrimSpace(s.stderr.String()); stderr != "" {
			return fmt.Errorf("meet-runner %s timed out after %s: %w (%s)", method, callTimeout, callCtx.Err(), stderr)
		}
		return fmt.Errorf("meet-runner %s timed out after %s: %w", method, callTimeout, callCtx.Err())
	}
}

func (s *Session) Close() error {
	var closeErr error
	s.closeOnce.Do(func() {
		s.closed.Store(true)
		if s.stdin != nil {
			_ = s.stdin.Close()
		}
		timer := time.NewTimer(closeGracePeriod)
		defer timer.Stop()

		select {
		case waitErr := <-s.waitDone:
			if closeErr == nil && waitErr != nil {
				closeErr = waitErr
			}
		case <-timer.C:
			if s.command.Process != nil {
				closeErr = terminateCommand(s.command)
			}
			<-s.waitDone
		}
	})
	return closeErr
}

func (s *Session) readLoop(stdout io.Reader) {
	scanner := bufio.NewScanner(stdout)
	scanner.Buffer(make([]byte, 0, 64*1024), maxRPCMessageBytes)
	for scanner.Scan() {
		var response rpcResponse
		if err := json.Unmarshal(scanner.Bytes(), &response); err != nil {
			s.readErr <- fmt.Errorf("decode response: %w", err)
			return
		}
		s.responses <- response
	}
	if err := scanner.Err(); err != nil {
		s.readErr <- err
		return
	}
	s.readErr <- nil
}

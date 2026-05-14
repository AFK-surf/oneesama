package slackagent

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

var errSlackSocketDisconnect = errors.New("slack socket mode disconnect")
var errSlackSocketConnect = errors.New("slack socket mode connect")

type SocketModeRunnerConfig struct {
	Logger         *slog.Logger
	Service        *Service
	AppToken       string
	OpenClient     *SlackSocketModeClient
	Dialer         *websocket.Dialer
	ReconnectDelay time.Duration
}

type SocketModeRunner struct {
	logger         *slog.Logger
	service        *Service
	openClient     *SlackSocketModeClient
	dialer         *websocket.Dialer
	reconnectDelay time.Duration

	runMu   sync.Mutex
	started bool
	cancel  context.CancelFunc
	wg      sync.WaitGroup

	connMu sync.Mutex
	conn   *websocket.Conn

	writeMu sync.Mutex

	stateMu sync.Mutex
	state   SlackSocketModeStatus
}

func NewSocketModeRunner(cfg SocketModeRunnerConfig) *SocketModeRunner {
	logger := cfg.Logger
	if logger == nil {
		logger = slog.Default()
	}
	openClient := cfg.OpenClient
	if openClient == nil {
		openClient = NewSlackSocketModeClient(cfg.AppToken)
	}
	dialer := cfg.Dialer
	if dialer == nil {
		dialer = websocket.DefaultDialer
	}
	reconnectDelay := cfg.ReconnectDelay
	if reconnectDelay <= 0 {
		reconnectDelay = 1500 * time.Millisecond
	}
	return &SocketModeRunner{
		logger:         logger,
		service:        cfg.Service,
		openClient:     openClient,
		dialer:         dialer,
		reconnectDelay: reconnectDelay,
		state: SlackSocketModeStatus{
			Configured: strings.TrimSpace(cfg.AppToken) != "",
		},
	}
}

func (r *SocketModeRunner) Start() error {
	if r == nil || !r.state.Configured {
		return nil
	}

	r.runMu.Lock()
	defer r.runMu.Unlock()
	if r.started {
		return nil
	}

	ctx, cancel := context.WithCancel(context.Background())
	r.cancel = cancel
	r.started = true
	r.wg.Add(1)
	go r.runLoop(ctx)
	return nil
}

func (r *SocketModeRunner) Shutdown(ctx context.Context) error {
	if r == nil {
		return nil
	}

	r.runMu.Lock()
	if !r.started {
		r.runMu.Unlock()
		return nil
	}
	cancel := r.cancel
	r.started = false
	r.cancel = nil
	r.runMu.Unlock()

	if cancel != nil {
		cancel()
	}
	r.closeConn()

	done := make(chan struct{})
	go func() {
		r.wg.Wait()
		close(done)
	}()

	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-done:
		return nil
	}
}

func (r *SocketModeRunner) Snapshot() SlackSocketModeStatus {
	if r == nil {
		return SlackSocketModeStatus{}
	}
	r.stateMu.Lock()
	defer r.stateMu.Unlock()
	return r.state
}

func (r *SocketModeRunner) runLoop(ctx context.Context) {
	defer r.wg.Done()

	connectFailures := 0
	for {
		if ctx.Err() != nil {
			return
		}
		err := r.serveOnce(ctx)
		if err != nil && !errors.Is(err, context.Canceled) {
			r.setLastError(err.Error())
			r.logger.Warn("slack socket mode loop failed", "error", err)
		}
		if ctx.Err() != nil {
			return
		}
		delay := r.reconnectDelay
		if errors.Is(err, errSlackSocketConnect) {
			connectFailures++
			delay = r.reconnectDelayForAttempt(connectFailures)
		} else {
			connectFailures = 0
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(delay):
		}
	}
}

func (r *SocketModeRunner) serveOnce(ctx context.Context) error {
	r.updateState(func(state *SlackSocketModeStatus) {
		state.Connecting = true
		state.Connected = false
	})

	socketURL, err := r.openClient.OpenConnection(ctx)
	if err != nil {
		r.updateState(func(state *SlackSocketModeStatus) {
			state.Connecting = false
		})
		return fmt.Errorf("%w: %w", errSlackSocketConnect, err)
	}

	conn, _, err := r.dialer.DialContext(ctx, socketURL, nil)
	if err != nil {
		r.updateState(func(state *SlackSocketModeStatus) {
			state.Connecting = false
		})
		return fmt.Errorf("%w: dial slack socket mode websocket: %w", errSlackSocketConnect, err)
	}
	if err := r.configureConn(conn); err != nil {
		_ = conn.Close()
		r.updateState(func(state *SlackSocketModeStatus) {
			state.Connecting = false
		})
		return fmt.Errorf("%w: %w", errSlackSocketConnect, err)
	}
	r.setConn(conn)
	defer r.clearConn(conn)
	defer conn.Close()
	serveCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	go r.runPingLoop(serveCtx, conn)

	r.updateState(func(state *SlackSocketModeStatus) {
		state.Connecting = false
		state.Connected = true
		state.LastConnectedAt = time.Now().UTC().Format(time.RFC3339Nano)
		state.LastError = ""
	})

	for {
		_, message, err := conn.ReadMessage()
		if err != nil {
			r.updateState(func(state *SlackSocketModeStatus) {
				state.Connected = false
				state.Connecting = false
				state.LastClosedAt = time.Now().UTC().Format(time.RFC3339Nano)
				state.Reconnects++
			})
			return err
		}
		r.touchReadDeadline(conn)
		if err := r.handleMessage(ctx, conn, message); err != nil {
			if errors.Is(err, errSlackSocketDisconnect) {
				return err
			}
			return fmt.Errorf("handle slack socket mode message: %w", err)
		}
	}
}

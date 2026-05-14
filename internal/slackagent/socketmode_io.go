package slackagent

import (
	"context"
	"fmt"
	"time"

	"github.com/gorilla/websocket"
)

const (
	socketModeReadTimeout       = 45 * time.Second
	socketModeWriteTimeout      = 5 * time.Second
	socketModePingInterval      = 15 * time.Second
	socketModeReconnectMaxDelay = 60 * time.Second
)

func (r *SocketModeRunner) configureConn(conn *websocket.Conn) error {
	conn.SetReadLimit(1 << 20)
	conn.SetPongHandler(func(string) error {
		return r.touchReadDeadline(conn)
	})
	return r.touchReadDeadline(conn)
}

func (r *SocketModeRunner) touchReadDeadline(conn *websocket.Conn) error {
	return conn.SetReadDeadline(time.Now().Add(socketModeReadTimeout))
}

func (r *SocketModeRunner) writeJSON(conn *websocket.Conn, payload any) error {
	r.writeMu.Lock()
	defer r.writeMu.Unlock()
	if err := conn.SetWriteDeadline(time.Now().Add(socketModeWriteTimeout)); err != nil {
		return fmt.Errorf("set slack socket mode write deadline: %w", err)
	}
	if err := conn.WriteJSON(payload); err != nil {
		return err
	}
	return conn.SetWriteDeadline(time.Time{})
}

func (r *SocketModeRunner) writeControl(conn *websocket.Conn, messageType int, data []byte) error {
	r.writeMu.Lock()
	defer r.writeMu.Unlock()
	return conn.WriteControl(messageType, data, time.Now().Add(socketModeWriteTimeout))
}

func (r *SocketModeRunner) runPingLoop(ctx context.Context, conn *websocket.Conn) {
	ticker := time.NewTicker(socketModePingInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if err := r.writeControl(conn, websocket.PingMessage, []byte("ping")); err != nil {
				r.setLastError("slack socket mode ping failed: " + err.Error())
				r.closeConn()
				return
			}
		}
	}
}

func (r *SocketModeRunner) reconnectDelayForAttempt(attempt int) time.Duration {
	if attempt <= 1 {
		return r.reconnectDelay
	}
	delay := r.reconnectDelay
	for step := 1; step < attempt; step++ {
		delay *= 2
		if delay >= socketModeReconnectMaxDelay {
			return socketModeReconnectMaxDelay
		}
	}
	return delay
}

package slackagent

import "github.com/gorilla/websocket"

func (r *SocketModeRunner) updateState(apply func(*SlackSocketModeStatus)) {
	if r == nil || apply == nil {
		return
	}
	r.stateMu.Lock()
	defer r.stateMu.Unlock()
	apply(&r.state)
}

func (r *SocketModeRunner) setLastError(message string) {
	r.updateState(func(state *SlackSocketModeStatus) {
		state.LastError = message
	})
}

func (r *SocketModeRunner) setConn(conn *websocket.Conn) {
	r.connMu.Lock()
	defer r.connMu.Unlock()
	r.conn = conn
}

func (r *SocketModeRunner) clearConn(conn *websocket.Conn) {
	r.connMu.Lock()
	defer r.connMu.Unlock()
	if r.conn == conn {
		r.conn = nil
	}
}

func (r *SocketModeRunner) closeConn() {
	r.connMu.Lock()
	defer r.connMu.Unlock()
	if r.conn != nil {
		_ = r.conn.Close()
		r.conn = nil
	}
}

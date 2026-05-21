package meetingagent

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
)

type DemoWorkspaceStatus string

const (
	DemoWorkspaceStatusRunning DemoWorkspaceStatus = "running"
	DemoWorkspaceStatusStopped DemoWorkspaceStatus = "stopped"
	DemoWorkspaceStatusFailed  DemoWorkspaceStatus = "failed"
)

const (
	demoWorkspaceProfileDirName   = "profile"
	demoWorkspaceFramesDirName    = "frames"
	demoWorkspaceDownloadsDirName = "downloads"
)

var safeDemoWorkspaceSessionID = regexp.MustCompile(`^[A-Za-z0-9_-]+$`)

var (
	errDemoWorkspaceActive          = errors.New("demo_workspace_active")
	errDemoWorkspaceMissingRoot     = errors.New("demo_workspace_root_required")
	errDemoWorkspaceMissingLauncher = errors.New("demo_workspace_launcher_required")
	errDemoWorkspaceNoActiveSession = errors.New("demo_workspace_no_active_session")
)

type DemoWorkspaceStartRequest struct {
	SessionID string
	URL       string
	Now       time.Time
}

type DemoWorkspaceLaunchSpec struct {
	SessionID    string
	URL          string
	RuntimeDir   string
	ProfileDir   string
	FramesDir    string
	DownloadsDir string
}

type DemoWorkspaceProcess interface {
	PID() int
	Stop(ctx context.Context) error
}

type DemoWorkspaceLauncher interface {
	LaunchDemoWorkspace(ctx context.Context, spec DemoWorkspaceLaunchSpec) (DemoWorkspaceProcess, error)
}

type DemoWorkspaceSession struct {
	ID           string              `json:"id"`
	URL          string              `json:"url,omitempty"`
	Status       DemoWorkspaceStatus `json:"status"`
	RuntimeDir   string              `json:"runtime_dir"`
	ProfileDir   string              `json:"profile_dir"`
	FramesDir    string              `json:"frames_dir"`
	DownloadsDir string              `json:"downloads_dir"`
	ProcessID    int                 `json:"process_id,omitempty"`
	StartedAt    time.Time           `json:"started_at"`
	StoppedAt    time.Time           `json:"stopped_at,omitempty"`
	Failure      string              `json:"failure,omitempty"`
}

type DemoWorkspaceLifecycle struct {
	rootDir  string
	launcher DemoWorkspaceLauncher
	now      func() time.Time

	mu      sync.Mutex
	active  *demoWorkspaceActiveSession
	history map[string]DemoWorkspaceSession
}

type demoWorkspaceActiveSession struct {
	session DemoWorkspaceSession
	process DemoWorkspaceProcess
}

func NewDemoWorkspaceLifecycle(rootDir string, launcher DemoWorkspaceLauncher) *DemoWorkspaceLifecycle {
	return &DemoWorkspaceLifecycle{
		rootDir:  strings.TrimSpace(rootDir),
		launcher: launcher,
		now:      time.Now,
		history:  map[string]DemoWorkspaceSession{},
	}
}

func (l *DemoWorkspaceLifecycle) Start(ctx context.Context, req DemoWorkspaceStartRequest) (DemoWorkspaceSession, error) {
	l.mu.Lock()
	defer l.mu.Unlock()

	if strings.TrimSpace(l.rootDir) == "" {
		return DemoWorkspaceSession{}, errDemoWorkspaceMissingRoot
	}
	if l.launcher == nil {
		return DemoWorkspaceSession{}, errDemoWorkspaceMissingLauncher
	}
	if l.active != nil && l.active.session.Status == DemoWorkspaceStatusRunning {
		return l.active.session, errDemoWorkspaceActive
	}

	now := req.Now
	if now.IsZero() {
		now = l.now()
	}
	sessionID, err := normalizeDemoWorkspaceSessionID(req.SessionID)
	if err != nil {
		return DemoWorkspaceSession{}, err
	}
	runtimeDir := filepath.Join(l.rootDir, sessionID)
	session := DemoWorkspaceSession{
		ID:           sessionID,
		URL:          strings.TrimSpace(req.URL),
		Status:       DemoWorkspaceStatusRunning,
		RuntimeDir:   runtimeDir,
		ProfileDir:   filepath.Join(runtimeDir, demoWorkspaceProfileDirName),
		FramesDir:    filepath.Join(runtimeDir, demoWorkspaceFramesDirName),
		DownloadsDir: filepath.Join(runtimeDir, demoWorkspaceDownloadsDirName),
		StartedAt:    now,
	}
	if err := os.MkdirAll(session.ProfileDir, 0o700); err != nil {
		return DemoWorkspaceSession{}, fmt.Errorf("create demo profile dir: %w", err)
	}
	for _, dir := range []string{session.FramesDir, session.DownloadsDir} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			_ = os.RemoveAll(runtimeDir)
			return DemoWorkspaceSession{}, fmt.Errorf("create demo workspace dir: %w", err)
		}
	}

	process, err := l.launcher.LaunchDemoWorkspace(ctx, DemoWorkspaceLaunchSpec{
		SessionID:    session.ID,
		URL:          session.URL,
		RuntimeDir:   session.RuntimeDir,
		ProfileDir:   session.ProfileDir,
		FramesDir:    session.FramesDir,
		DownloadsDir: session.DownloadsDir,
	})
	if err != nil {
		session.Status = DemoWorkspaceStatusFailed
		session.Failure = err.Error()
		l.history[session.ID] = session
		_ = os.RemoveAll(runtimeDir)
		return session, err
	}
	if process != nil {
		session.ProcessID = process.PID()
	}
	l.active = &demoWorkspaceActiveSession{session: session, process: process}
	l.history[session.ID] = session
	return session, nil
}

func (l *DemoWorkspaceLifecycle) Stop(ctx context.Context, sessionID string) (DemoWorkspaceSession, error) {
	l.mu.Lock()
	defer l.mu.Unlock()

	if l.active == nil {
		return DemoWorkspaceSession{}, errDemoWorkspaceNoActiveSession
	}
	if strings.TrimSpace(sessionID) != "" && sessionID != l.active.session.ID {
		return l.active.session, errDemoWorkspaceNoActiveSession
	}

	active := l.active
	session := active.session
	if active.process != nil {
		if err := active.process.Stop(ctx); err != nil {
			session.Status = DemoWorkspaceStatusFailed
			session.Failure = err.Error()
			l.active.session = session
			l.history[session.ID] = session
			return session, err
		}
	}
	session.Status = DemoWorkspaceStatusStopped
	session.StoppedAt = l.now()
	l.history[session.ID] = session
	l.active = nil
	_ = os.RemoveAll(session.RuntimeDir)
	return session, nil
}

func (l *DemoWorkspaceLifecycle) ActiveSession() (DemoWorkspaceSession, bool) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.active == nil {
		return DemoWorkspaceSession{}, false
	}
	return l.active.session, true
}

func (l *DemoWorkspaceLifecycle) Session(sessionID string) (DemoWorkspaceSession, bool) {
	l.mu.Lock()
	defer l.mu.Unlock()
	session, ok := l.history[strings.TrimSpace(sessionID)]
	return session, ok
}

func (l *DemoWorkspaceLifecycle) CleanupStale(now time.Time, maxAge time.Duration) ([]string, error) {
	l.mu.Lock()
	defer l.mu.Unlock()

	if strings.TrimSpace(l.rootDir) == "" {
		return nil, errDemoWorkspaceMissingRoot
	}
	if now.IsZero() {
		now = l.now()
	}
	if maxAge <= 0 {
		maxAge = time.Hour
	}

	entries, err := os.ReadDir(l.rootDir)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, nil
		}
		return nil, err
	}

	activeID := ""
	if l.active != nil {
		activeID = l.active.session.ID
	}
	var removed []string
	for _, entry := range entries {
		if !entry.IsDir() || entry.Name() == activeID {
			continue
		}
		info, err := entry.Info()
		if err != nil {
			continue
		}
		if now.Sub(info.ModTime()) < maxAge {
			continue
		}
		sessionDir := filepath.Join(l.rootDir, entry.Name())
		if err := os.RemoveAll(sessionDir); err != nil {
			return removed, err
		}
		removed = append(removed, entry.Name())
	}
	return removed, nil
}

func normalizeDemoWorkspaceSessionID(sessionID string) (string, error) {
	sessionID = strings.TrimSpace(sessionID)
	if sessionID == "" {
		return "demo_" + strings.ReplaceAll(uuid.NewString(), "-", ""), nil
	}
	if !safeDemoWorkspaceSessionID.MatchString(sessionID) {
		return "", fmt.Errorf("invalid_demo_workspace_session_id")
	}
	return sessionID, nil
}

package meetingagent

import (
	"context"
	"os"
	"strings"

	appconfig "github.com/AFK-surf/oneesama/pkg/config"
)

const (
	demoSurfaceAdapterFake         = "fake"
	demoSurfaceAdapterCodex        = "codex"
	demoSurfaceAdapterAgentBrowser = "agent_browser"
)

func (s *Service) newRealtimeDemoBridgeFromConfig() *RealtimeDemoBridge {
	cfg := s.demoSurface
	if !cfg.Enabled {
		return nil
	}
	var client DemoKWWKClient
	switch normalizeDemoSurfaceAdapter(cfg.Adapter) {
	case demoSurfaceAdapterFake:
		client = NewFakeDemoKWWKClient()
	case demoSurfaceAdapterCodex:
		if s.runner == nil || s.runnerErr != nil {
			s.logger.Warn("demo surface codex adapter disabled because agent runner is unavailable", "error", s.runnerErr)
			return nil
		}
		client = NewDemoCodexBrowserClient(s.runner)
	case demoSurfaceAdapterAgentBrowser:
		client = NewDemoAgentBrowserClient()
	default:
		s.logger.Warn("demo surface adapter disabled because adapter is unsupported", "adapter", cfg.Adapter)
		return nil
	}
	lifecycle := NewDemoWorkspaceLifecycle(cfg.RootDir, demoWorkspaceNoopLauncher{})
	store := NewPersistentDemoSessionStore(demoFeedbackRootDir(cfg.RootDir))
	return &RealtimeDemoBridge{
		Mode:      strings.TrimSpace(cfg.Mode),
		Lifecycle: lifecycle,
		Controller: DemoController{
			Client: client,
			Safety: DemoSafetyPolicy{
				URLAllowlistPatterns: cfg.URLAllowlistPatterns,
				DryRun:               cfg.DryRun,
				AllowActiveControl:   cfg.AllowActiveControl,
			},
		},
		Presenter:    DemoSurfacePresenter{Share: s},
		Store:        store,
		Observations: NewDemoObservationBus(),
	}
}

func (s *Service) demoSurfaceStatus() map[string]any {
	enabled := s.demoBridge != nil
	toolsExposed := s.realtimeDemoSurfaceToolsExposed()
	status := map[string]any{
		"mode":                          strings.TrimSpace(s.demoSurface.Mode),
		"enabled":                       enabled,
		"toolsExposed":                  toolsExposed,
		"configured":                    s.demoSurface.Enabled,
		"exposeRealtimeTools":           s.demoSurface.ExposeRealtimeTools,
		"adapter":                       strings.TrimSpace(s.demoSurface.Adapter),
		"rootDir":                       strings.TrimSpace(s.demoSurface.RootDir),
		"dryRun":                        s.demoSurface.DryRun,
		"allowActiveControl":            s.demoSurface.AllowActiveControl,
		"requireExternalWriteApproval":  s.demoSurface.RequireExternalWriteApproval,
		"externalWriteApprovalTokenTTL": s.demoSurface.ExternalWriteApprovalTokenTTL.String(),
	}
	if s.demoBridge == nil && s.demoSurface.Enabled {
		status["reason"] = "demo_surface_bridge_unavailable"
	}
	if s.demoBridge != nil && s.demoBridge.Store != nil {
		status["activeSessions"] = s.demoBridge.Store.ActiveSessionIDs()
		status["recentSessions"] = s.demoBridge.Store.RecentSnapshots(5)
	}
	return status
}

type demoWorkspaceNoopLauncher struct{}

func (demoWorkspaceNoopLauncher) LaunchDemoWorkspace(context.Context, DemoWorkspaceLaunchSpec) (DemoWorkspaceProcess, error) {
	return demoWorkspaceNoopProcess{pid: os.Getpid()}, nil
}

type demoWorkspaceNoopProcess struct {
	pid int
}

func (p demoWorkspaceNoopProcess) PID() int {
	return p.pid
}

func (demoWorkspaceNoopProcess) Stop(context.Context) error {
	return nil
}

func normalizeDemoSurfaceConfig(cfg appconfig.DemoSurfaceConfig) appconfig.DemoSurfaceConfig {
	if strings.TrimSpace(cfg.Mode) == "" {
		if cfg.Enabled {
			if cfg.AllowActiveControl {
				cfg.Mode = "active"
			} else {
				cfg.Mode = "safe"
			}
		} else {
			cfg.Mode = "off"
		}
	}
	if strings.TrimSpace(cfg.Adapter) == "" {
		cfg.Adapter = demoSurfaceAdapterFake
	}
	if strings.TrimSpace(cfg.RootDir) == "" {
		cfg.RootDir = "./runtime/demo-surfaces"
	}
	return cfg
}

func normalizeDemoSurfaceAdapter(value string) string {
	normalized := strings.ToLower(strings.TrimSpace(value))
	normalized = strings.NewReplacer("-", "_", " ", "_").Replace(normalized)
	switch normalized {
	case "agentbrowser", "browser", "browser_use":
		return demoSurfaceAdapterAgentBrowser
	default:
		return normalized
	}
}

func demoFeedbackRootDir(rootDir string) string {
	rootDir = strings.TrimSpace(rootDir)
	if rootDir == "" {
		rootDir = "./runtime/demo-surfaces"
	}
	return rootDir + "/feedback"
}

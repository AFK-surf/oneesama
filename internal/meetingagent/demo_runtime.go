package meetingagent

import (
	"context"
	"os"
	"strings"

	appconfig "github.com/AFK-surf/oneesama/pkg/config"
)

const demoSurfaceAdapterFake = "fake"

func (s *Service) newRealtimeDemoBridgeFromConfig() *RealtimeDemoBridge {
	cfg := s.demoSurface
	if !cfg.Enabled {
		return nil
	}
	if strings.TrimSpace(cfg.Adapter) != demoSurfaceAdapterFake {
		s.logger.Warn("demo surface adapter disabled because adapter is unsupported", "adapter", cfg.Adapter)
		return nil
	}
	lifecycle := NewDemoWorkspaceLifecycle(cfg.RootDir, demoWorkspaceNoopLauncher{})
	client := NewFakeDemoKWWKClient()
	return &RealtimeDemoBridge{
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
		Store:        NewDemoSessionStore(),
		Observations: NewDemoObservationBus(),
	}
}

func (s *Service) demoSurfaceStatus() map[string]any {
	enabled := s.demoBridge != nil
	status := map[string]any{
		"enabled":            enabled,
		"toolsExposed":       enabled,
		"configured":         s.demoSurface.Enabled,
		"adapter":            strings.TrimSpace(s.demoSurface.Adapter),
		"rootDir":            strings.TrimSpace(s.demoSurface.RootDir),
		"dryRun":             s.demoSurface.DryRun,
		"allowActiveControl": s.demoSurface.AllowActiveControl,
	}
	if s.demoBridge == nil && s.demoSurface.Enabled {
		status["reason"] = "demo_surface_bridge_unavailable"
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
	if strings.TrimSpace(cfg.Adapter) == "" {
		cfg.Adapter = demoSurfaceAdapterFake
	}
	if strings.TrimSpace(cfg.RootDir) == "" {
		cfg.RootDir = "./runtime/demo-surfaces"
	}
	return cfg
}

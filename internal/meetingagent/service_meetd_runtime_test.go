package meetingagent

import (
	"context"
	"io"
	"log/slog"
	"sync"
	"testing"
	"time"

	"github.com/AFK-surf/oneesama/internal/postmeeting"
	appconfig "github.com/AFK-surf/oneesama/pkg/config"
)

func newMeetdRuntimeLifecycleTestService(t *testing.T) *Service {
	t.Helper()
	return NewService(Config{
		Logger:             slog.New(slog.NewTextHandler(io.Discard, nil)),
		Persistence:        appconfig.PersistenceConfig{Provider: "memory"},
		ArtifactsRootDir:   t.TempDir(),
		Pipeline:           postmeeting.NewPipeline(t.TempDir()),
		MeetdWatchInterval: time.Hour,
	})
}

func TestMeetdRuntimeLifecycleIsIdempotentAndRestartable(t *testing.T) {
	service := newMeetdRuntimeLifecycleTestService(t)
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()

	service.StartMeetdRuntime(context.Background())
	firstDone := service.meetdRuntimeDone
	if firstDone == nil {
		t.Fatal("StartMeetdRuntime did not create a runtime")
	}

	service.StartMeetdRuntime(context.Background())
	if service.meetdRuntimeDone != firstDone {
		t.Fatal("StartMeetdRuntime replaced an already running runtime")
	}

	if err := service.StopMeetdRuntime(ctx); err != nil {
		t.Fatalf("StopMeetdRuntime: %v", err)
	}
	if service.meetdRuntimeDone != nil || service.meetdRuntimeCancel != nil {
		t.Fatalf("runtime state after stop = done:%v cancel:%v, want cleared", service.meetdRuntimeDone, service.meetdRuntimeCancel)
	}

	service.StartMeetdRuntime(context.Background())
	secondDone := service.meetdRuntimeDone
	if secondDone == nil {
		t.Fatal("restart did not create a runtime")
	}
	if secondDone == firstDone {
		t.Fatal("restart reused the stopped runtime channel")
	}
	if err := service.StopMeetdRuntime(ctx); err != nil {
		t.Fatalf("second StopMeetdRuntime: %v", err)
	}
}

func TestMeetdRuntimeConcurrentStartCreatesOneRuntime(t *testing.T) {
	service := newMeetdRuntimeLifecycleTestService(t)

	var wg sync.WaitGroup
	for i := 0; i < 16; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			service.StartMeetdRuntime(context.Background())
		}()
	}
	wg.Wait()

	service.meetdRuntimeMu.Lock()
	done := service.meetdRuntimeDone
	cancel := service.meetdRuntimeCancel
	service.meetdRuntimeMu.Unlock()
	if done == nil || cancel == nil {
		t.Fatalf("runtime state = done:%v cancel:%v, want one running runtime", done, cancel)
	}

	ctx, stopCancel := context.WithTimeout(context.Background(), time.Second)
	defer stopCancel()
	if err := service.StopMeetdRuntime(ctx); err != nil {
		t.Fatalf("StopMeetdRuntime: %v", err)
	}
}

//go:build unix

package processutil

import (
	"errors"
	"os/exec"
	"syscall"
	"testing"
	"time"
)

func TestPrepareGroupSetsSetpgid(t *testing.T) {
	cmd := exec.Command("sleep", "60")
	PrepareGroup(cmd)
	if cmd.SysProcAttr == nil {
		t.Fatalf("expected SysProcAttr to be populated")
	}
	if !cmd.SysProcAttr.Setpgid {
		t.Fatalf("expected Setpgid=true so process group can be signalled")
	}
}

func TestPrepareGroupPreservesExistingSysProcAttr(t *testing.T) {
	cmd := exec.Command("sleep", "60")
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	PrepareGroup(cmd)
	if !cmd.SysProcAttr.Setsid {
		t.Fatalf("existing Setsid must be preserved")
	}
	if !cmd.SysProcAttr.Setpgid {
		t.Fatalf("Setpgid must be applied")
	}
}

func TestPrepareGroupHandlesNilCommand(t *testing.T) {
	// Should not panic
	PrepareGroup(nil)
}

func TestKillGroupSendsSIGKILLToProcessGroup(t *testing.T) {
	cmd := exec.Command("sleep", "60")
	PrepareGroup(cmd)
	if err := cmd.Start(); err != nil {
		t.Fatalf("start sleep: %v", err)
	}
	t.Cleanup(func() {
		_ = cmd.Process.Kill()
	})
	if err := KillGroup("test-process", cmd); err != nil {
		t.Fatalf("KillGroup: %v", err)
	}
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	select {
	case err := <-done:
		if err == nil {
			t.Fatalf("expected wait to return non-nil error after kill")
		}
		var exitErr *exec.ExitError
		if !errors.As(err, &exitErr) {
			t.Fatalf("expected ExitError after kill, got %T %v", err, err)
		}
	case <-time.After(5 * time.Second):
		t.Fatalf("process did not exit within 5s after KillGroup")
	}
}

func TestKillGroupOnAlreadyExitedProcessReturnsNoError(t *testing.T) {
	cmd := exec.Command("true")
	PrepareGroup(cmd)
	if err := cmd.Start(); err != nil {
		t.Fatalf("start true: %v", err)
	}
	if err := cmd.Wait(); err != nil {
		t.Fatalf("wait true: %v", err)
	}
	// Process is already gone; KillGroup should swallow ESRCH.
	if err := KillGroup("test-process", cmd); err != nil {
		t.Fatalf("KillGroup on already-exited process returned error: %v", err)
	}
}

func TestKillGroupHandlesNilCommandAndNilProcess(t *testing.T) {
	if err := KillGroup("nil-command", nil); err != nil {
		t.Fatalf("KillGroup(nil) = %v, want nil", err)
	}
	cmd := exec.Command("true")
	if err := KillGroup("nil-process", cmd); err != nil {
		t.Fatalf("KillGroup(unstarted) = %v, want nil", err)
	}
}

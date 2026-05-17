//go:build !unix

package processutil

import "os/exec"

// PrepareGroup is a no-op on non-unix platforms because the SysProcAttr
// fields needed for pgroup signaling are unix-specific.
func PrepareGroup(command *exec.Cmd) {}

// KillGroup falls back to a single Process.Kill on non-unix builds. The
// label parameter is preserved across platforms so callers can pass the
// same value without build tags.
func KillGroup(label string, command *exec.Cmd) error {
	if command == nil || command.Process == nil {
		return nil
	}
	return command.Process.Kill()
}

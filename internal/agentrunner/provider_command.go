package agentrunner

import (
	"context"
	"fmt"
	"os/exec"
	"strings"
)

type commandProvider struct {
	provider      string
	bin           string
	dryRun        bool
	argsBuilder   func(StartInput) []string
	promptBuilder func(StartInput) string
	stdinPrompt   bool
}

func (p commandProvider) Provider() string {
	return p.provider
}

func (p commandProvider) DryRun() bool {
	return p.dryRun
}

func (p commandProvider) Run(ctx context.Context, input StartInput) (RunResult, error) {
	if p.dryRun {
		return RunResult{
			Status: StatusCompleted,
			Result: dryRunResult(p.provider),
		}, nil
	}
	if strings.TrimSpace(p.bin) == "" {
		return RunResult{}, fmt.Errorf("%s binary is not configured", p.provider)
	}

	command := exec.CommandContext(ctx, p.bin, p.argsBuilder(input)...)
	prepareCommand(command)
	stdout := newLimitedBuffer(maxCommandOutputBytes)
	stderr := newLimitedBuffer(maxCommandOutputBytes)
	command.Stdout = stdout
	command.Stderr = stderr
	if p.stdinPrompt {
		command.Stdin = strings.NewReader(p.promptBuilder(input))
	}

	if err := runCommand(ctx, command); err != nil {
		return RunResult{
			Status: classifyContextStatus(ctx),
			Result: strings.TrimSpace(stdout.String()),
			Error:  commandErrorText(ctx, stderr.String(), err),
			Debug:  strings.TrimSpace(stderr.String()),
		}, fmt.Errorf("%s command failed: %w", p.provider, err)
	}

	return RunResult{
		Status: StatusCompleted,
		Result: strings.TrimSpace(stdout.String()),
		Debug:  strings.TrimSpace(stderr.String()),
	}, nil
}

func runCommand(ctx context.Context, command *exec.Cmd) error {
	if err := command.Start(); err != nil {
		return err
	}

	done := make(chan error, 1)
	go func() {
		done <- command.Wait()
	}()

	select {
	case err := <-done:
		return err
	case <-ctx.Done():
		if err := terminateCommand(command); err != nil {
			return fmt.Errorf("terminate command: %w", err)
		}
		return <-done
	}
}

func classifyContextStatus(ctx context.Context) JobStatus {
	switch ctx.Err() {
	case context.DeadlineExceeded:
		return StatusTimeout
	case context.Canceled:
		return StatusFailed
	default:
		return StatusFailed
	}
}

func commandErrorText(ctx context.Context, stderr string, err error) string {
	if ctx.Err() == context.DeadlineExceeded {
		return "job timed out"
	}
	if ctx.Err() == context.Canceled {
		return "job canceled"
	}
	if trimmed := strings.TrimSpace(stderr); trimmed != "" {
		return trimmed
	}
	return err.Error()
}

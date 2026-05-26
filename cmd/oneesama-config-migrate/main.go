// Command oneesama-config-migrate converts a cueboard-era YAML config into
// the JSON shape that the oneesama-go-rewrite loader expects.
//
// Why this exists:
//
// Cueboard's runtime config was YAML with strict unknown-field rejection.
// oneesama-go-rewrite reads JSON only (via pkg/config.Load). Users
// upgrading from cueboard still have a YAML config on disk and would
// otherwise see a bare `parse config: invalid character '-'` error from
// the JSON decoder. This binary is the one-shot escape hatch: convert
// the YAML once, point ONEESAMA_CONFIG_PATH at the resulting JSON file,
// and continue.
//
// What it does:
//   - Reads YAML from --input (default: stdin).
//   - Decodes it into the same `rawConfig` schema the loader uses,
//     including `DisallowUnknownFields` on the JSON re-encode pass so
//     the same strictness the runtime enforces is enforced here too.
//     If the YAML has keys the runtime doesn't recognize, this fails
//     loudly with the offending field name.
//   - Emits indented JSON to --output (default: stdout).
//
// What it does NOT do:
//   - It does not move or back up the original YAML file.
//   - It does not migrate ad-hoc keys the loader never supported. If
//     cueboard accepted a key that oneesama-go-rewrite intentionally
//     dropped (e.g. agent-framework filesystem paths), the migration
//     will error so the user explicitly removes the dead field.
//   - It does not validate semantics (timeouts > 0, etc.). The real
//     loader still does that on next startup.
package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/AFK-surf/oneesama/pkg/config"
	"github.com/goccy/go-yaml"
)

func main() {
	os.Exit(run(os.Args[1:], os.Stdin, os.Stdout, os.Stderr))
}

func run(args []string, stdin io.Reader, stdout io.Writer, stderr io.Writer) int {
	fs := flag.NewFlagSet("oneesama-config-migrate", flag.ContinueOnError)
	fs.SetOutput(stderr)
	var (
		inputPath  string
		outputPath string
		quiet      bool
	)
	fs.StringVar(&inputPath, "input", "", "Path to YAML config to migrate. Use '-' or omit for stdin.")
	fs.StringVar(&outputPath, "output", "", "Path to write JSON output. Use '-' or omit for stdout.")
	fs.BoolVar(&quiet, "quiet", false, "Suppress informational stderr output (errors still print).")
	fs.Usage = func() {
		_, _ = fmt.Fprintf(stderr, "Usage: oneesama-config-migrate [--input PATH] [--output PATH] [--quiet]\n")
		_, _ = fmt.Fprintf(stderr, "\nReads a cueboard-era YAML config and emits oneesama-compatible JSON.\n")
		_, _ = fmt.Fprintf(stderr, "Unknown fields fail loudly so dead config keys are caught at migration time.\n\n")
		fs.PrintDefaults()
	}
	if err := fs.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return 0
		}
		return 2
	}

	yamlBytes, source, err := readInput(inputPath, stdin)
	if err != nil {
		_, _ = fmt.Fprintf(stderr, "oneesama-config-migrate: read input: %v\n", err)
		return 1
	}
	if len(bytes.TrimSpace(yamlBytes)) == 0 {
		_, _ = fmt.Fprintf(stderr, "oneesama-config-migrate: input is empty (source=%s)\n", source)
		return 1
	}

	jsonBytes, err := convertYAMLToJSON(yamlBytes)
	if err != nil {
		_, _ = fmt.Fprintf(stderr, "oneesama-config-migrate: %v\n", err)
		return 1
	}

	dest, closeFn, err := openOutput(outputPath, stdout)
	if err != nil {
		_, _ = fmt.Fprintf(stderr, "oneesama-config-migrate: open output: %v\n", err)
		return 1
	}
	defer closeFn()

	if _, err := dest.Write(jsonBytes); err != nil {
		_, _ = fmt.Fprintf(stderr, "oneesama-config-migrate: write output: %v\n", err)
		return 1
	}
	if !bytes.HasSuffix(jsonBytes, []byte("\n")) {
		if _, err := dest.Write([]byte("\n")); err != nil {
			_, _ = fmt.Fprintf(stderr, "oneesama-config-migrate: write trailing newline: %v\n", err)
			return 1
		}
	}

	if !quiet {
		_, _ = fmt.Fprintf(stderr, "oneesama-config-migrate: migrated %s → %s (%d bytes)\n",
			source, describeOutput(outputPath), len(jsonBytes),
		)
	}
	return 0
}

// convertYAMLToJSON is the migration core. Split from `run` so tests can
// exercise the conversion + strict-policy contract without touching the
// filesystem or stderr.
func convertYAMLToJSON(yamlBytes []byte) ([]byte, error) {
	// Stage 1: YAML → generic map. We use the generic shape so the
	// migration tool is forward-compatible with future rawConfig fields
	// the loader adds — it doesn't have to be rebuilt every time a new
	// JSON key is introduced. The strictness check happens in stage 2.
	var generic any
	if err := yaml.Unmarshal(yamlBytes, &generic); err != nil {
		return nil, fmt.Errorf("parse YAML: %w", err)
	}

	// Stage 2: marshal to JSON, then re-decode with DisallowUnknownFields
	// into the runtime's rawConfig schema. Any cueboard-era key that
	// oneesama-go-rewrite no longer recognizes triggers a loud error
	// pinpointing the offending field.
	intermediate, err := json.Marshal(generic)
	if err != nil {
		return nil, fmt.Errorf("re-encode YAML as JSON: %w", err)
	}
	if err := validateAgainstRawConfig(intermediate); err != nil {
		return nil, err
	}

	// Stage 3: pretty-print final JSON so the migrated file is human
	// reviewable before it is checked in / placed on disk.
	var indented bytes.Buffer
	if err := json.Indent(&indented, intermediate, "", "  "); err != nil {
		return nil, fmt.Errorf("indent JSON: %w", err)
	}
	return indented.Bytes(), nil
}

// validateAgainstRawConfig is the strict-policy check. It mirrors the
// runtime loader's DisallowUnknownFields contract. Using the loader's
// rawConfig shape directly (via an internal helper) would tightly couple
// this binary to the pkg/config package; instead we expose a thin
// re-decoder that imports it.
func validateAgainstRawConfig(jsonBytes []byte) error {
	if err := config.DecodeStrict(jsonBytes); err != nil {
		// json.Decoder.Decode surfaces unknown-field errors as
		// "json: unknown field \"foo\"". Surface that verbatim
		// because it already names the dead key precisely.
		return fmt.Errorf("config is incompatible with oneesama-go-rewrite schema: %w", err)
	}
	return nil
}

func readInput(path string, stdin io.Reader) ([]byte, string, error) {
	if path == "" || path == "-" {
		data, err := io.ReadAll(stdin)
		return data, "stdin", err
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, path, err
	}
	return data, path, nil
}

func openOutput(path string, stdout io.Writer) (io.Writer, func(), error) {
	if path == "" || path == "-" {
		return stdout, func() {}, nil
	}
	f, err := os.Create(path)
	if err != nil {
		return nil, nil, err
	}
	return f, func() { _ = f.Close() }, nil
}

func describeOutput(path string) string {
	if strings.TrimSpace(path) == "" || path == "-" {
		return "stdout"
	}
	return path
}

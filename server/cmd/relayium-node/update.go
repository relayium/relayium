package main

import (
	"errors"
	"flag"
	"io"
)

// updateRepo is the GitHub repo node updates are pulled from. Same repo as the
// CLI; the node ships in its own archive (see .goreleaser.yaml).
const updateRepo = "relayium/relayium"

// defaultBinPath is where install-node.sh puts the binary.
const defaultBinPath = "/usr/local/bin/relayium-node"

type updateConfig struct {
	StateDir       string
	BinPath        string
	TargetTag      string
	AllowDowngrade bool
	Repo           string
}

// parseUpdateFlags parses `relayium-node update` arguments. The target version
// is always explicit: this command never resolves "latest" on its own, because
// a rollout that raced a new release would leave the fleet on two versions.
func parseUpdateFlags(args []string, stderr io.Writer) (updateConfig, error) {
	fs := flag.NewFlagSet("update", flag.ContinueOnError)
	fs.SetOutput(stderr)
	uc := updateConfig{Repo: updateRepo}
	fs.StringVar(&uc.StateDir, "state-dir", env("RELAYIUM_NODE_STATE_DIR", "/var/lib/relayium-node"), "directory holding state.json")
	fs.StringVar(&uc.BinPath, "bin", env("RELAYIUM_NODE_BIN", defaultBinPath), "path of the binary to replace")
	fs.StringVar(&uc.TargetTag, "to", "", "exact release tag to install, e.g. v0.9.0 (required)")
	fs.BoolVar(&uc.AllowDowngrade, "allow-downgrade", false, "permit installing a version older than the running one")
	if err := fs.Parse(args); err != nil {
		return uc, err
	}
	if uc.TargetTag == "" {
		return uc, errors.New("relayium-node update: -to <version> is required")
	}
	return uc, nil
}

// runUpdate is the entry point for the update subcommand. Implemented across
// tasks 6-8; this task only wires the command up.
func runUpdate(uc updateConfig, stdout, stderr io.Writer) int {
	return 0
}

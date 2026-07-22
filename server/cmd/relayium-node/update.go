package main

import (
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
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

// backupPath is where the pre-update binary is kept so a broken new version can
// be undone locally. It lives next to the binary, owned by root and outside the
// node sandbox's writable paths — a compromised node cannot touch it.
func backupPath(binPath string) string { return binPath + ".prev" }

// backupBinary copies the current binary aside, preserving its mode. This is
// the precondition for the local self-rescue in task 7: central cannot roll
// back a node that never comes up, because such a node never asks central
// anything.
func backupBinary(binPath string) error {
	src, err := os.Open(binPath)
	if err != nil {
		return err
	}
	defer src.Close()
	fi, err := src.Stat()
	if err != nil {
		return err
	}
	tmp := backupPath(binPath) + ".tmp"
	dst, err := os.OpenFile(tmp, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, fi.Mode().Perm())
	if err != nil {
		return err
	}
	if _, err := io.Copy(dst, src); err != nil {
		dst.Close()
		os.Remove(tmp)
		return err
	}
	if err := dst.Close(); err != nil {
		os.Remove(tmp)
		return err
	}
	// Rename last so a crash mid-copy never leaves a truncated "backup" that
	// would be restored over a working binary.
	return os.Rename(tmp, backupPath(binPath))
}

// restoreBinary puts the backed-up binary back. Rename is atomic, so a crash
// here leaves either the new or the old binary in place — never a partial one.
func restoreBinary(binPath string) error {
	prev := backupPath(binPath)
	if _, err := os.Stat(prev); err != nil {
		return fmt.Errorf("no backup to restore at %s: %w", prev, err)
	}
	return os.Rename(prev, binPath)
}

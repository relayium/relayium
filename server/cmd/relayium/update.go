package main

import (
	"context"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"

	"github.com/relayium/relayium/internal/selfupdate"
)

// updateRepo is the GitHub repo `relayium update` pulls releases from.
const updateRepo = "relayium/relayium"

// runUpdate upgrades this binary to the latest GitHub release. It replaces the
// currently-running executable in place (Unix); on Windows, where a running
// .exe can't be overwritten, it prints manual-upgrade instructions instead.
func runUpdate(args []string, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet("update", flag.ContinueOnError)
	fs.SetOutput(stderr)
	var check, force bool
	fs.BoolVar(&check, "check", false, "only report whether an update is available; install nothing")
	fs.BoolVar(&force, "force", false, "reinstall even if already on the latest version")
	if err := parseArgs(fs, args); err != nil {
		return 2
	}

	opts := selfupdate.Options{
		Repo:           updateRepo,
		CurrentVersion: version,
		GOOS:           runtime.GOOS,
		GOARCH:         runtime.GOARCH,
		Force:          force,
	}
	ctx := context.Background()

	if check {
		tag, err := selfupdate.LatestTag(ctx, opts)
		if err != nil {
			fmt.Fprintln(stderr, err)
			return 1
		}
		fmt.Fprintf(stdout, "current: %s\nlatest:  %s\n", version, tag)
		if selfupdate.SameVersion(tag, version) {
			fmt.Fprintln(stdout, "up to date")
		} else {
			fmt.Fprintln(stdout, "update available — run `relayium update`")
		}
		return 0
	}

	// A running .exe is locked on Windows, so self-replacement isn't possible;
	// point the user at the release zip (matching install.sh's Windows path).
	if runtime.GOOS == "windows" {
		fmt.Fprintln(stderr, "relayium update can't replace a running .exe on Windows.")
		fmt.Fprintf(stderr, "Download the latest .zip from https://github.com/%s/releases/latest\n", updateRepo)
		return 1
	}

	exe, err := os.Executable()
	if err != nil {
		fmt.Fprintln(stderr, "cannot locate the running binary:", err)
		return 1
	}
	// Resolve symlinks so we replace the real binary, not a symlink to it.
	if resolved, rerr := filepath.EvalSymlinks(exe); rerr == nil {
		exe = resolved
	}
	opts.TargetPath = exe

	if version == "dev" {
		fmt.Fprintln(stderr, `note: this is a source build (version "dev"); installing the latest release over it`)
	}

	from, to, changed, err := selfupdate.Update(ctx, opts, stderr)
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	if !changed {
		fmt.Fprintf(stdout, "already up to date (%s)\n", to)
		return 0
	}
	fmt.Fprintf(stdout, "Updated %s → %s\n", from, to)
	return 0
}

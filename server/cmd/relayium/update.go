package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/relayium/relayium/selfupdate"
)

// updateRepo is the GitHub repo `relayium update` pulls releases from.
const updateRepo = "relayium/relayium"

// updateAPIBase overrides the release API base; empty uses selfupdate's
// default (GitHub). A var only so tests can point a check at a loopback stub.
var updateAPIBase = ""

// runUpdate upgrades this binary to the latest GitHub release. It replaces the
// currently-running executable in place (Unix); on Windows, where a running
// .exe can't be overwritten, it prints manual-upgrade instructions instead.
func runUpdate(args []string, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet("update", flag.ContinueOnError)
	fs.SetOutput(stderr)
	var check, force, asJSON bool
	fs.BoolVar(&check, "check", false, "only report whether an update is available; install nothing")
	fs.BoolVar(&force, "force", false, "reinstall even if already on the latest version; also permits downgrades, including below the built-in minimum version")
	fs.BoolVar(&asJSON, "json", false, "with --check: print one JSON document")
	if wantsHelpFS(fs, args) {
		fmt.Fprint(stdout, updateUsage)
		return 0
	}
	if err := parseArgs(fs, args); err != nil {
		return 2
	}
	// --json describes a check. Accepting it alone would silently perform the
	// update a script only meant to ask about, so that is refused outright.
	if asJSON && !check {
		fmt.Fprintln(stderr, "update: --json is only valid with --check (it reports; it never installs)")
		return 2
	}

	opts := selfupdate.Options{
		Repo:           updateRepo,
		CurrentVersion: version,
		GOOS:           runtime.GOOS,
		GOARCH:         runtime.GOARCH,
		Force:          force,
		APIBase:        updateAPIBase,
	}
	ctx := context.Background()

	if check {
		tag, err := selfupdate.LatestTag(ctx, opts)
		if err != nil {
			if asJSON {
				writeUpdateCheckJSON(stdout, updateCheckDoc{Current: version, Error: "check_failed"})
			}
			fmt.Fprintln(stderr, err)
			return 1
		}
		if asJSON {
			writeUpdateCheckJSON(stdout, updateCheckDoc{
				Current: version, Latest: tag,
				UpdateAvailable: updateAvailable(tag, version),
			})
			return 0
		}
		fmt.Fprintf(stdout, "current: %s\nlatest:  %s\n", version, tag)
		fmt.Fprintln(stdout, updateCheckVerdict(tag, version))
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

// updateCheckVerdict is the one-line answer `relayium update --check` prints.
// An update is "available" only when the latest release is strictly newer than
// the running version: a running build that is newer than the latest release
// (a pre-release install, or a release host serving a stale "latest") must not
// be told to "update", because `relayium update` would refuse that downgrade.
// A version that is not a plain release ("dev", a pre-release suffix) cannot be
// ordered; it keeps the long-standing answer that the latest release is
// available, since `relayium update` installs it over such a build.
func updateCheckVerdict(latest, current string) string {
	if selfupdate.SameVersion(latest, current) {
		return "up to date"
	}
	if cmp, ok := selfupdate.CompareVersions(latest, current); ok && cmp <= 0 {
		return "up to date (this build is newer than the latest release " + latest + ")"
	}
	return "update available — run `relayium update`"
}

// updateAvailable is updateCheckVerdict's yes/no, for --json: the same rule,
// so the two forms can never disagree.
func updateAvailable(latest, current string) bool {
	return strings.HasPrefix(updateCheckVerdict(latest, current), "update available")
}

// updateCheckDoc is `update --check --json`'s one document. Exit 0 means the
// check was answered, whatever the answer; 1 means it could not be.
type updateCheckDoc struct {
	Current         string `json:"current"`
	Latest          string `json:"latest,omitempty"`
	UpdateAvailable bool   `json:"updateAvailable"`
	Error           string `json:"error,omitempty"`
}

func writeUpdateCheckJSON(w io.Writer, d updateCheckDoc) {
	enc := json.NewEncoder(w)
	enc.SetEscapeHTML(false)
	_ = enc.Encode(d)
}

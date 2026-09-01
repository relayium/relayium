package main

import (
	"flag"
	"fmt"
	"io"

	"github.com/relayium/relayium/internal/secure"
)

// runID prints this host's persistent fingerprint, for pasting into a peer's
// known_hosts (push→serve trust) or authorized_fingerprints (serve→push trust).
func runID(args []string, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet("id", flag.ContinueOnError)
	fs.SetOutput(stderr)
	var configDir string
	fs.StringVar(&configDir, "config-dir", "", "identity/trust directory")
	if wantsHelpFS(fs, args) {
		fmt.Fprint(stdout, idUsage)
		return 0
	}
	if err := parseArgs(fs, args); err != nil {
		return 2
	}
	cfgDir, err := resolveConfigDir(configDir)
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	id, err := secure.LoadOrCreateIdentity(cfgDir)
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	fmt.Fprintln(stdout, id.Fingerprint)
	return 0
}

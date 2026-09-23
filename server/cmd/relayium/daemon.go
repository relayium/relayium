package main

import (
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/relayium/relayium/internal/xfer"
)

// defaultDaemonPort is the TCP port a bare "relayium://host" targets and the
// default for `relayium serve`.
const defaultDaemonPort = 9031

// daemonScheme prefixes a daemon-direct push target.
const daemonScheme = "relayium://"

// resolveConfigDir returns the directory holding the persistent identity and
// trust files. An explicit --config-dir wins; otherwise $XDG_CONFIG_HOME/relayium
// (falling back to ~/.config/relayium).
func resolveConfigDir(override string) (string, error) {
	if override != "" {
		return override, nil
	}
	if x := os.Getenv("XDG_CONFIG_HOME"); x != "" {
		return filepath.Join(x, "relayium"), nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".config", "relayium"), nil
}

// parseDaemonURL turns "relayium://host[:port]" into a dialable "host:port",
// applying defaultDaemonPort when no port is given.
func parseDaemonURL(s string) (string, error) {
	rest := strings.TrimPrefix(s, daemonScheme)
	if rest == "" {
		return "", fmt.Errorf("empty daemon target in %q", s)
	}
	if strings.ContainsAny(rest, "/") {
		return "", fmt.Errorf("daemon target must be host[:port] with no path: %q", s)
	}
	host, port, err := net.SplitHostPort(rest)
	if err != nil {
		// No port present → apply the default.
		return net.JoinHostPort(rest, strconv.Itoa(defaultDaemonPort)), nil
	}
	if port == "" {
		return net.JoinHostPort(host, strconv.Itoa(defaultDaemonPort)), nil
	}
	return rest, nil
}

// parseDaemonStreamTarget splits the `push -` form "relayium://host[:port]/rel"
// into the listener target "relayium://host[:port]" and the path of the file
// to create, relative to the listener's --dir. The path is taken literally
// (no percent-decoding) and checked as strictly as the listener checks it,
// so a path the listener would refuse is refused here without dialing.
// Only `push -` takes a path; every other daemon target keeps parseDaemonURL.
func parseDaemonStreamTarget(s string) (target, rel string, err error) {
	rest := strings.TrimPrefix(s, daemonScheme)
	i := strings.IndexByte(rest, '/')
	if i < 0 || i == len(rest)-1 {
		return "", "", fmt.Errorf("\"push -\" to a listener needs the file to create: relayium://host[:port]/path/to/file, relative to the listener's --dir (got %q)", s)
	}
	host, rel := rest[:i], rest[i+1:]
	if host == "" {
		return "", "", fmt.Errorf("empty daemon target in %q", s)
	}
	if err := xfer.ValidateStreamPath(rel); err != nil {
		return "", "", err
	}
	return daemonScheme + host, rel, nil
}

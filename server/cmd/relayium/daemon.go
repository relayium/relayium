package main

import (
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
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

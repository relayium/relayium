// Package trust implements the daemon-direct mode's persistent peer-trust files:
// a push-side known_hosts (TOFU pinning of listeners) and a serve-side
// authorized_fingerprints allow-list (which pushers may connect). Both are plain
// text and mirror the semantics of the SSH files of the same names.
package trust

import (
	"bufio"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

const (
	knownHostsFile = "known_hosts"
	authorizedFile = "authorized_fingerprints"
)

// LookupHost searches dir/known_hosts for hostport and returns its pinned
// fingerprint. found is false (with no error) when the file or the entry is
// absent — the caller then performs a TOFU first-connect.
func LookupHost(dir, hostport string) (fp string, found bool, err error) {
	f, err := os.Open(filepath.Join(dir, knownHostsFile))
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return "", false, nil
		}
		return "", false, err
	}
	defer f.Close()

	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) < 2 {
			continue
		}
		if fields[0] == hostport {
			return strings.ToLower(fields[1]), true, nil
		}
	}
	if err := sc.Err(); err != nil {
		return "", false, err
	}
	return "", false, nil
}

// AddHost appends a "hostport fingerprint" line to dir/known_hosts, creating the
// file (and dir) if needed. It is the TOFU first-write; callers must only reach
// it when LookupHost reported the host as absent, so it never overwrites an
// existing pin.
func AddHost(dir, hostport, fp string) error {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	path := filepath.Join(dir, knownHostsFile)
	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		return err
	}
	defer f.Close()
	_, err = fmt.Fprintf(f, "%s %s\n", hostport, strings.ToLower(fp))
	return err
}

// LoadAuthorized parses dir/authorized_fingerprints into a set of allowed
// pusher fingerprints. Blank lines and #-comments (whole-line or trailing) are
// ignored. A missing file yields an empty set with no error, so serve can start
// before any pusher is authorized.
func LoadAuthorized(dir string) (map[string]bool, error) {
	set := map[string]bool{}
	f, err := os.Open(filepath.Join(dir, authorizedFile))
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return set, nil
		}
		return nil, err
	}
	defer f.Close()

	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := sc.Text()
		if i := strings.IndexByte(line, '#'); i >= 0 {
			line = line[:i]
		}
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		// A fingerprint line may carry extra whitespace-separated fields; the
		// fingerprint is the first token.
		set[strings.ToLower(strings.Fields(line)[0])] = true
	}
	if err := sc.Err(); err != nil {
		return nil, err
	}
	return set, nil
}

// AuthorizedPath returns the serve-side allow-list path, for user-facing hints.
func AuthorizedPath(dir string) string { return filepath.Join(dir, authorizedFile) }

// AddAuthorized appends fp to dir/authorized_fingerprints (creating it and dir),
// unless it is already present. The fingerprint is normalised to lowercase.
//
// A running `relayium serve` using the SAME dir re-reads this file whenever it
// meets a fingerprint it doesn't know, so a peer authorized here is accepted on
// its next connection without restarting the listener. Removing a line is not
// symmetric: serve's reload only adds, so revoking access still means
// restarting it.
func AddAuthorized(dir, fp string) error {
	fp = strings.ToLower(strings.TrimSpace(fp))
	if fp == "" {
		return errors.New("trust: empty fingerprint")
	}
	set, err := LoadAuthorized(dir)
	if err != nil {
		return err
	}
	if set[fp] {
		return nil // already authorized — no-op
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	f, err := os.OpenFile(filepath.Join(dir, authorizedFile), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		return err
	}
	defer f.Close()
	_, err = fmt.Fprintln(f, fp)
	return err
}

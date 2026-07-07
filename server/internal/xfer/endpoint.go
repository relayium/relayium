// Package xfer implements the Relayium CLI's SSH-native transfer engine and
// its wire protocol. It is pure client-side and never touches server code.
package xfer

import "strings"

// Endpoint is a parsed push/pull argument. A remote endpoint has a non-empty
// Host; a local one has Host == "". Stdin is set only for the literal "-".
type Endpoint struct {
	User  string
	Host  string
	Path  string
	Stdin bool
}

// IsRemote reports whether the endpoint names a host reachable over SSH.
func (e Endpoint) IsRemote() bool { return e.Host != "" }

// ParseEndpoint parses scp-style targets: "user@host:path", "host:path",
// a local filesystem path, or "-" for stdin. A local path is anything with
// no "host:" prefix (a leading "/" or "./" or a bare relative path). An empty
// remote path defaults to ".".
func ParseEndpoint(s string) (Endpoint, error) {
	if s == "-" {
		return Endpoint{Stdin: true}, nil
	}
	// A "host:path" form has a colon before any slash. "/a/b" and "./a" are local.
	colon := strings.IndexByte(s, ':')
	slash := strings.IndexByte(s, '/')
	if colon > 0 && (slash == -1 || colon < slash) {
		hostpart, path := s[:colon], s[colon+1:]
		e := Endpoint{Path: path}
		if at := strings.IndexByte(hostpart, '@'); at >= 0 {
			e.User = hostpart[:at]
			e.Host = hostpart[at+1:]
		} else {
			e.Host = hostpart
		}
		if e.Path == "" {
			e.Path = "."
		}
		return e, nil
	}
	return Endpoint{Path: s}, nil
}

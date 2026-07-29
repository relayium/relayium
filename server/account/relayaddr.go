package account

import (
	"strconv"
	"strings"
)

// relayAddr normalises one TURN URL to a comparable "host:port", reporting
// false when it cannot read one.
//
// The relay pool dedupes on this rather than on the URL string because what the
// client measures is the MACHINE, not the URL: turn:H:3478 and
// turn:H:3478?transport=tcp are one relay and one RTT. A statically configured
// relay's `urls` array is operator-written and may legitimately list both.
//
// DNS is deliberately not resolved. Two names for one machine stay two entries;
// resolving would put a network round trip on /api/ice, which must stay fast.
func relayAddr(raw string) (string, bool) {
	s := strings.TrimSpace(raw)
	lower := strings.ToLower(s)
	var defPort string
	switch {
	case strings.HasPrefix(lower, "turns:"):
		s, defPort = s[len("turns:"):], "5349"
	case strings.HasPrefix(lower, "turn:"):
		s, defPort = s[len("turn:"):], "3478"
	default:
		return "", false
	}
	// Query parameters (?transport=tcp) name a transport, not a relay.
	if i := strings.IndexByte(s, '?'); i >= 0 {
		s = s[:i]
	}
	s = strings.TrimSpace(s)
	if s == "" {
		return "", false
	}

	host, port := s, defPort
	switch {
	case strings.HasPrefix(s, "["):
		// IPv6 literal: the host runs to the closing bracket, which stays part
		// of the key so "[::1]:3478" cannot be confused with a name.
		end := strings.IndexByte(s, ']')
		if end < 0 {
			return "", false
		}
		host = s[:end+1]
		switch rest := s[end+1:]; {
		case rest == "":
		case strings.HasPrefix(rest, ":"):
			port = rest[1:]
		default:
			return "", false
		}
	default:
		if i := strings.LastIndexByte(s, ':'); i >= 0 {
			host, port = s[:i], s[i+1:]
		}
		// A bare IPv6 would have just been split at its last colon, yielding a
		// host that is really an address prefix. TURN URLs require brackets, so
		// reject it rather than invent a host.
		if strings.Contains(host, ":") {
			return "", false
		}
	}
	if host == "" || port == "" {
		return "", false
	}
	if _, err := strconv.Atoi(port); err != nil {
		return "", false
	}
	return strings.ToLower(host) + ":" + port, true
}

// relayAddrs normalises a relay's URL list, dropping what it cannot read.
//
// Dropping rather than failing is what makes an entry with one odd URL stay in
// the pool: a parser that cannot read an unusual but working URL must never be
// able to empty the relay pool.
func relayAddrs(urls []string) []string {
	out := make([]string, 0, len(urls))
	for _, u := range urls {
		if a, ok := relayAddr(u); ok {
			out = append(out, a)
		}
	}
	return out
}

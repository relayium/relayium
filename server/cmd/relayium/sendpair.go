package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/relayium/relayium/internal/cloud"
)

// apiBase turns the crossnet --server URL (a wss:// signaling base) into the
// HTTP base the account API lives on, so a self-hoster passes one flag rather
// than two.
//
// It strips a trailing "/ws" — the signaling endpoint itself — and keeps
// whatever path prefix is left. `--server ws://host/ws` is a perfectly valid
// signaling target (rzvous.Join overwrites u.Path with "/ws" itself), but that
// path is the endpoint, not the origin: carrying it through produced
// "http://host/ws", which mismatched the stored creds.Server so minting was
// refused, and the remedy that refusal printed, `relayium login --server
// http://host/ws`, would have stored credentials whose /api/pair resolves to
// /ws/api/pair, a 404.
//
// Any *other* path is a deployment prefix and must survive: a self-hoster
// serving Relayium under https://host/relay has its API at
// https://host/relay/api/pair, so flattening to the bare origin broke minting
// there just as thoroughly (that is why this does not simply drop the path).
// "/relay/ws" — the same deployment's signaling URL — correctly yields
// "/relay". A trailing slash is trimmed so the base concatenates cleanly and
// so sameServer's comparison against stored creds holds. Query and fragment
// are dropped: an API base has no use for them.
//
// Anything that is not ws/wss/http/https over a host is rejected here rather
// than carried into the error copy downstream. `--server 127.0.0.1:18080`
// (schemeless) used to surface url.Parse's "first path segment in URL cannot
// contain colon", and `--server ""` produced the uncopyable remedy "run
// `relayium login --server ` before sending from there".
func apiBase(server string) (string, error) {
	u, err := url.Parse(server)
	if err != nil || u.Host == "" {
		return "", badServerURL(server)
	}
	var scheme string
	switch u.Scheme {
	case "wss", "https":
		scheme = "https"
	case "ws", "http":
		scheme = "http"
	default:
		return "", badServerURL(server)
	}
	path := strings.TrimSuffix(u.Path, "/")
	path = strings.TrimSuffix(path, "/ws")
	return (&url.URL{Scheme: scheme, Host: u.Host, Path: path}).String(), nil
}

// badServerURL names what was passed and what is expected. It quotes the value
// because the failing inputs are the ones that read as nothing at all — an
// empty string, or a host that was silently taken for a scheme.
func badServerURL(server string) error {
	return fmt.Errorf(
		"--server %q is not a usable server URL\n"+
			"  expected a scheme and a host, e.g. wss://relayium.com or http://192.168.1.9:8080\n"+
			"  accepted schemes: ws, wss, http, https",
		server)
}

// errNotLoggedIn is the copy for "minting needs an account". It never starts a
// login: `send` runs on servers and in CI, where blocking on a browser approval
// hangs a job that expected a fast failure.
func errNotLoggedIn(base string) error {
	login := "relayium login"
	if !sameServer(base, defaultCloudServer) {
		login = "relayium login --server " + base
	}
	return fmt.Errorf(
		"minting a pairing code needs an account (the sender signs in; the receiver never does)\n"+
			"  run `%s` first, or pass a code you were given:  relayium send <file> <code>\n"+
			"  sending to someone with a browser instead?  `relayium up <file>` returns a download link",
		login)
}

// mintCode mints a pairing code with the stored CLI credentials and prints the
// block the sender hands to the other machine's operator.
func mintCode(ctx context.Context, server string, stderr io.Writer) (string, error) {
	base, err := apiBase(server)
	if err != nil {
		return "", err
	}
	cfgDir, err := resolveConfigDir("")
	if err != nil {
		return "", err
	}
	creds, ok, err := cloud.Load(cfgDir)
	if err != nil {
		return "", err
	}
	if !ok {
		return "", errNotLoggedIn(base)
	}
	// Never send the access token to a server other than the one that issued it
	// — it would leak the credential and would not authenticate there anyway.
	if !sameServer(base, creds.Server) {
		return "", fmt.Errorf("you're logged in to %s — run `relayium login --server %s` before sending from there", creds.Server, base)
	}
	c := cloud.NewClient(creds.Server)
	c.Token = creds.AccessToken
	p, err := c.MintPair(ctx)
	if err != nil {
		var he *cloud.HTTPError
		if errors.As(err, &he) {
			switch he.Status {
			case http.StatusUnauthorized:
				return "", errNotLoggedIn(base)
			case http.StatusTooManyRequests:
				return "", fmt.Errorf("too many pairing requests — wait a minute and try again")
			}
		}
		return "", err
	}
	printHandoff(stderr, p, base)
	return p.Code, nil
}

// printHandoff writes the one block a sender pastes into a chat window or
// another machine's SSH session: everything the recipient needs, no link to
// follow (the CLI cannot consume a URL, and the recipient is at a terminal).
//
// This block goes to stderr, which is deliberately the opposite of runUp's
// convention (cloud.go: the share link goes to stdout so `relayium up … |
// pbcopy` keeps piping a clean link). The difference is that `up` finishes and
// leaves the link as its terminal artifact, whereas `send` prints this and then
// blocks waiting for the receiver — nothing downstream of a pipe would run
// until the transfer ended, so there is no pipeline to keep clean. Treat it as
// interactive hand-off, alongside the SAS line and "path: direct" that
// crossnetConn already writes to stderr, rather than as command output.
func printHandoff(w io.Writer, p cloud.Pair, base string) {
	fmt.Fprintf(w, "Code: %s%s\n", p.Code, ttlClause(p.ExpiresAt))
	fmt.Fprintf(w, "On the other machine:  relayium receive %s\n", p.Code)
	// First-party only: a self-hosted origin has no install.sh to point at.
	if sameServer(base, defaultCloudServer) {
		fmt.Fprintf(w, "  not installed there?  curl -fsSL %s/install.sh | sh\n", defaultCloudServer)
	}
	fmt.Fprintln(w, "waiting for the receiver…")
}

// ttlClause renders " (valid N minutes)" for the hand-off block, derived from
// the server's expiry rather than hard-coded so the copy follows a TTL change
// instead of lying about it. Rounds rather than truncates: Unix() floors the
// server's deadline and network latency eats a little more, so a plain
// integer divide by time.Minute prints "4 minutes" for every 5-minute code.
// expiresAt == 0 means an older server that doesn't report an expiry (see
// cloud.go's truncatedTTLNotice) — there is nothing to derive, so the clause
// is omitted rather than guessed.
func ttlClause(expiresAt int64) string {
	if expiresAt == 0 {
		return ""
	}
	mins := int((time.Until(time.Unix(expiresAt, 0)) + 30*time.Second) / time.Minute)
	if mins < 1 {
		mins = 1
	}
	unit := "minutes"
	if mins == 1 {
		unit = "minute"
	}
	return fmt.Sprintf("   (valid %d %s)", mins, unit)
}

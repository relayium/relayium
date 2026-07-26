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
func apiBase(server string) (string, error) {
	u, err := url.Parse(server)
	if err != nil {
		return "", err
	}
	switch u.Scheme {
	case "wss":
		u.Scheme = "https"
	case "ws":
		u.Scheme = "http"
	}
	return strings.TrimRight(u.String(), "/"), nil
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
func printHandoff(w io.Writer, p cloud.Pair, base string) {
	// Derived from the server's expiry rather than hard-coded, so the copy
	// follows a TTL change instead of lying about it.
	mins := int(time.Until(time.Unix(p.ExpiresAt, 0)) / time.Minute)
	if mins < 1 {
		mins = 1
	}
	fmt.Fprintf(w, "Code: %s   (valid %d minutes)\n", p.Code, mins)
	fmt.Fprintf(w, "On the other machine:  relayium receive %s\n", p.Code)
	// First-party only: a self-hosted origin has no install.sh to point at.
	if sameServer(base, defaultCloudServer) {
		fmt.Fprintf(w, "  not installed there?  curl -fsSL %s/install.sh | sh\n", defaultCloudServer)
	}
	fmt.Fprintln(w, "waiting for the receiver…")
}

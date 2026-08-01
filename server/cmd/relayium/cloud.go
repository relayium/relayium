package main

import (
	"context"
	"flag"
	"fmt"
	"io"
	"strconv"
	"strings"
	"time"

	"github.com/relayium/relayium/internal/cloud"
)

// defaultCloudServer is the first-party account-bound cloud server that
// login/logout/whoami (and, later, up/down) talk to unless --server
// overrides it. Self-hosters point elsewhere with --server.
const defaultCloudServer = "https://relayium.com"

// sameServer reports whether two cloud-server URLs address the same host,
// tolerating a trailing slash. A conservative mismatch just prompts a re-login,
// the safe direction for a request that would otherwise carry an access token.
func sameServer(a, b string) bool {
	return strings.TrimRight(a, "/") == strings.TrimRight(b, "/")
}

// runLogin drives the CLI device-code login flow: it asks the server for a
// user code + verification URL, prints them so the human can approve in a
// browser, then blocks until approval (or denial/expiry) and persists the
// resulting credentials.
func runLogin(args []string, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet("login", flag.ContinueOnError)
	fs.SetOutput(stderr)
	var server string
	fs.StringVar(&server, "server", defaultCloudServer, "cloud server base URL")
	if err := parseArgs(fs, args); err != nil {
		return 2
	}

	cfgDir, err := resolveConfigDir("")
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}

	notify := func(start cloud.DeviceStart) {
		fmt.Fprintf(stderr, "Open %s and enter code: %s\n", start.VerificationURI, start.UserCode)
	}

	creds, err := cloud.NewClient(server).Login(context.Background(), notify)
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	if err := cloud.Save(cfgDir, creds); err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	fmt.Fprintf(stdout, "logged in as %s\n", creds.AccountEmail)
	return 0
}

// runLogout revokes the current bearer credential before clearing it locally.
// --local-only is the explicit offline escape hatch; without it, a failed
// server revocation preserves the local credential so the user can retry.
func runLogout(args []string, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet("logout", flag.ContinueOnError)
	fs.SetOutput(stderr)
	var localOnly bool
	fs.BoolVar(&localOnly, "local-only", false, "clear local credentials without revoking the server token")
	if err := parseArgs(fs, args); err != nil {
		return 2
	}
	cfgDir, err := resolveConfigDir("")
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	creds, ok, err := cloud.Load(cfgDir)
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	if ok && !localOnly {
		client := cloud.NewClient(creds.Server)
		client.Token = creds.AccessToken
		if err := client.Logout(context.Background()); err != nil {
			fmt.Fprintf(stderr, "could not revoke server token: %v\n", err)
			fmt.Fprintln(stderr, "credentials were kept; retry or use `relayium logout --local-only` if the server is permanently unavailable")
			return 1
		}
	}
	if err := cloud.Clear(cfgDir); err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	if localOnly && ok {
		fmt.Fprintln(stdout, "logged out locally (server token was not revoked)")
	} else {
		fmt.Fprintln(stdout, "logged out")
	}
	return 0
}

// runWhoami reports the locally stored account, if any.
func runWhoami(args []string, stdout, stderr io.Writer) int {
	cfgDir, err := resolveConfigDir("")
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	creds, ok, err := cloud.Load(cfgDir)
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	if !ok {
		fmt.Fprintln(stderr, "not logged in (run `relayium login`)")
		return 1
	}
	fmt.Fprintf(stdout, "%s (%s)\n", creds.AccountEmail, creds.Server)
	return 0
}

const (
	secsPerDay  int64 = 86400
	secsPerWeek int64 = 7 * secsPerDay
)

// parseTTL accepts a day or week count ("7d", "2w"), a Go duration string
// ("2h", "30m", "1h30m"), or a bare integer interpreted as seconds — so
// `--ttl 3600`, `--ttl 1h` and `--ttl 7d` all work.
//
// The day/week units are handled here because time.ParseDuration has no unit
// larger than an hour, and without them this function rejected exactly the
// strings formatTTL emits: a "kept 1d, not the 7d you asked for" notice could
// not be pasted back into the next command, though its doc comment promised it
// could. TestTTLRoundTrip pins that property. Weeks are accepted (though never
// emitted — formatTTL prefers days, which round-trip) because the longest plan
// retention is 14 days, so "2w" is a value a user can legitimately ask for.
func parseTTL(s string) (int64, error) {
	if secs, ok := parseDayOrWeek(s); ok {
		return secs, nil
	}
	if d, err := time.ParseDuration(s); err == nil {
		return int64(d.Seconds()), nil
	}
	n, err := strconv.ParseInt(s, 10, 64)
	if err != nil {
		return 0, fmt.Errorf("invalid --ttl %q: not a duration (7d, 2w, 2h, 90m) or a number of seconds", s)
	}
	return n, nil
}

// parseDayOrWeek reads "<int>d" / "<int>w" into seconds. It reports false for
// anything else, including a count that would overflow int64, so the caller
// falls through to the other forms and ultimately to parseTTL's error.
func parseDayOrWeek(s string) (int64, bool) {
	var unit int64
	switch {
	case strings.HasSuffix(s, "d"):
		unit = secsPerDay
	case strings.HasSuffix(s, "w"):
		unit = secsPerWeek
	default:
		return 0, false
	}
	n, err := strconv.ParseInt(strings.TrimSuffix(s, s[len(s)-1:]), 10, 64)
	if err != nil {
		return 0, false
	}
	if n != 0 && (n*unit)/unit != n { // overflow
		return 0, false
	}
	return n * unit, true
}

// formatTTL renders a second count the way --ttl accepts it back ("7d", "2h"),
// so a notice can be pasted straight into the next command.
func formatTTL(secs int64) string {
	switch {
	case secs%86400 == 0:
		return fmt.Sprintf("%dd", secs/86400)
	case secs%3600 == 0:
		return fmt.Sprintf("%dh", secs/3600)
	case secs%60 == 0:
		return fmt.Sprintf("%dm", secs/60)
	default:
		return fmt.Sprintf("%ds", secs)
	}
}

// truncatedTTLNotice reports when the server kept the upload for less time than
// --ttl asked for. The server clamps a request that exceeds the plan's
// retention cap SILENTLY — it returns 200 with a shorter expiresAt and no
// explanation — so without this the user is told nothing and only finds out
// when the link dies early. Returns "" when there is nothing to report.
//
// requestedSecs is 0 when --ttl was not passed (the server picks its own
// default, which is not a truncation), and expiresAt is 0 on servers old
// enough not to report it; both mean "cannot compare, stay quiet".
func truncatedTTLNotice(requestedSecs, expiresAt, now int64) string {
	if requestedSecs <= 0 || expiresAt <= 0 {
		return ""
	}
	granted := expiresAt - now
	// Client/server clocks differ by a few seconds routinely; comparing
	// strictly would make every single upload print a bogus warning.
	const skewToleranceSecs = 60
	if granted >= requestedSecs-skewToleranceSecs {
		return ""
	}
	return fmt.Sprintf(
		"note: your plan caps retention, so this link is kept %s, not the %s you asked for",
		formatTTL(granted), formatTTL(requestedSecs))
}

// runUp encrypts paths client-side and uploads them to the account-bound
// cloud store, printing a claim link that works both in a browser (the
// web /d/ page) and via `relayium down`.
func runUp(args []string, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet("up", flag.ContinueOnError)
	fs.SetOutput(stderr)
	var burn bool
	var ttlArg string
	var maxDownloads int64
	var server string
	fs.BoolVar(&burn, "burn", false, "delete after first download")
	fs.StringVar(&ttlArg, "ttl", "", "retention, as a duration (7d, 2h, 90m) or seconds")
	fs.Int64Var(&maxDownloads, "max-downloads", 0, "max number of downloads allowed")
	fs.StringVar(&server, "server", "", "override the cloud server (defaults to the logged-in server)")
	if err := parseArgs(fs, args); err != nil {
		return 2
	}
	paths := fs.Args()
	if len(paths) == 0 {
		fmt.Fprintln(stderr, "up needs <path...>")
		return 2
	}

	cfgDir, err := resolveConfigDir("")
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	creds, ok, err := cloud.Load(cfgDir)
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	if !ok {
		fmt.Fprintln(stderr, "run `relayium login` first")
		return 1
	}

	var ttlSeconds int64
	if ttlArg != "" {
		ttlSeconds, err = parseTTL(ttlArg)
		if err != nil {
			fmt.Fprintln(stderr, err)
			return 2
		}
	}

	// Never send the access token to a server other than the one that issued it.
	// The token authenticates you to creds.Server (e.g. relayium.com); attaching
	// it to an arbitrary --server override would leak your account credential to
	// that host — and it wouldn't authenticate there anyway. Require a matching
	// login instead.
	if server != "" && !sameServer(server, creds.Server) {
		fmt.Fprintf(stderr, "you're logged in to %s — run `relayium login --server %s` before uploading there\n", creds.Server, server)
		return 1
	}
	client := cloud.NewClient(creds.Server)
	client.Token = creds.AccessToken
	if server != "" {
		client.Server = server
	}
	bar := newProgressBar(stderr, "⇡", "Uploading")
	client.Progress = bar.update

	id, key, expiresAt, err := client.Upload(context.Background(), paths, cloud.UploadOpts{
		Burn:         burn,
		TTLSeconds:   ttlSeconds,
		MaxDownloads: maxDownloads,
	})
	bar.finish()
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}

	link := client.DownloadLink(client.Server, id, key)
	fmt.Fprintln(stdout, link)
	// Keep stdout machine-composable: `relayium up ... | pbcopy` must copy only
	// the link. The human hint belongs on stderr and includes the exact,
	// shell-safe command — asking someone to replace <link> wastes information
	// the CLI already has, and the fragment must be quoted defensively.
	fmt.Fprintf(stderr, "opens in a browser, or fetch it with `relayium down '%s'`\n", link)
	if notice := truncatedTTLNotice(ttlSeconds, expiresAt, time.Now().Unix()); notice != "" {
		fmt.Fprintln(stderr, notice)
	}
	return 0
}

// runDown fetches and decrypts a claim (a full `relayium up` link, or a bare
// <id>#k=<key> code) into destDir. It needs no login: /meta and /blob are
// public endpoints gated only by knowledge of id + key, matching the web
// /d/<id> claim page.
func runDown(args []string, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet("down", flag.ContinueOnError)
	fs.SetOutput(stderr)
	var server string
	fs.StringVar(&server, "server", "", "override the cloud server (defaults to the one embedded in the link, else "+defaultCloudServer+")")
	if err := parseArgs(fs, args); err != nil {
		return 2
	}
	rest := fs.Args()
	if len(rest) < 1 || len(rest) > 2 {
		fmt.Fprintln(stderr, "down needs <link-or-code> [destDir]")
		return 2
	}
	claim := rest[0]
	destDir := "."
	if len(rest) == 2 {
		destDir = rest[1]
	}

	claimServer, id, key, err := cloud.ParseClaim(claim)
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 2
	}

	client := cloud.NewClient(resolveDownServer(claimServer, server))
	bar := newProgressBar(stderr, "⇣", "Downloading")
	client.Progress = bar.update
	paths, err := client.Download(context.Background(), id, key, destDir)
	bar.finish()
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	for _, p := range paths {
		fmt.Fprintln(stdout, p)
	}
	fmt.Fprintf(stderr, "✓ downloaded %d file(s) to %s\n", len(paths), destDir)
	return 0
}

// resolveDownServer picks the cloud server `down` talks to. Precedence: an
// explicit --server always wins (self-hosters pointing at their own
// instance); otherwise prefer the server embedded in a full claim link, so a
// link always resolves to the server it came from even if the user has a
// different --server habit; a bare <id>#k=<key> code has no embedded server,
// so fall back to the first-party default.
func resolveDownServer(claimServer, flagServer string) string {
	if flagServer != "" {
		return flagServer
	}
	if claimServer != "" {
		return claimServer
	}
	return defaultCloudServer
}

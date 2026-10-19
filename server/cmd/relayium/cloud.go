package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/relayium/relayium/internal/cloud"
	"github.com/relayium/relayium/internal/devicelabel"
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

// osHostname is os.Hostname, indirected so the lookup-failure branch below is
// reachable from a test. A machine that cannot name itself is rare and entirely
// plausible (a container with no UTS name, a stripped environment), and it must
// end in a working login rather than a crash or a blank device row.
var osHostname = os.Hostname

// defaultDeviceName is the label a login registers when the user did not choose
// one: this host's own name, which is the thing they will recognise in My
// Devices. It is NOT shortened or prettified — a `.local` suffix or a full
// FQDN is what the machine calls itself, and guessing at a nicer form would
// make the printed label unpredictable. `--device-name` exists for anyone who
// wants something else, including anyone who does not want an internal
// hostname in their account.
func defaultDeviceName() string {
	h, err := osHostname()
	if err != nil {
		return devicelabel.Fallback
	}
	// A trailing dot is the DNS root, not part of the name.
	if label := devicelabel.Sanitize(strings.TrimSuffix(h, ".")); label != "" {
		return label
	}
	return devicelabel.Fallback
}

// runLogin drives the CLI device-code login flow: it asks the server for a
// user code + verification URL, prints them so the human can approve in a
// browser, then blocks until approval (or denial/expiry) and persists the
// resulting credentials.
func runLogin(args []string, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet("login", flag.ContinueOnError)
	fs.SetOutput(stderr)
	var server, configDir, deviceName string
	fs.StringVar(&server, "server", defaultCloudServer, "cloud server base URL")
	fs.StringVar(&configDir, "config-dir", "", "credential directory (default ~/.config/relayium)")
	fs.StringVar(&deviceName, "device-name", "", "label for this machine in My Devices (default: this host's name)")
	if wantsHelpFS(fs, args) {
		fmt.Fprint(stdout, loginUsage)
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

	// Refuse an existing credential before any network or filesystem changes.
	// Account/server switching must be explicit; an approved login can rotate
	// the existing installation's bearer on capable servers.
	if existing, ok, lerr := cloud.Load(cfgDir); lerr != nil {
		fmt.Fprintf(stderr, "login: the existing credential in %s cannot be read (%v); it was left untouched.\n", cfgDir, lerr)
		fmt.Fprintln(stderr, "  run `relayium logout --local-only` to clear it, or fix the file, then log in again")
		return 1
	} else if ok {
		fmt.Fprintf(stderr, "login: this machine is already logged in as %s (%s).\n", existing.AccountEmail, existing.Server)
		fmt.Fprintln(stderr, "  A new login could replace the current credential and disrupt active Device Inbox work.")
		fmt.Fprintln(stderr, "  To use another account or server: run `relayium logout` first (it revokes the current")
		fmt.Fprintln(stderr, "  credential on the server), then `relayium login`. Nothing was changed.")
		return 1
	}

	// An EXPLICIT label that sanitizes away is an error, not a silent fallback:
	// the user asked for a specific name, and quietly registering the hostname
	// instead would put a machine in their account under a name they did not
	// choose. An absent flag falls back, because that is what a default is.
	label := devicelabel.Sanitize(deviceName)
	if deviceName != "" && label == "" {
		fmt.Fprintln(stderr, "--device-name has no usable characters after removing control and invisible ones")
		return 2
	}
	if label == "" {
		label = defaultDeviceName()
	}

	lock, err := cloud.LockLogin(cfgDir)
	if err != nil {
		fmt.Fprintln(stderr, "login: could not exclusively own this login:", err)
		return 1
	}
	defer lock.Release()
	// Another process may have completed login between the first check and
	// lock acquisition. Never replace its credential with a second approval.
	if _, exists, err := cloud.Load(cfgDir); err != nil || exists {
		fmt.Fprintln(stderr, "login: credentials changed while waiting; nothing was replaced")
		return 1
	}
	installation, err := cloud.InstallationID(cfgDir, server)
	if err != nil {
		fmt.Fprintln(stderr, "login: could not load this installation identity:", err)
		if errors.Is(err, cloud.ErrInstallationUnsafe) {
			fmt.Fprintf(stderr, "Inspect permissions and restore %s from a trusted backup; for a separate installation use a new --config-dir. Nothing was replaced.\n", filepath.Join(cfgDir, "cli-installations"))
		}
		return 1
	}

	notify := func(start cloud.DeviceStart) {
		if !start.CLIInstallIdentity {
			fmt.Fprintln(stderr, "This server does not support stable CLI installation identity; this login may register a new device.")
		}
		fmt.Fprintf(stderr, "Open %s and enter code: %s\n", start.VerificationURI, start.UserCode)
		// The exact label central was asked to bind to THIS request, printed
		// before approval so the row that appears in My Devices is one the
		// person already saw here. Central sanitizes with the same function, so
		// what is printed is what is stored.
		fmt.Fprintf(stderr, "This machine will appear in My Devices as: %s\n", label)
		fmt.Fprintln(stderr, "(run `relayium login --device-name <label>` to choose a different one)")
	}

	client := cloud.NewClient(server)
	client.DeviceName = label
	client.InstallationID = installation
	creds, err := client.Login(context.Background(), notify)
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
	var configDir string
	fs.BoolVar(&localOnly, "local-only", false, "clear local credentials without revoking the server token")
	fs.StringVar(&configDir, "config-dir", "", "credential directory (default ~/.config/relayium)")
	if wantsHelpFS(fs, args) {
		fmt.Fprint(stdout, logoutUsage)
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
	fs := flag.NewFlagSet("whoami", flag.ContinueOnError)
	fs.SetOutput(stderr)
	var configDir string
	var asJSON bool
	fs.StringVar(&configDir, "config-dir", "", "credential directory (default ~/.config/relayium)")
	fs.BoolVar(&asJSON, "json", false, "print one JSON document")
	if wantsHelpFS(fs, args) {
		fmt.Fprint(stdout, whoamiUsage)
		return 0
	}
	if err := parseArgs(fs, args); err != nil {
		return 2
	}
	// With --json the answer is exactly one document on stdout, failure
	// included. It is the local credential's account and server -- never the
	// token -- and, like the text form, says nothing about whether the server
	// still accepts it.
	type whoamiDoc struct {
		LoggedIn bool   `json:"loggedIn"`
		Account  string `json:"account,omitempty"`
		Server   string `json:"server,omitempty"`
		Error    string `json:"error,omitempty"`
	}
	emit := func(d whoamiDoc) {
		enc := json.NewEncoder(stdout)
		enc.SetEscapeHTML(false)
		_ = enc.Encode(d)
	}
	cfgDir, err := resolveConfigDir(configDir)
	if err != nil {
		if asJSON {
			emit(whoamiDoc{Error: "config_dir_unresolved"})
		}
		fmt.Fprintln(stderr, err)
		return 1
	}
	creds, ok, err := cloud.Load(cfgDir)
	if err != nil {
		if asJSON {
			emit(whoamiDoc{Error: "credential_unreadable"})
		}
		fmt.Fprintln(stderr, err)
		return 1
	}
	if !ok {
		if asJSON {
			emit(whoamiDoc{Error: "not_logged_in"})
		}
		fmt.Fprintln(stderr, "not logged in (run `relayium login`)")
		return 1
	}
	if asJSON {
		emit(whoamiDoc{LoggedIn: true, Account: creds.AccountEmail, Server: creds.Server})
		return 0
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
	var burn, asJSON, pending, resumable bool
	var ttlArg, recoverID, resumeID, discardID string
	var maxDownloads int64
	var server, configDir string
	fs.BoolVar(&burn, "burn", false, "delete after first download")
	fs.StringVar(&ttlArg, "ttl", "", "retention, as a duration (7d, 2h, 90m) or seconds")
	fs.Int64Var(&maxDownloads, "max-downloads", 0, "max number of downloads allowed")
	fs.StringVar(&server, "server", "", "override the cloud server (defaults to the logged-in server)")
	fs.StringVar(&configDir, "config-dir", "", "credential directory (default ~/.config/relayium)")
	fs.BoolVar(&asJSON, "json", false, "print one JSON document with the outcome")
	fs.StringVar(&recoverID, "recover", "", "ask the server for the outcome of an earlier upload whose outcome was unknown")
	fs.BoolVar(&pending, "pending", false, "list uploads whose outcome is still unknown")
	fs.BoolVar(&resumable, "resumable", false, "keep encrypted local copy for cross-process byte resume")
	fs.StringVar(&resumeID, "resume", "", "resume a recorded encrypted upload")
	fs.StringVar(&discardID, "discard", "", "remove a recorded resumable upload and its local copy")
	if wantsHelpFS(fs, args) {
		fmt.Fprint(stdout, upUsage)
		return 0
	}
	if err := parseArgs(fs, args); err != nil {
		return 2
	}
	out := upOutput{stdout: stdout, stderr: stderr, json: asJSON}
	paths := fs.Args()
	if resumeID != "" || discardID != "" {
		if len(paths) != 0 || burn || ttlArg != "" || maxDownloads != 0 || server != "" || pending || recoverID != "" || resumable || (resumeID != "" && discardID != "") {
			fmt.Fprintln(stderr, "up: --resume and --discard take one operation and no upload options")
			return 2
		}
		if discardID != "" {
			return upResume(discardID, configDir, out, true)
		}
		return upResume(resumeID, configDir, out, false)
	}
	if recoverID != "" || pending {
		if len(paths) != 0 || burn || ttlArg != "" || maxDownloads != 0 || server != "" || (recoverID != "" && pending) || resumable {
			fmt.Fprintln(stderr, "up: --recover <id> and --pending take no paths and no upload options")
			return 2
		}
		if pending {
			return upPending(configDir, out)
		}
		return upRecover(recoverID, configDir, out)
	}
	if len(paths) == 0 {
		fmt.Fprintln(stderr, "up needs <path...>")
		return 2
	}
	// A negative limit is a mistake (a script's empty or mistyped variable),
	// not a request: refuse it before credentials, files or the network are
	// touched. 0 is the flag's documented "not set" value, which leaves the
	// download limit to the server's own default policy -- it is NOT a promise
	// of unlimited downloads, and the help says so.
	if maxDownloads < 0 {
		fmt.Fprintf(stderr, "up: --max-downloads must be a positive count (got %d); leave it out, or pass 0, to use the server's default\n", maxDownloads)
		return 2
	}

	cfgDir, err := resolveConfigDir(configDir)
	if err != nil {
		return out.fail("config_dir_unresolved", err)
	}
	creds, ok, err := cloud.Load(cfgDir)
	if err != nil {
		return out.fail("credential_unreadable", err)
	}
	if !ok {
		return out.fail("not_logged_in", errors.New("run `relayium login` first"))
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
		return out.fail("wrong_server", fmt.Errorf("you're logged in to %s — run `relayium login --server %s` before uploading there", creds.Server, server))
	}
	client := cloud.NewClient(creds.Server)
	client.Token = creds.AccessToken
	if server != "" {
		client.Server = server
	}

	// The operation is recorded BEFORE the request: if its answer is lost,
	// `up --recover` can still ask the server about it and rebuild the link.
	prep, err := cloud.PrepareUpload(paths, cloud.UploadOpts{Burn: burn, TTLSeconds: ttlSeconds, MaxDownloads: maxDownloads})
	if err != nil {
		return out.fail("prepare_failed", err)
	}
	op, err := cloud.NewUpOperation(prep, client.Server, creds.AccountEmail, time.Now().Unix())
	if err != nil {
		return out.fail("prepare_failed", err)
	}
	if resumable {
		return upResumable(cfgDir, client, prep, op, out)
	}
	lock, err := cloud.LockUpOperation(cfgDir, op.ID)
	if err != nil {
		return out.fail("record_failed", fmt.Errorf("could not record the upload before sending it, so nothing was sent: %w", err))
	}
	defer lock.Release()
	if err := cloud.SaveUpOperation(cfgDir, op); err != nil {
		_ = cloud.RemoveUpOperation(cfgDir, op.ID)
		return out.fail("record_failed", fmt.Errorf("could not record the upload before sending it, so nothing was sent: %w", err))
	}

	bar := newProgressBar(stderr, "⇡", "Uploading")
	client.Progress = bar.update
	client.Confirming = bar.confirming
	id, expiresAt, err := client.UploadPrepared(context.Background(), prep, op.OpKey)
	bar.finish()
	if err != nil {
		var unknown *cloud.UploadUnconfirmedError
		if errors.As(err, &unknown) {
			// The server may have stored it. Keep the record (and its key).
			return out.unknown(op.ID, err)
		}
		// The request definitely did not store anything (it never completed,
		// or the server refused it): the record has nothing left to recover.
		_ = cloud.RemoveUpOperation(cfgDir, op.ID)
		return out.fail("upload_failed", err)
	}
	return out.uploaded(cfgDir, op, client.DownloadLink(client.Server, id, prep.Key()), id, expiresAt, ttlSeconds)
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
	if wantsHelpFS(fs, args) {
		fmt.Fprint(stdout, downUsage)
		return 0
	}
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
	// "-" reads the link from standard input, so its "#k=" key never appears in
	// this process's argument list (visible to other local users through ps) or
	// in shell history. A directory literally named "-" is still "./-".
	if claim == "-" {
		var err error
		claim, err = readClaimFromStdin(downStdin(), downStdinIsTerminal())
		if err != nil {
			fmt.Fprintln(stderr, "down:", err)
			return 2
		}
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

// maxStdinClaim bounds what `down -` reads. A real link is a few hundred bytes;
// anything near this is not a link, and reading it unbounded would let a
// mistaken pipe (`cat big.iso | relayium down -`) fill memory.
const maxStdinClaim = 8 << 10

// downStdin and downStdinIsTerminal are the standard input `down -` reads,
// indirected so tests can supply one.
var (
	downStdin           = func() io.Reader { return os.Stdin }
	downStdinIsTerminal = func() bool { return isTerminalFile(os.Stdin) }
)

// readClaimFromStdin reads one link or code from r: surrounding whitespace is
// trimmed, and the input must be non-empty, a single line, and under
// maxStdinClaim. Its errors never repeat what was read -- the input is a
// secret.
func readClaimFromStdin(r io.Reader, isTerminal bool) (string, error) {
	if isTerminal {
		return "", errors.New(`"-" reads the link from standard input, which is a terminal here; pipe it in instead, for example: pbpaste | relayium down -`)
	}
	b, err := io.ReadAll(io.LimitReader(r, maxStdinClaim+1))
	if err != nil {
		return "", errors.New("could not read the link from standard input")
	}
	if len(b) > maxStdinClaim {
		return "", fmt.Errorf("standard input is longer than %d bytes, so it is not a link; pipe in only the link", maxStdinClaim)
	}
	claim := strings.TrimSpace(string(b))
	if claim == "" {
		return "", errors.New("standard input was empty; pipe in the link, for example: pbpaste | relayium down -")
	}
	if strings.ContainsAny(claim, "\r\n") {
		return "", errors.New("standard input holds more than one line; pipe in exactly one link")
	}
	return claim, nil
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

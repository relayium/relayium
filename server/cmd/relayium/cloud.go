package main

import (
	"context"
	"flag"
	"fmt"
	"io"
	"strconv"
	"time"

	"github.com/relayium/relayium/internal/cloud"
)

// defaultCloudServer is the first-party account-bound cloud server that
// login/logout/whoami (and, later, up/down) talk to unless --server
// overrides it. Self-hosters point elsewhere with --server.
const defaultCloudServer = "https://relayium.com"

// runLogin drives the CLI device-code login flow: it asks the server for a
// user code + verification URL, prints them so the human can approve in a
// browser, then blocks until approval (or denial/expiry) and persists the
// resulting credentials.
func runLogin(args []string, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet("login", flag.ContinueOnError)
	fs.SetOutput(stderr)
	var server string
	fs.StringVar(&server, "server", defaultCloudServer, "cloud server base URL")
	if err := fs.Parse(args); err != nil {
		return 2
	}

	cfgDir, err := resolveConfigDir("")
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}

	notify := func(start cloud.DeviceStart) {
		fmt.Fprintf(stderr, "打开 %s 输入码: %s\n", start.VerificationURI, start.UserCode)
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

// runLogout clears the locally stored credentials. This is local-only: there
// is no CLI self-revoke endpoint, so the access token on the server remains
// valid until the user deletes the device from the web devices page. That
// keeps logout usable offline and avoids a network round-trip on every
// logout, at the cost of the token staying live server-side until revoked
// through the browser.
func runLogout(args []string, stdout, stderr io.Writer) int {
	cfgDir, err := resolveConfigDir("")
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	if err := cloud.Clear(cfgDir); err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	fmt.Fprintln(stdout, "logged out (local credentials cleared)")
	fmt.Fprintln(stdout, "note: this device's token still works until you delete it from the web devices page")
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

// parseTTL accepts either a Go duration string ("2h", "30m") or a bare
// integer, interpreted as seconds — so `--ttl 3600` and `--ttl 1h` both work.
func parseTTL(s string) (int64, error) {
	if d, err := time.ParseDuration(s); err == nil {
		return int64(d.Seconds()), nil
	}
	n, err := strconv.ParseInt(s, 10, 64)
	if err != nil {
		return 0, fmt.Errorf("invalid --ttl %q: not a duration or a number of seconds", s)
	}
	return n, nil
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
	fs.StringVar(&ttlArg, "ttl", "", "retention, as a duration (2h) or seconds")
	fs.Int64Var(&maxDownloads, "max-downloads", 0, "max number of downloads allowed")
	fs.StringVar(&server, "server", "", "override the cloud server (defaults to the logged-in server)")
	if err := fs.Parse(args); err != nil {
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

	client := cloud.NewClient(creds.Server)
	client.Token = creds.AccessToken
	if server != "" {
		client.Server = server
	}

	id, key, err := client.Upload(context.Background(), paths, cloud.UploadOpts{
		Burn:         burn,
		TTLSeconds:   ttlSeconds,
		MaxDownloads: maxDownloads,
	})
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}

	link := client.DownloadLink(creds.Server, id, key)
	fmt.Fprintln(stdout, link)
	fmt.Fprintln(stdout, "opens in a browser, or fetch it with `relayium down <link>`")
	return 0
}

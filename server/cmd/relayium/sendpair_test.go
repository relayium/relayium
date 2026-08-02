package main

import (
	"bytes"
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/relayium/relayium/internal/cloud"
	"github.com/relayium/relayium/internal/signal"
)

func TestAPIBase(t *testing.T) {
	cases := map[string]string{
		"wss://relayium.com":    "https://relayium.com",
		"ws://localhost:8080":   "http://localhost:8080",
		"https://relayium.com/": "https://relayium.com",
	}
	for in, want := range cases {
		got, err := apiBase(in)
		if err != nil {
			t.Fatalf("apiBase(%q): %v", in, err)
		}
		if got != want {
			t.Errorf("apiBase(%q) = %q, want %q", in, got, want)
		}
	}
}

// The signaling endpoint path — a trailing "/ws" — is stripped, because it is
// an endpoint rather than an origin. `--server ws://host/ws` is a valid
// signaling target (rzvous.Join sets the path itself), but as an API base it
// used to yield "http://host/ws" — which mismatched the stored creds.Server and
// refused to mint, then printed a remedy whose /api/pair would 404.
//
// Every other path is a deployment prefix and survives: a self-hoster at
// https://host/relay has its API under /relay, so flattening to the bare origin
// breaks minting there. Both halves are pinned here because the fix for one is
// the regression for the other.
func TestAPIBaseStripsTheSignalingPathAndKeepsAnyPrefix(t *testing.T) {
	cases := map[string]string{
		// signaling endpoint: stripped
		"ws://host/ws":                   "http://host",
		"wss://relayium.com/ws":          "https://relayium.com",
		"wss://relayium.com/ws/":         "https://relayium.com",
		"wss://relayium.com/ws?code=1#f": "https://relayium.com",
		// sub-path deployment: preserved
		"https://host/relay":              "https://host/relay",
		"wss://host/relay/ws":             "https://host/relay",
		"http://192.168.1.9:8080/signal/": "http://192.168.1.9:8080/signal",
		// no path at all
		"wss://host": "https://host",
	}
	for in, want := range cases {
		got, err := apiBase(in)
		if err != nil {
			t.Fatalf("apiBase(%q): %v", in, err)
		}
		if got != want {
			t.Errorf("apiBase(%q) = %q, want %q", in, got, want)
		}
	}
}

// A value that is not scheme+host is refused here, where we can name it, rather
// than surfacing url.Parse's "first path segment in URL cannot contain colon"
// or, for the empty string, an uncopyable "relayium login --server " remedy.
func TestAPIBaseRejectsUnusableServerURLs(t *testing.T) {
	for _, in := range []string{"", "127.0.0.1:18080", "localhost:8080", "relayium.com", "ftp://relayium.com", "wss://"} {
		got, err := apiBase(in)
		if err == nil {
			t.Errorf("apiBase(%q) = %q, want an error", in, got)
			continue
		}
		msg := err.Error()
		if !strings.Contains(msg, fmt.Sprintf("%q", in)) {
			t.Errorf("apiBase(%q) error %q does not quote what was passed", in, msg)
		}
		if !strings.Contains(msg, "wss://relayium.com") {
			t.Errorf("apiBase(%q) error %q does not show the expected shape", in, msg)
		}
	}
}

// End to end for the path case: a login stored against the plain origin must
// still mint when send is pointed at the same host with the /ws signaling path.
func TestMintCodeAcceptsASignalingURLWithAPath(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"code":"483920","expiresAt":4102444800}`))
	}))
	defer srv.Close()

	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	cfgDir, err := resolveConfigDir("")
	if err != nil {
		t.Fatal(err)
	}
	if err := cloud.Save(cfgDir, cloud.Creds{Server: srv.URL, AccessToken: "rlm_cli_abc"}); err != nil {
		t.Fatal(err)
	}
	var errb bytes.Buffer
	code, err := mintCode(context.Background(), srv.URL+"/ws", &errb, mintForSend)
	if err != nil {
		t.Fatalf("mintCode against the signaling path: %v", err)
	}
	if code != "483920" {
		t.Fatalf("code = %q", code)
	}
}

// End to end for the sub-path case: a self-hoster serving Relayium under
// /relay must still mint, i.e. the request has to land on /relay/api/pair.
// Flattening the API base to the bare origin sends it to /api/pair, which on
// that deployment is not Relayium at all.
func TestMintCodeAcceptsASubPathDeployment(t *testing.T) {
	var gotPath string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		if r.URL.Path != "/relay/api/pair" {
			http.Error(w, "not found", http.StatusNotFound)
			return
		}
		_, _ = w.Write([]byte(`{"code":"483920","expiresAt":4102444800}`))
	}))
	defer srv.Close()

	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	cfgDir, err := resolveConfigDir("")
	if err != nil {
		t.Fatal(err)
	}
	if err := cloud.Save(cfgDir, cloud.Creds{Server: srv.URL + "/relay", AccessToken: "rlm_cli_abc"}); err != nil {
		t.Fatal(err)
	}
	var errb bytes.Buffer
	// The sender passes the signaling URL of that same deployment.
	code, err := mintCode(context.Background(), srv.URL+"/relay/ws", &errb, mintForSend)
	if err != nil {
		t.Fatalf("mintCode against a sub-path deployment: %v (request hit %q)", err, gotPath)
	}
	if code != "483920" {
		t.Fatalf("code = %q", code)
	}
}

// An empty --server must fail on the flag, not slide into the not-logged-in
// copy where it rendered as "run `relayium login --server ` first".
func TestMintCodeRejectsAnEmptyServer(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	var errb bytes.Buffer
	_, err := mintCode(context.Background(), "", &errb, mintForSend)
	if err == nil {
		t.Fatal("want an error for an empty --server")
	}
	msg := err.Error()
	if !strings.Contains(msg, "not a usable server URL") {
		t.Errorf("want the flag error, got %q", msg)
	}
	if strings.Contains(msg, "relayium login") {
		t.Errorf("an empty --server must not print a login remedy with nothing after it: %q", msg)
	}
}

// Minting needs an account, and on a server there is no browser to bounce
// through — so this must fail fast and say what to run, never start a login.
func TestMintCodeNotLoggedIn(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	var errb bytes.Buffer
	_, err := mintCode(context.Background(), "wss://relayium.com", &errb, mintForSend)
	if err == nil {
		t.Fatal("want an error when not logged in")
	}
	for _, want := range []string{"relayium login", "relayium up"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("error %q does not mention %q", err, want)
		}
	}
}

func TestMintCodePrintsHandoffBlock(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer rlm_cli_abc" {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		_, _ = w.Write([]byte(`{"code":"483920","expiresAt":4102444800}`))
	}))
	defer srv.Close()

	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	cfgDir, err := resolveConfigDir("")
	if err != nil {
		t.Fatal(err)
	}
	if err := cloud.Save(cfgDir, cloud.Creds{Server: srv.URL, AccessToken: "rlm_cli_abc", AccountEmail: "a@example.com"}); err != nil {
		t.Fatal(err)
	}

	var errb bytes.Buffer
	code, err := mintCode(context.Background(), srv.URL, &errb, mintForSend)
	if err != nil {
		t.Fatalf("mintCode: %v", err)
	}
	if code != "483920" {
		t.Fatalf("code = %q", code)
	}
	out := errb.String()
	for _, want := range []string{"483920", "relayium receive 483920", "waiting for the receiver"} {
		if !strings.Contains(out, want) {
			t.Errorf("block %q does not contain %q", out, want)
		}
	}
	// A file transfer's hand-off must keep naming `receive`. Now that the block
	// is parameterised so `text` can print its own command, the way to break
	// this is to make the text form the default rather than a second purpose —
	// and the receiving end would run a command whose mode check refuses.
	if strings.Contains(out, "relayium text") {
		t.Errorf("a file hand-off must not point the other end at `relayium text`: %q", out)
	}
	// The install one-liner is first-party only: a self-hosted origin has no
	// install.sh, and this test server is one.
	if strings.Contains(out, "install.sh") {
		t.Errorf("install line should be omitted for a non-default server: %q", out)
	}
}

// The text hand-off is the whole point of minting from `text`: whoever reads it
// has to end up in a message session, and `relayium receive` would put them in a
// file transfer that the mode check refuses only after both people have typed it.
func TestMintCodeForTextHandsOffTheTextCommand(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer rlm_cli_abc" {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		_, _ = w.Write([]byte(`{"code":"483920","expiresAt":4102444800}`))
	}))
	defer srv.Close()

	code, err, out := mintCodeWithCreds(t, srv, mintForText)
	if err != nil {
		t.Fatalf("mintCode for text: %v", err)
	}
	if code != "483920" {
		t.Fatalf("code = %q", code)
	}
	for _, want := range []string{"Code: 483920", "On the other machine:  relayium text 483920", "waiting for the other side to join"} {
		if !strings.Contains(out, want) {
			t.Errorf("text block %q does not contain %q", out, want)
		}
	}
	if strings.Contains(out, "relayium receive") {
		t.Errorf("a message session must never hand off `relayium receive`: %q", out)
	}
	// srv is a self-hosted origin: no install.sh exists there to curl.
	if strings.Contains(out, "install.sh") {
		t.Errorf("install line should be omitted for a non-default server: %q", out)
	}
}

// Logged out, the text remedy has to name the text command. `send`'s copy tells
// the user to pass a code to `relayium send <file> <code>` and offers
// `relayium up` as the browser alternative — neither exists for a message
// session, which is live-only and has no file to upload.
func TestMintCodeForTextNotLoggedInNamesTheTextCommand(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	var errb bytes.Buffer
	_, err := mintCode(context.Background(), "wss://relayium.com", &errb, mintForText)
	if err == nil {
		t.Fatal("want an error when not logged in")
	}
	msg := err.Error()
	for _, want := range []string{"relayium login", "relayium text <code>"} {
		if !strings.Contains(msg, want) {
			t.Errorf("error %q does not mention %q", msg, want)
		}
	}
	for _, unwanted := range []string{"relayium send", "relayium up"} {
		if strings.Contains(msg, unwanted) {
			t.Errorf("the text remedy must not send the user to %q: %q", unwanted, msg)
		}
	}
	if errb.Len() != 0 {
		t.Errorf("nothing should be printed when minting never happened: %q", errb.String())
	}
}

// Self-host: the login remedy must carry --server, or it stores credentials for
// relayium.com and the next mint is refused for the same reason all over again.
func TestMintCodeForTextNotLoggedInAgainstASelfHostedServer(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	var errb bytes.Buffer
	_, err := mintCode(context.Background(), "ws://192.168.1.9:8080/ws", &errb, mintForText)
	if err == nil {
		t.Fatal("want an error when not logged in")
	}
	if !strings.Contains(err.Error(), "relayium login --server http://192.168.1.9:8080") {
		t.Errorf("want a self-host login remedy carrying --server, got %q", err)
	}
}

// The stored access token goes to the server that issued it and nowhere else —
// the same rule `send` follows, restated for text because the refusal lives in
// the shared path and a purpose-specific bypass would be invisible here.
func TestMintCodeForTextRefusesForeignServer(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	cfgDir, err := resolveConfigDir("")
	if err != nil {
		t.Fatal(err)
	}
	if err := cloud.Save(cfgDir, cloud.Creds{Server: "https://relayium.com", AccessToken: "rlm_cli_abc"}); err != nil {
		t.Fatal(err)
	}
	var errb bytes.Buffer
	_, err = mintCode(context.Background(), "wss://someone-elses-host.example", &errb, mintForText)
	if err == nil || !strings.Contains(err.Error(), "logged in to https://relayium.com") {
		t.Fatalf("want a server-mismatch refusal, got %v", err)
	}
}

// The access token authenticates to the server that issued it and nowhere else.
func TestMintCodeRefusesForeignServer(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	cfgDir, err := resolveConfigDir("")
	if err != nil {
		t.Fatal(err)
	}
	if err := cloud.Save(cfgDir, cloud.Creds{Server: "https://relayium.com", AccessToken: "rlm_cli_abc"}); err != nil {
		t.Fatal(err)
	}
	var errb bytes.Buffer
	_, err = mintCode(context.Background(), "wss://someone-elses-host.example", &errb, mintForSend)
	if err == nil || !strings.Contains(err.Error(), "logged in to https://relayium.com") {
		t.Fatalf("want a server-mismatch refusal, got %v", err)
	}
}

// mintCodeWithCreds saves rlm_cli_abc creds pointed at srv, then calls
// mintCode against it for the given purpose. A small helper shared by the
// response-branch tests below so each one only has to state its handler and its
// assertion.
func mintCodeWithCreds(t *testing.T, srv *httptest.Server, p mintPurpose) (string, error, string) {
	t.Helper()
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	cfgDir, err := resolveConfigDir("")
	if err != nil {
		t.Fatal(err)
	}
	if err := cloud.Save(cfgDir, cloud.Creds{Server: srv.URL, AccessToken: "rlm_cli_abc"}); err != nil {
		t.Fatal(err)
	}
	var errb bytes.Buffer
	code, err := mintCode(context.Background(), srv.URL, &errb, p)
	return code, err, errb.String()
}

// A 401 from MintPair means the stored token is no longer good (expired /
// revoked server-side) — this must read exactly like the never-logged-in
// case, not a bare HTTP status.
func TestMintCodeUnauthorized(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "token expired", http.StatusUnauthorized)
	}))
	defer srv.Close()

	_, err, _ := mintCodeWithCreds(t, srv, mintForSend)
	if err == nil {
		t.Fatal("want an error on 401")
	}
	if !strings.Contains(err.Error(), "relayium login") {
		t.Errorf("401 should tell the user to log in again, got %q", err)
	}
}

// A 429 means "you're rate limited," not "you're logged out" — telling a
// rate-limited user to log in again is actively wrong (their credentials are
// fine) and would send them chasing a login flow that won't fix anything.
func TestMintCodeRateLimited(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "too many requests", http.StatusTooManyRequests)
	}))
	defer srv.Close()

	_, err, _ := mintCodeWithCreds(t, srv, mintForSend)
	if err == nil {
		t.Fatal("want an error on 429")
	}
	msg := err.Error()
	if !strings.Contains(msg, "wait") {
		t.Errorf("429 should mention waiting/rate limiting, got %q", msg)
	}
	if strings.Contains(msg, "relayium login") {
		t.Errorf("429 must not tell the user to log in again, got %q", msg)
	}
}

// The TTL line is derived from the server's expiresAt, and Unix() flooring
// plus network latency means a naive "seconds / 60" truncates every code down
// by one minute. 300 s here is a SYNTHETIC expiry chosen because 5 is the
// smallest number that makes the off-by-one obvious — it is not the pairing
// TTL (that is signal.CodeTTLSeconds, and TestTTLClause covers it below). What
// this pins is that the printed minutes follow whatever the server reported.
func TestMintCodeTTLLineForNormalExpiry(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		exp := time.Now().Add(300 * time.Second).Unix()
		fmt.Fprintf(w, `{"code":"483920","expiresAt":%d}`, exp)
	}))
	defer srv.Close()

	_, err, out := mintCodeWithCreds(t, srv, mintForSend)
	if err != nil {
		t.Fatalf("mintCode: %v", err)
	}
	if !strings.Contains(out, "Code: 483920   (valid 5 minutes)") {
		t.Errorf("want the server's 300 s rounded to a 5-minute TTL line, got %q", out)
	}
}

// expiresAt == 0 means an older server that doesn't report an expiry at
// all (see cloud.go's truncatedTTLNotice). There is nothing to derive a
// minute count from, so the clause must be omitted rather than guessed —
// printing "valid 1 minutes" for a code that's actually good for five would
// be worse than saying nothing.
func TestMintCodeOmitsTTLClauseWhenServerDoesNotReportExpiry(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"code":"483920"}`))
	}))
	defer srv.Close()

	_, err, out := mintCodeWithCreds(t, srv, mintForSend)
	if err != nil {
		t.Fatalf("mintCode: %v", err)
	}
	if strings.Contains(out, "valid") {
		t.Errorf("want no TTL clause when expiresAt is unreported, got %q", out)
	}
	if !strings.Contains(out, "Code: 483920\n") {
		t.Errorf("want the bare code line, got %q", out)
	}
}

// Direct unit coverage of the rounding/singular/omission rules, without the
// network round trip — fast and exhaustive over edge cases the higher-level
// tests above don't each need to restate. The synthetic expiries below exist
// to exercise the arithmetic; the one case that is about the PRODUCT is the
// signal.CodeTTLSeconds one, which is what the CLI actually prints in the
// hand-off block and what the docs and web copy have to agree with.
func TestTTLClause(t *testing.T) {
	now := time.Now()
	cases := []struct {
		name      string
		expiresAt int64
		want      string
	}{
		{"zero means unreported, omit entirely", 0, ""},
		{"synthetic 600s rounds to 10 minutes, not truncated to 9", now.Add(600 * time.Second).Unix(), "   (valid 10 minutes)"},
		{
			"a code minted at the real pairing TTL prints 5 minutes",
			now.Add(time.Duration(signal.CodeTTLSeconds) * time.Second).Unix(),
			"   (valid 5 minutes)",
		},
		{"under a minute clamps to a singular minute", now.Add(10 * time.Second).Unix(), "   (valid 1 minute)"},
		{"already expired still clamps to a singular minute", now.Add(-10 * time.Second).Unix(), "   (valid 1 minute)"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := ttlClause(tc.expiresAt); got != tc.want {
				t.Errorf("ttlClause(%d) = %q, want %q", tc.expiresAt, got, tc.want)
			}
		})
	}
}

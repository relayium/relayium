package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/relayium/relayium/internal/devicelabel"
)

// `relayium login` registers an account-visible label for this machine
// (DECISION-LOG 2026-08-04). The requirement is not only that a label is sent:
// it is that the terminal prints the EXACT label the account will show, before
// the user approves anything. A printed label that differs from the stored one
// would be worse than none — it is the string they will later use to decide
// which device to revoke.

// loginStub is a device-code server that approves immediately and records the
// device_name each start request carried.
func loginStub(t *testing.T) (*httptest.Server, *string) {
	t.Helper()
	var sent string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/api/cli/device/start":
			var in struct {
				DeviceName string `json:"device_name"`
			}
			_ = json.NewDecoder(r.Body).Decode(&in)
			sent = in.DeviceName
			json.NewEncoder(w).Encode(map[string]any{
				"user_code": "AAAA-BBBB", "device_code": "dc",
				"verification_uri": "http://x/device", "interval": 0, "expires_in": 60,
			})
		case "/api/cli/device/poll":
			json.NewEncoder(w).Encode(map[string]any{
				"status": "ok", "access_token": "rlm_cli_t", "account_email": "login@example.com",
			})
		}
	}))
	t.Cleanup(srv.Close)
	return srv, &sent
}

func TestLoginSendsAndPrintsExplicitDeviceName(t *testing.T) {
	srv, sent := loginStub(t)
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())

	var out, errOut bytes.Buffer
	if code := runLogin([]string{"--server", srv.URL, "--device-name", "prod-backup-1"}, &out, &errOut); code != 0 {
		t.Fatalf("code=%d stderr=%q", code, errOut.String())
	}
	if *sent != "prod-backup-1" {
		t.Fatalf("start carried device_name=%q, want prod-backup-1", *sent)
	}
	if !strings.Contains(errOut.String(), "prod-backup-1") {
		t.Fatalf("the terminal never showed the label it registered: %q", errOut.String())
	}
}

func TestLoginDefaultsToTheHostname(t *testing.T) {
	srv, sent := loginStub(t)
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	// A hostname carrying the DNS root dot and characters the label rules strip:
	// what gets sent must be the sanitized form, and it must be what was printed.
	restore := osHostname
	osHostname = func() (string, error) { return "web-01.internal\u0007.example.com.", nil }
	t.Cleanup(func() { osHostname = restore })

	var out, errOut bytes.Buffer
	if code := runLogin([]string{"--server", srv.URL}, &out, &errOut); code != 0 {
		t.Fatalf("code=%d stderr=%q", code, errOut.String())
	}
	const want = "web-01.internal.example.com"
	if *sent != want {
		t.Fatalf("start carried device_name=%q, want %q", *sent, want)
	}
	if !strings.Contains(errOut.String(), want) {
		t.Fatalf("terminal did not print the default label: %q", errOut.String())
	}
	// The printed label and the sent label are the same string, which is the
	// property the whole feature rests on.
	if !strings.Contains(errOut.String(), *sent) {
		t.Fatalf("printed label and sent label differ: printed %q, sent %q", errOut.String(), *sent)
	}
}

func TestLoginSurvivesHostnameLookupFailure(t *testing.T) {
	// A container with no UTS name, a stripped environment. Login must still
	// work, and the device must still have a name somebody can read.
	srv, sent := loginStub(t)
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	restore := osHostname
	osHostname = func() (string, error) { return "", errors.New("no hostname") }
	t.Cleanup(func() { osHostname = restore })

	var out, errOut bytes.Buffer
	if code := runLogin([]string{"--server", srv.URL}, &out, &errOut); code != 0 {
		t.Fatalf("a machine that cannot name itself must still be able to log in; code=%d stderr=%q", code, errOut.String())
	}
	if *sent != devicelabel.Fallback {
		t.Fatalf("start carried device_name=%q, want %q", *sent, devicelabel.Fallback)
	}
	if !strings.Contains(errOut.String(), devicelabel.Fallback) {
		t.Fatalf("terminal did not print the fallback label: %q", errOut.String())
	}
}

func TestLoginFallsBackWhenHostnameIsUnusable(t *testing.T) {
	// A hostname made entirely of characters the rules strip would otherwise
	// send an empty label and produce a nameless-looking row.
	srv, sent := loginStub(t)
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	restore := osHostname
	osHostname = func() (string, error) { return "\u200B\u0000 ", nil }
	t.Cleanup(func() { osHostname = restore })

	var out, errOut bytes.Buffer
	if code := runLogin([]string{"--server", srv.URL}, &out, &errOut); code != 0 {
		t.Fatalf("code=%d stderr=%q", code, errOut.String())
	}
	if *sent != devicelabel.Fallback {
		t.Fatalf("start carried device_name=%q, want %q", *sent, devicelabel.Fallback)
	}
}

func TestLoginRefusesAnExplicitLabelThatSanitizesAway(t *testing.T) {
	// Silently substituting the hostname here would put a machine in the
	// account under a name the user did not choose, having asked for one.
	srv, sent := loginStub(t)
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())

	var out, errOut bytes.Buffer
	code := runLogin([]string{"--server", srv.URL, "--device-name", "\u202E\u200B"}, &out, &errOut)
	if code != 2 {
		t.Fatalf("code=%d, want 2 (usage error); stderr=%q", code, errOut.String())
	}
	if *sent != "" {
		t.Fatalf("a refused label still started a login carrying %q", *sent)
	}
	if !strings.Contains(errOut.String(), "device-name") {
		t.Fatalf("the error does not say which flag was wrong: %q", errOut.String())
	}
}

func TestLoginSanitizesAnExplicitLabelBeforeSending(t *testing.T) {
	// Partly-usable input is cleaned rather than refused, and the cleaned form
	// is what gets printed — the terminal never shows a label the account will
	// not have.
	srv, sent := loginStub(t)
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())

	var out, errOut bytes.Buffer
	if code := runLogin([]string{"--server", srv.URL, "--device-name", "  office\u202E   NAS  "}, &out, &errOut); code != 0 {
		t.Fatalf("code=%d stderr=%q", code, errOut.String())
	}
	const want = "office NAS"
	if *sent != want {
		t.Fatalf("start carried device_name=%q, want %q", *sent, want)
	}
	if !strings.Contains(errOut.String(), want) {
		t.Fatalf("terminal did not print the sanitized label: %q", errOut.String())
	}
}

func TestLoginTellsTheUserHowToChooseALabel(t *testing.T) {
	// Discoverability: the flag is worthless if the only place it appears is
	// `--help`. The one moment a user is thinking about what this machine is
	// called is while they are approving it.
	srv, _ := loginStub(t)
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())

	var out, errOut bytes.Buffer
	if code := runLogin([]string{"--server", srv.URL}, &out, &errOut); code != 0 {
		t.Fatalf("code=%d stderr=%q", code, errOut.String())
	}
	if !strings.Contains(errOut.String(), "--device-name") {
		t.Fatalf("login never mentions --device-name: %q", errOut.String())
	}
	if !strings.Contains(errOut.String(), "My Devices") {
		t.Fatalf("login never says where the label will appear: %q", errOut.String())
	}
}

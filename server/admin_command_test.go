package main

import (
	"flag"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/relayium/relayium/account"
)

func TestResolveAdminEnabled(t *testing.T) {
	cases := []struct {
		explicit         string
		legacyPass, totp bool
		want             bool
		wantErr          bool
		notes            []string // substrings expected across the notes
	}{
		{"", false, false, false, false, nil},                                                    // off by default
		{"", true, false, true, false, []string{"deprecated RELAYIUM_ADMIN_PASS", "NEVER used"}}, // legacy enablement hint only
		{"true", false, false, true, false, nil},
		{"TRUE", true, false, true, false, []string{"RELAYIUM_ADMIN_PASS is set but ignored"}},
		{"false", true, false, false, false, nil}, // explicit off beats the legacy hint
		{"0", false, true, false, false, []string{"RELAYIUM_ADMIN_TOTP_SECRET is set but ignored"}},
		{"maybe", false, false, false, true, nil},
	}
	for _, c := range cases {
		got, notes, err := resolveAdminEnabled(c.explicit, c.legacyPass, c.totp)
		if (err != nil) != c.wantErr {
			t.Fatalf("%+v: err=%v", c, err)
		}
		if err == nil && got != c.want {
			t.Fatalf("%+v: enabled=%v", c, got)
		}
		joined := strings.Join(notes, "\n")
		for _, n := range c.notes {
			if !strings.Contains(joined, n) {
				t.Fatalf("%+v: notes %q missing %q", c, joined, n)
			}
		}
	}
}

// An invalid legacy TOTP secret no longer affects boot: it is never parsed.
func TestInvalidLegacyTOTPSecretDoesNotFailResolution(t *testing.T) {
	if _, _, err := resolveAdminEnabled("true", false, true); err != nil {
		t.Fatalf("legacy TOTP secret must be ignored, got %v", err)
	}
}

// TestAdminDispatchHelperProcess is not a test on its own: when re-executed by
// TestAdminSubcommandRunsBeforeServerConfig it runs the real main().
func TestAdminDispatchHelperProcess(t *testing.T) {
	if os.Getenv("RELAYIUM_TEST_MAIN_ARGS") == "" {
		t.Skip("helper process")
	}
	os.Args = append([]string{"relayium-server"}, strings.Split(os.Getenv("RELAYIUM_TEST_MAIN_ARGS"), "\x1f")...)
	main()
}

// `relayium-server admin ...` is dispatched before the .env file, flag
// parsing and every config check: a deliberately broken server config (bad
// env file, contradictory billing settings, invalid admin switch) does not
// stop it, and no server startup log line is printed.
func TestAdminSubcommandRunsBeforeServerConfig(t *testing.T) {
	dir := t.TempDir()
	db := filepath.Join(dir, "relayium.db")
	st, err := account.OpenSQLite(db)
	if err != nil {
		t.Fatal(err)
	}
	st.Close()
	envFile := filepath.Join(dir, "broken.env")
	if err := os.WriteFile(envFile, []byte("RELAYIUM_STRIPE_SECRET_KEY=sk_test_x\nRELAYIUM_ADMIN_ENABLED=garbage\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(os.Args[0], "-test.run=^TestAdminDispatchHelperProcess$")
	cmd.Env = append(os.Environ(),
		"RELAYIUM_TEST_MAIN_ARGS="+strings.Join([]string{"admin", "--db", db, "status"}, "\x1f"),
		"RELAYIUM_ENV_FILE="+envFile,
		"RELAYIUM_ADMIN_ENABLED=garbage",
	)
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("admin status via main(): %v\n%s", err, out)
	}
	s := string(out)
	if !strings.Contains(s, "admin passkeys:    0") {
		t.Fatalf("admin command did not run: %s", s)
	}
	for _, bootLine := range []string{"mail:", "RELAYIUM_STRIPE_PORTAL_CONFIG", "invalid RELAYIUM_ADMIN_ENABLED", "listening"} {
		if strings.Contains(s, bootLine) {
			t.Fatalf("server boot ran before the admin command (%q): %s", bootLine, s)
		}
	}
}

// TestRootHelpHelperProcess runs main() with -h when re-executed.
func TestRootHelpHelperProcess(t *testing.T) {
	if os.Getenv("RELAYIUM_TEST_ROOT_HELP") == "" {
		t.Skip("helper process")
	}
	os.Args = []string{"relayium-server", "-h"}
	main()
}

// secretHelpEnv maps every env var behind a secret-bearing flag to a
// synthetic marker. No real secret is ever used.
var secretHelpEnv = map[string]string{
	"RELAYIUM_ADMIN_PASS":            "SYNTHETIC-LEGACY-PASS-7f3a91",
	"RELAYIUM_ADMIN_TOTP_SECRET":     "SYNTHETICLEGACYTOTP4Q2ZK",
	"RELAYIUM_SMTP_PASS":             "SYNTHETIC-SMTP-PASS-11aa",
	"RELAYIUM_GOOGLE_SECRET":         "SYNTHETIC-GOOGLE-SECRET-22bb",
	"RELAYIUM_TURN_SECRET":           "SYNTHETIC-TURN-SECRET-33cc",
	"RELAYIUM_TURN_RELAYS":           `[{"id":"x","urls":["turn:x:3478"],"secret":"SYNTHETIC-RELAY-SECRET-44dd"}]`,
	"RELAYIUM_NODE_TOKEN":            "SYNTHETIC-NODE-TOKEN-55ee",
	"RELAYIUM_STRIPE_SECRET_KEY":     "sk_test_SYNTHETIC66ff",
	"RELAYIUM_STRIPE_WEBHOOK_SECRET": "whsec_SYNTHETIC77aa",
	"RELAYIUM_BILLING_HOLD_SECRET":   "SYNTHETIC-HOLD-SECRET-88bb",
	"RELAYIUM_REDIS_ADDR":            "redis://user:SYNTHETIC-REDIS-PASS-99cc@localhost:6379",
}

// secretHelpMarkers are the substrings that must never appear in -h output.
var secretHelpMarkers = []string{
	"SYNTHETIC-LEGACY-PASS-7f3a91", "SYNTHETICLEGACYTOTP4Q2ZK", "SYNTHETIC-SMTP-PASS-11aa",
	"SYNTHETIC-GOOGLE-SECRET-22bb", "SYNTHETIC-TURN-SECRET-33cc", "SYNTHETIC-RELAY-SECRET-44dd",
	"SYNTHETIC-NODE-TOKEN-55ee", "SYNTHETIC66ff", "SYNTHETIC77aa", "SYNTHETIC-HOLD-SECRET-88bb",
	"SYNTHETIC-REDIS-PASS-99cc",
}

func rootHelp(t *testing.T, env []string) string {
	t.Helper()
	var base []string
	for _, kv := range os.Environ() {
		if !strings.HasPrefix(kv, "RELAYIUM_") {
			base = append(base, kv)
		}
	}
	cmd := exec.Command(os.Args[0], "-test.run=^TestRootHelpHelperProcess$")
	cmd.Env = append(append(base, "RELAYIUM_TEST_ROOT_HELP=1"), env...)
	out, _ := cmd.CombinedOutput() // -h exits non-zero; only the text matters
	s := string(out)
	if !strings.Contains(s, "-admin-pass") || !strings.Contains(s, "-stripe-secret-key") {
		t.Fatalf("help output does not list the expected flags (did the helper run?):\n%s", s)
	}
	return s
}

// R5 and its siblings: `relayium-server -h` must never print a credential
// carried by an environment-derived flag default — from the real environment
// or from the .env file. Useful public defaults stay visible.
func TestRootHelpNeverPrintsSecretDefaults(t *testing.T) {
	dir := t.TempDir()
	var dotenv strings.Builder
	var realEnv []string
	for k, v := range secretHelpEnv {
		dotenv.WriteString(k + "=" + v + "\n")
		realEnv = append(realEnv, k+"="+v)
	}
	envFile := filepath.Join(dir, "secrets.env")
	if err := os.WriteFile(envFile, []byte(dotenv.String()), 0o600); err != nil {
		t.Fatal(err)
	}
	for name, env := range map[string][]string{
		"real env": append(realEnv, "RELAYIUM_ENV_FILE="+filepath.Join(dir, "none.env")),
		".env":     {"RELAYIUM_ENV_FILE=" + envFile},
	} {
		out := rootHelp(t, env)
		for _, m := range secretHelpMarkers {
			if strings.Contains(out, m) {
				t.Fatalf("%s: -h printed secret marker %q", name, m)
			}
		}
		// Non-secret defaults are still shown (the redaction is an allowlist).
		if !strings.Contains(out, `(default ":8080")`) || !strings.Contains(out, `(default "relayium.db")`) {
			t.Fatalf("%s: -h lost public defaults:\n%s", name, out)
		}
	}
}

// Every name in the redaction allowlist is a real flag: a typo would silently
// leave a secret visible.
func TestSecretBearingFlagsAllExist(t *testing.T) {
	out := rootHelp(t, nil)
	for _, name := range secretBearingFlags {
		if !strings.Contains(out, "-"+name+" ") && !strings.Contains(out, "-"+name+"\n") {
			t.Fatalf("secretBearingFlags names %q, which -h does not list", name)
		}
	}
}

// The redaction touches display metadata only: the value the server uses,
// and an explicit command-line override, are byte-identical.
func TestRedactSecretFlagDefaultsKeepsValues(t *testing.T) {
	const envValue = "SYNTHETIC-VALUE-FROM-ENV"
	fs := flag.NewFlagSet("t", flag.ContinueOnError)
	smtp := fs.String("smtp-pass", envValue, "")
	relays := fs.String("turn-relays", `[{"secret":"`+envValue+`"}]`, "")
	addr := fs.String("addr", ":8080", "")
	redactSecretFlagDefaults(fs)
	if fs.Lookup("smtp-pass").DefValue != "" || fs.Lookup("turn-relays").DefValue != "" {
		t.Fatal("secret DefValue not hidden")
	}
	if fs.Lookup("addr").DefValue != ":8080" {
		t.Fatal("a non-secret default was hidden")
	}
	if err := fs.Parse(nil); err != nil {
		t.Fatal(err)
	}
	if *smtp != envValue || *relays != `[{"secret":"`+envValue+`"}]` || *addr != ":8080" {
		t.Fatalf("redaction changed runtime values: %q %q %q", *smtp, *relays, *addr)
	}
	fs2 := flag.NewFlagSet("t2", flag.ContinueOnError)
	smtp2 := fs2.String("smtp-pass", envValue, "")
	redactSecretFlagDefaults(fs2)
	if err := fs2.Parse([]string{"-smtp-pass=explicit"}); err != nil || *smtp2 != "explicit" {
		t.Fatalf("explicit override lost: %q %v", *smtp2, err)
	}
}

func TestLegacyAdminSecretsSetReportsPresenceOnly(t *testing.T) {
	t.Setenv("RELAYIUM_ADMIN_PASS", "")
	t.Setenv("RELAYIUM_ADMIN_TOTP_SECRET", "")
	if p, o := legacyAdminSecretsSet("", ""); p || o {
		t.Fatal("nothing set must report nothing")
	}
	if p, _ := legacyAdminSecretsSet("explicit-flag", ""); !p {
		t.Fatal("an explicit deprecated -admin-pass is still an enablement hint")
	}
	t.Setenv("RELAYIUM_ADMIN_PASS", "x")
	t.Setenv("RELAYIUM_ADMIN_TOTP_SECRET", "y")
	if p, o := legacyAdminSecretsSet("", ""); !p || !o {
		t.Fatal("env presence not detected")
	}
}

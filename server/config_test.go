package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestLoadDotEnvSetsOnlyUnsetKeys(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, ".env")
	content := "" +
		"# a comment\n" +
		"\n" +
		"RELAYIUM_ADMIN_PASS=secret123\n" +
		"RELAYIUM_BASE_URL = https://relayium.com \n" +
		"RELAYIUM_QUOTED=\"quoted value\"\n" +
		"RELAYIUM_SINGLE='single quoted'\n" +
		"RELAYIUM_PREEXISTING=from-file\n" +
		"NO_EQUALS_LINE\n"
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}

	// A real env var must win over the .env file.
	t.Setenv("RELAYIUM_PREEXISTING", "from-env")
	// Ensure target keys start unset.
	for _, k := range []string{"RELAYIUM_ADMIN_PASS", "RELAYIUM_BASE_URL", "RELAYIUM_QUOTED", "RELAYIUM_SINGLE"} {
		os.Unsetenv(k)
	}

	if err := loadDotEnv(path); err != nil {
		t.Fatalf("loadDotEnv: %v", err)
	}

	cases := map[string]string{
		"RELAYIUM_ADMIN_PASS":  "secret123",
		"RELAYIUM_BASE_URL":    "https://relayium.com", // trimmed around key and value
		"RELAYIUM_QUOTED":      "quoted value",         // surrounding double quotes stripped
		"RELAYIUM_SINGLE":      "single quoted",        // surrounding single quotes stripped
		"RELAYIUM_PREEXISTING": "from-env",             // real env wins, file ignored
	}
	for k, want := range cases {
		if got := os.Getenv(k); got != want {
			t.Errorf("%s = %q, want %q", k, got, want)
		}
	}
}

func TestLoadDotEnvMissingFileIsNoError(t *testing.T) {
	if err := loadDotEnv(filepath.Join(t.TempDir(), "does-not-exist.env")); err != nil {
		t.Fatalf("missing file should be nil error, got %v", err)
	}
}

func TestEnvStrFallback(t *testing.T) {
	os.Unsetenv("RELAYIUM_TEST_STR")
	if got := envStr("RELAYIUM_TEST_STR", "def"); got != "def" {
		t.Errorf("unset: got %q, want def", got)
	}
	t.Setenv("RELAYIUM_TEST_STR", "set")
	if got := envStr("RELAYIUM_TEST_STR", "def"); got != "set" {
		t.Errorf("set: got %q, want set", got)
	}
	// An explicitly empty env var is still a deliberate value, not the default.
	t.Setenv("RELAYIUM_TEST_STR", "")
	if got := envStr("RELAYIUM_TEST_STR", "def"); got != "" {
		t.Errorf("empty set: got %q, want empty", got)
	}
}

func TestEnvBoolFallback(t *testing.T) {
	os.Unsetenv("RELAYIUM_TEST_BOOL")
	if envBool("RELAYIUM_TEST_BOOL", false) {
		t.Error("unset should return default false")
	}
	t.Setenv("RELAYIUM_TEST_BOOL", "true")
	if !envBool("RELAYIUM_TEST_BOOL", false) {
		t.Error("\"true\" should parse to true")
	}
	t.Setenv("RELAYIUM_TEST_BOOL", "1")
	if !envBool("RELAYIUM_TEST_BOOL", false) {
		t.Error("\"1\" should parse to true")
	}
	// Unparseable value falls back to the default rather than panicking.
	t.Setenv("RELAYIUM_TEST_BOOL", "yesplease")
	if !envBool("RELAYIUM_TEST_BOOL", true) {
		t.Error("garbage should fall back to default true")
	}
}

func TestEnvInt64Fallback(t *testing.T) {
	os.Unsetenv("RELAYIUM_TEST_INT")
	if got := envInt64("RELAYIUM_TEST_INT", 42); got != 42 {
		t.Errorf("unset: got %d, want 42", got)
	}
	t.Setenv("RELAYIUM_TEST_INT", "100")
	if got := envInt64("RELAYIUM_TEST_INT", 42); got != 100 {
		t.Errorf("set: got %d, want 100", got)
	}
	// Unparseable → default.
	t.Setenv("RELAYIUM_TEST_INT", "notanumber")
	if got := envInt64("RELAYIUM_TEST_INT", 42); got != 42 {
		t.Errorf("garbage: got %d, want 42", got)
	}
}

package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// A config file is this program's only input and it starts a process from it,
// so every one of these is a refusal that must survive. They run on any host:
// none of them needs a job object, and the validation is exactly the part that
// must not be Windows-only.

func writeConfig(t *testing.T, body string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "config.json")
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatalf("could not write the config: %v", err)
	}
	return path
}

// An executable that exists, for the cases that are testing something else.
func realExecutable(t *testing.T) string {
	t.Helper()
	path, err := os.Executable()
	if err != nil {
		t.Fatalf("could not find this test binary: %v", err)
	}
	return path
}

func TestLoadConfigAcceptsAValidatedConfig(t *testing.T) {
	exe := realExecutable(t)
	cfg, err := LoadConfig(writeConfig(t, `{"purpose":"self-test","executable":`+quote(exe)+`,"args":["--one"]}`))
	if err != nil {
		t.Fatalf("a valid config was refused: %v", err)
	}
	if cfg.Executable != exe || len(cfg.Args) != 1 {
		t.Fatalf("the config did not survive the round trip: %+v", cfg)
	}
	// Defaults are applied rather than left as a zero budget that would make
	// every wait return immediately and report an empty job.
	if cfg.JoinBudgetMs != defaultJoinMs || cfg.TerminateBudgetMs != defaultKillMs {
		t.Fatalf("budgets were not defaulted: %+v", cfg)
	}
}

func TestLoadConfigRefusesMalformedJSON(t *testing.T) {
	_, err := LoadConfig(writeConfig(t, `{"purpose":`))
	if err == nil || !strings.Contains(err.Error(), "malformed config") {
		t.Fatalf("truncated JSON was not refused as malformed: %v", err)
	}
}

func TestLoadConfigRefusesAnUnknownField(t *testing.T) {
	exe := realExecutable(t)
	_, err := LoadConfig(writeConfig(t,
		`{"purpose":"self-test","executable":`+quote(exe)+`,"killEverything":true}`))
	if err == nil {
		t.Fatal("a config carrying a field this program does not understand was accepted")
	}
}

func TestLoadConfigRefusesAMissingFile(t *testing.T) {
	_, err := LoadConfig(filepath.Join(t.TempDir(), "absent.json"))
	if err == nil || !strings.Contains(err.Error(), "unreadable config") {
		t.Fatalf("an absent config was not refused: %v", err)
	}
}

func TestValidateRefusesAnUnknownPurpose(t *testing.T) {
	cfg := Config{Purpose: "whatever", Executable: realExecutable(t)}
	if err := cfg.Validate(); err == nil {
		t.Fatal("a config with no recognised purpose was accepted; a stray file could drive a launcher")
	}
}

func TestValidateRefusesARelativeExecutable(t *testing.T) {
	cfg := Config{Purpose: "self-test", Executable: "chrome.exe"}
	err := cfg.Validate()
	if err == nil || !strings.Contains(err.Error(), "absolute") {
		t.Fatalf("a relative executable was not refused: %v", err)
	}
}

func TestValidateRefusesAnExecutableThatIsNotThere(t *testing.T) {
	cfg := Config{Purpose: "self-test", Executable: filepath.Join(t.TempDir(), "absent")}
	if err := cfg.Validate(); err == nil {
		t.Fatal("an executable that does not exist was accepted")
	}
}

func TestValidateRefusesADirectoryAsAnExecutable(t *testing.T) {
	cfg := Config{Purpose: "self-test", Executable: t.TempDir()}
	err := cfg.Validate()
	if err == nil || !strings.Contains(err.Error(), "regular file") {
		t.Fatalf("a directory was not refused as an executable: %v", err)
	}
}

func TestValidateRefusesEmbeddedNULs(t *testing.T) {
	cfg := Config{Purpose: "self-test", Executable: realExecutable(t), Args: []string{"a\x00b"}}
	err := cfg.Validate()
	if err == nil || !strings.Contains(err.Error(), "NUL") {
		t.Fatalf("an argument carrying a NUL byte was not refused: %v", err)
	}
}

func TestValidateBoundsTheArgumentList(t *testing.T) {
	args := make([]string, maxArgs+1)
	cfg := Config{Purpose: "self-test", Executable: realExecutable(t), Args: args}
	if err := cfg.Validate(); err == nil {
		t.Fatalf("an argument list of %d was accepted over the bound of %d", len(args), maxArgs)
	}
}

func TestValidateBoundsBudgets(t *testing.T) {
	exe := realExecutable(t)
	for _, cfg := range []Config{
		{Purpose: "self-test", Executable: exe, JoinBudgetMs: 1},
		{Purpose: "self-test", Executable: exe, TerminateBudgetMs: maxBudgetMs + 1},
	} {
		if err := cfg.Validate(); err == nil {
			t.Fatalf("an out-of-range budget was accepted: %+v", cfg)
		}
	}
}

func TestValidateRefusesAWorkingDirectoryThatIsAFile(t *testing.T) {
	exe := realExecutable(t)
	cfg := Config{Purpose: "self-test", Executable: exe, WorkingDirectory: exe}
	err := cfg.Validate()
	if err == nil || !strings.Contains(err.Error(), "not a directory") {
		t.Fatalf("a file was accepted as a working directory: %v", err)
	}
}

func quote(s string) string {
	out := strings.ReplaceAll(s, `\`, `\\`)
	return `"` + strings.ReplaceAll(out, `"`, `\"`) + `"`
}

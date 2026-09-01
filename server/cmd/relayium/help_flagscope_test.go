package main

import (
	"bytes"
	"strings"
	"testing"
)

// ── the top-level flag table, checked against the binary that has to honour it ─
//
// The shared-flag table in `usage` is the only place a person is told which
// commands a flag reaches, and it was wrong: it scoped --verify to "send, text"
// (receive takes it too, and a receiver who skips it skips the whole point of
// the SAS) and described --config-dir as "supported subcommands", which names
// nothing. Prose drifts silently, so both halves are asserted here: the table's
// "→" lines are parsed out of the real usage string, and the set of commands
// that actually accept each flag is probed through the real dispatcher.

// flagProbe is how a flag is written on a command line: the spelling, plus a
// value token for the flags that take one.
var flagProbe = map[string][]string{
	"-i":           {"-i", "/nonexistent/key"},
	"-p":           {"-p", "2222"},
	"--no-resume":  {"--no-resume"},
	"--verify":     {"--verify"},
	"--yes":        {"--yes"},
	"--config-dir": {"--config-dir", "/nonexistent/config"},
}

// acceptedButUndocumented is the one gap between "accepts" and "does something",
// recorded rather than papered over. pull shares push's FlagSet, so it parses
// --config-dir and ignores it: it has no relayium:// path and reads no identity
// or trust directory. `relayium pull -h` says so. Listing pull in the top-level
// table instead would be the lie this test exists to prevent.
var acceptedButUndocumented = map[string]map[string]string{
	"--config-dir": {"pull": "shares push's FlagSet; parsed and ignored (see pullUsage)"},
}

// flagParsingCommands is every command path that reaches a FlagSet. `whoami`
// and `version` take no flags at all and never parse, so the probe below cannot
// speak about them; TestFlagFreeCommandsTakeNoSharedFlags covers them instead.
func flagParsingCommands() [][]string {
	paths := [][]string{
		{"push"}, {"pull"}, {"sync"}, {"send"}, {"receive"}, {"text"},
		{"serve"}, {"id"}, {"authorize"}, {"login"}, {"logout"},
		{"up"}, {"down"}, {"update"},
	}
	for _, sub := range inboxSubcommands {
		paths = append(paths, []string{"inbox", sub.name})
	}
	return paths
}

// commandAcceptsFlag reports whether cmd's FlagSet declares flag, without
// letting the command run.
//
// The probe is the flag followed by a sentinel that is undefined everywhere. If
// the flag under test is also undefined, the flag package names IT (it reports
// the first undefined flag it reaches); if the flag is defined, it names the
// sentinel. Either way parsing fails, so nothing dials a server, binds a port,
// reads a credential or writes a file — which is what makes it safe to run this
// against `login` and `serve`.
func commandAcceptsFlag(t *testing.T, cmd []string, flag string) bool {
	t.Helper()
	const sentinel = "--zzz-undefined-everywhere"
	args := append(append([]string{}, cmd...), flagProbe[flag]...)
	args = append(args, sentinel)

	var stdout, stderr bytes.Buffer
	rc := Run(args, &stdout, &stderr)
	if rc != 2 {
		t.Fatalf("`relayium %s`: rc = %d, want 2 (an undefined flag must be a usage error)\nstdout: %s\nstderr: %s",
			strings.Join(args, " "), rc, stdout.String(), stderr.String())
	}
	// Go's flag package prints the name without its leading dashes doubled:
	// "flag provided but not defined: -config-dir".
	bare := "-" + strings.TrimLeft(flag, "-")
	msg := stderr.String()
	switch {
	case strings.Contains(msg, "not defined: "+bare):
		return false
	case strings.Contains(msg, "not defined: -zzz-undefined-everywhere"):
		return true
	default:
		t.Fatalf("`relayium %s`: could not tell whether %s is defined from stderr: %q",
			strings.Join(args, " "), flag, msg)
		return false
	}
}

// documentedFlagScopes parses the "→" lines out of the real usage text, so the
// expectation below is the text a user reads rather than a copy of it.
func documentedFlagScopes(t *testing.T) map[string][]string {
	t.Helper()
	scopes := map[string][]string{}
	var current string
	for _, line := range strings.Split(usage, "\n") {
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(line, "  -") && !strings.HasPrefix(trimmed, "→") {
			current = strings.Fields(trimmed)[0]
			continue
		}
		if !strings.HasPrefix(trimmed, "→") {
			continue
		}
		if current == "" {
			t.Fatalf("usage has a scope line with no flag above it: %q", line)
		}
		for _, name := range strings.Split(strings.TrimPrefix(trimmed, "→"), ",") {
			name = strings.TrimSpace(name)
			if name == "inbox <any subcommand>" {
				for _, sub := range inboxSubcommands {
					scopes[current] = append(scopes[current], "inbox "+sub.name)
				}
				continue
			}
			scopes[current] = append(scopes[current], name)
		}
		current = ""
	}
	return scopes
}

// The table must name every shared flag, and only the shared flags.
func TestTopLevelFlagTableListsTheSharedFlags(t *testing.T) {
	scopes := documentedFlagScopes(t)
	if len(scopes) != len(flagProbe) {
		t.Fatalf("usage documents %d shared flags (%v), the probe knows %d", len(scopes), keysOf(scopes), len(flagProbe))
	}
	for flag := range flagProbe {
		if _, ok := scopes[flag]; !ok {
			t.Errorf("the top-level flag table has no scope line for %s", flag)
		}
	}
}

// Each "→" line must be exactly the set of commands that accepts the flag.
func TestTopLevelFlagScopesMatchTheCommands(t *testing.T) {
	isolatedEnv(t)
	scopes := documentedFlagScopes(t)

	for flag := range flagProbe {
		flag := flag
		t.Run(flag, func(t *testing.T) {
			documented := map[string]bool{}
			for _, name := range scopes[flag] {
				documented[name] = true
			}
			for _, cmd := range flagParsingCommands() {
				name := strings.Join(cmd, " ")
				accepts := commandAcceptsFlag(t, cmd, flag)
				switch {
				case accepts && documented[name]:
					// stated and true
				case accepts && acceptedButUndocumented[flag][name] != "":
					// a known, recorded gap
				case accepts:
					t.Errorf("`relayium %s` accepts %s but the top-level table does not list it "+
						"(document it, or record it in acceptedButUndocumented with the reason)", name, flag)
				case documented[name]:
					t.Errorf("the top-level table scopes %s to %q, but `relayium %s` rejects it", flag, name, name)
				}
			}
			// A recorded exception that stopped being true is also drift.
			for name := range acceptedButUndocumented[flag] {
				if documented[name] {
					t.Errorf("%s is both documented for %q and listed as undocumented", flag, name)
				}
			}
		})
	}
}

// The two commands that parse nothing must keep parsing nothing, so the probe
// above is allowed to skip them.
func TestFlagFreeCommandsTakeNoSharedFlags(t *testing.T) {
	isolatedEnv(t)
	scopes := documentedFlagScopes(t)
	for _, cmd := range []string{"whoami", "version"} {
		for flag, scope := range scopes {
			for _, name := range scope {
				if name == cmd {
					t.Errorf("the top-level table scopes %s to %q, which parses no flags", flag, cmd)
				}
			}
		}
	}
}

// --advertise is an advanced flag: it only works when the address really is
// reachable from the peer, so it belongs in the help of the three commands that
// take it, not in the table everyone reads first.
func TestAdvertiseStaysOutOfTheCommonFlagTable(t *testing.T) {
	isolatedEnv(t)
	if strings.Contains(usage, "--advertise") {
		t.Errorf("--advertise is advanced and must not be in the top-level flag table:\n%s", usage)
	}
	for _, cmd := range []string{"send", "receive", "text"} {
		var stdout, stderr bytes.Buffer
		if rc := Run([]string{cmd, "-h"}, &stdout, &stderr); rc != 0 {
			t.Fatalf("%s -h: rc = %d (%s)", cmd, rc, stderr.String())
		}
		if !strings.Contains(stdout.String(), "--advertise") {
			t.Errorf("%s -h does not document --advertise:\n%s", cmd, stdout.String())
		}
		if !strings.Contains(stdout.String(), "advanced") {
			t.Errorf("%s -h does not mark --advertise advanced:\n%s", cmd, stdout.String())
		}
	}
}

func keysOf(m map[string][]string) []string {
	var out []string
	for k := range m {
		out = append(out, k)
	}
	return out
}

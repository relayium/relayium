package main

import (
	"bytes"
	"path/filepath"
	"strings"
	"testing"

	"github.com/relayium/relayium/internal/linkrtc"
)

// A person asking for help should get an answer on stdout and a success exit,
// not flag's "flag: help requested" on stderr with code 2 — which reads like
// they made a mistake.
func TestSubcommandHelpExitsZeroOnStdout(t *testing.T) {
	for _, cmd := range []string{"push", "sync", "serve"} {
		for _, flag := range []string{"-h", "--help", "-help"} {
			var stdout, stderr bytes.Buffer
			rc := Run([]string{cmd, flag}, &stdout, &stderr)
			if rc != 0 {
				t.Errorf("%s %s: rc = %d, want 0 (stderr: %s)", cmd, flag, rc, stderr.String())
			}
			if stdout.Len() == 0 {
				t.Errorf("%s %s: printed nothing to stdout", cmd, flag)
			}
			if strings.Contains(stderr.String(), "help requested") {
				t.Errorf("%s %s: leaked flag's diagnostic: %s", cmd, flag, stderr.String())
			}
			if !strings.Contains(stdout.String(), "relayium "+cmd) {
				t.Errorf("%s %s: stdout does not describe the subcommand: %s", cmd, flag, stdout.String())
			}
		}
	}
}

// Each subcommand's help must actually answer the question this batch exists
// for: how do two servers talk directly, and what does the account have to do
// with it (nothing).
func TestSubcommandHelpExplainsDirectModel(t *testing.T) {
	want := map[string][]string{
		"push":  {"relayium://", "serve", "no Relayium account", "relayium id"},
		"sync":  {"relayium://", "serve", "no Relayium account", "--delete", "--allow-delete"},
		"serve": {"--bind", "--allow-delete", "authorize", "all interfaces", "no restart", "no Relayium account"},
	}
	for cmd, needles := range want {
		var stdout, stderr bytes.Buffer
		if rc := Run([]string{cmd, "-h"}, &stdout, &stderr); rc != 0 {
			t.Fatalf("%s -h: rc = %d", cmd, rc)
		}
		got := stdout.String()
		for _, n := range needles {
			if !strings.Contains(got, n) {
				t.Errorf("%s -h does not mention %q:\n%s", cmd, n, got)
			}
		}
	}
}

// --delete and --allow-delete are the data-loss controls; help has to state the
// scope truthfully, because an operator decides on this text alone.
func TestDeleteHelpStatesTheScope(t *testing.T) {
	var stdout, stderr bytes.Buffer
	Run([]string{"sync", "-h"}, &stdout, &stderr)
	got := stdout.String()
	for _, n := range []string{"top-level", "never touched", "empty source"} {
		if !strings.Contains(got, n) {
			t.Errorf("sync -h omits %q from the --delete description:\n%s", n, got)
		}
	}
	stdout.Reset()
	Run([]string{"serve", "-h"}, &stdout, &stderr)
	if !strings.Contains(stdout.String(), "never the rest of --dir") {
		t.Errorf("serve -h does not bound --allow-delete:\n%s", stdout.String())
	}
}

// The top-level help is where the "can two of my servers talk to each other?"
// question gets answered, so serve/push/sync must be visibly grouped there as
// the direct, account-free path.
func TestTopLevelHelpGroupsDirectCommands(t *testing.T) {
	var stdout, stderr bytes.Buffer
	if rc := Run([]string{"--help"}, &stdout, &stderr); rc != 0 {
		t.Fatalf("rc = %d", rc)
	}
	got := stdout.String()
	for _, n := range []string{
		"server to server, direct",
		"no relay, no Relayium account",
		"relayium serve",
		"relayium push <src...> relayium://host",
		"relayium sync <src...> relayium://host",
		"--delete",
		"--watch",
		"grants NO filesystem access",
		"authorized_fingerprints",
	} {
		if !strings.Contains(got, n) {
			t.Errorf("top-level help omits %q:\n%s", n, got)
		}
	}
	// The direct group must come before the general usage list, or it is not a
	// group people will read.
	if i, j := strings.Index(got, "server to server, direct"), strings.Index(got, "usage:"); i < 0 || j < 0 || i > j {
		t.Errorf("the direct group must precede the general usage list (i=%d j=%d)", i, j)
	}
}

// The Inbox is the thing people reach for by mistake when they want two servers
// to talk. Help must say plainly that it only receives.
func TestTopLevelHelpDescribesBothInboxSides(t *testing.T) {
	var stdout, stderr bytes.Buffer
	Run([]string{"--help"}, &stdout, &stderr)
	got := stdout.String()
	// This binary has an inbox sender, so the top-level entry must not say
	// otherwise.
	for _, stale := range []string{"RECEIVE SIDE ONLY", "no CLI sender"} {
		if strings.Contains(got, stale) {
			t.Errorf("top-level help still claims the CLI cannot send (%q):\n%s", stale, got)
		}
	}
	for _, want := range []string{"send files to one of your devices", "devices, send, sent, cancel, retry",
		"receive", "enable --dir, run, status, pause", "serve + push/sync", "relayium inbox --help"} {
		if !strings.Contains(got, want) {
			t.Errorf("top-level help does not mention %q:\n%s", want, got)
		}
	}
}

// Help detection must not change how a real flag list is parsed: trailing flags
// are the documented ergonomics and a "--" makes "-h" an ordinary operand.
func TestWantsHelpDoesNotDisturbOrdinaryArgs(t *testing.T) {
	cases := []struct {
		args []string
		want bool
	}{
		{[]string{"./src", "relayium://host", "--delete", "--watch"}, false},
		{[]string{"./src", "relayium://host", "-h"}, true},
		{[]string{"-h", "./src"}, true},
		{[]string{"--", "-h"}, false}, // an operand literally named "-h"
		{[]string{"./src", "--", "--help"}, false},
		{[]string{"help", "./src"}, false}, // a bare word may be a filename
		{[]string{"--helpful", "./src"}, false},
		{nil, false},
	}
	syncValueFlags := valueFlagNames(syncFlagSet(&syncFlags{}))
	for _, c := range cases {
		if got := wantsHelp(c.args, syncValueFlags...); got != c.want {
			t.Errorf("wantsHelp(%v) = %v, want %v", c.args, got, c.want)
		}
	}
}

// A value flag's argument is a value, not a question. `--config-dir -h` names a
// directory called "-h": odd, but the person meant it, and answering with a page
// of usage hides the parse error that would have told them what went wrong.
func TestWantsHelpSkipsValueFlagArguments(t *testing.T) {
	cases := []struct {
		name string
		args []string
		want bool
	}{
		{"value flag consumes -h", []string{"--config-dir", "-h", "./src", "host"}, false},
		{"short value flag consumes -h", []string{"-p", "-h", "./src", "host"}, false},
		{"single-dash long form too", []string{"-config-dir", "-h"}, false},
		{"--flag=value never eats the next token", []string{"--config-dir=-h", "-h"}, true},
		{"a value flag's own =value is not help", []string{"--config-dir=-h", "./src", "host"}, false},
		{"help after a consumed value is still help", []string{"--config-dir", "dir", "-h"}, true},
		{"trailing -h", []string{"./src", "host", "-h"}, true},
		{"operand boundary", []string{"--", "-h"}, false},
		{"bool flag claims no token", []string{"--delete", "-h"}, true},
		{"unknown flag claims no token", []string{"--nope", "-h"}, true},
		{"dangling value flag at the end", []string{"./src", "--config-dir"}, false},
		{"value flag at the very end before nothing", []string{"-p"}, false},
	}
	syncValueFlags := valueFlagNames(syncFlagSet(&syncFlags{}))
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := wantsHelp(c.args, syncValueFlags...); got != c.want {
				t.Errorf("wantsHelp(%v) = %v, want %v", c.args, got, c.want)
			}
		})
	}
}

// Through the real commands: every flag each subcommand declares as
// value-taking must consume the "-h" after it, so the list cannot drift from the
// FlagSet without a test noticing. Each case must reach the parser and fail on
// its own merits (missing operands, a bad value, an unusable --dir), never print
// usage.
//
// serve gets a trailing missing --dir so every case stops at checkReceiveDir:
// reaching net.Listen would leave a real listener running inside the test, and
// a real identity in whatever directory the case named.
func TestValueFlagArgumentIsNotAHelpRequest(t *testing.T) {
	missingDir := filepath.Join(t.TempDir(), "nope")
	cmds := []struct {
		cmd    string
		flags  []string
		suffix []string
	}{
		{"push", valueFlagNames(stdFlagSet(&sshFlags{})), nil},
		{"sync", valueFlagNames(syncFlagSet(&syncFlags{})), nil},
		{"serve", valueFlagNames(serveFlagSet(&serveFlags{})), []string{"--dir", missingDir}},
	}
	for _, c := range cmds {
		for _, name := range c.flags {
			dash := "-"
			if len(name) > 1 {
				dash = "--"
			}
			args := append([]string{c.cmd, dash + name, "-h"}, c.suffix...)
			t.Run(strings.Join(args[:2], " "), func(t *testing.T) {
				var stdout, stderr bytes.Buffer
				rc := Run(args, &stdout, &stderr)
				if strings.Contains(stdout.String(), "relayium "+c.cmd) {
					t.Fatalf("printed usage for a flag VALUE of %q:\n%s", name, stdout.String())
				}
				if rc == 0 {
					t.Fatalf("rc = 0: %q was treated as a help request (stderr: %s)", args, stderr.String())
				}
			})
		}
	}
}

// The counterpart: a genuine trailing -h after a value flag that already has its
// value still prints help, and "--" still makes -h an operand.
func TestHelpStillReachableAfterValueFlags(t *testing.T) {
	var stdout, stderr bytes.Buffer
	if rc := Run([]string{"sync", "--config-dir", "/tmp/x", "-h"}, &stdout, &stderr); rc != 0 {
		t.Fatalf("rc = %d, want 0 (stderr: %s)", rc, stderr.String())
	}
	if !strings.Contains(stdout.String(), "relayium sync") {
		t.Fatalf("a real help request after a value flag printed nothing useful: %q", stdout.String())
	}
	stdout.Reset()
	stderr.Reset()
	if rc := Run([]string{"sync", "--", "-h"}, &stdout, &stderr); rc == 0 {
		t.Fatalf("`sync -- -h` is an operand named -h, not help: %q", stdout.String())
	}
	if strings.Contains(stdout.String(), "one-way incremental folder mirror") {
		t.Fatalf("printed help after the operand boundary: %s", stdout.String())
	}
}

// Regression: the help check runs before parsing, so a normal sync with
// trailing flags must still reach the parser and fail on its own merits (a
// missing destination), not silently print help.
func TestSyncWithTrailingFlagsStillParses(t *testing.T) {
	var stdout, stderr bytes.Buffer
	rc := Run([]string{"sync", "./only-a-source", "--delete"}, &stdout, &stderr)
	if rc != 2 {
		t.Fatalf("rc = %d, want 2 (needs <src...> <dest>)", rc)
	}
	if strings.Contains(stdout.String(), "one-way incremental folder mirror") {
		t.Fatalf("printed help instead of the argument error: %s", stdout.String())
	}
}

// A10: `pair` is a public command — in the top-level usage, with its own help
// — and the developer entry `__link` stays out of every help surface.
func TestUsageListsPairAndHidesTheDeveloperCommand(t *testing.T) {
	var stdout, stderr bytes.Buffer
	if rc := Run([]string{"--help"}, &stdout, &stderr); rc != 0 {
		t.Fatalf("--help: rc = %d", rc)
	}
	top := stdout.String()
	if !strings.Contains(top, "relayium pair [code]") {
		t.Errorf("top-level usage does not list pair:\n%s", top)
	}
	if strings.Contains(top, "__link") {
		t.Errorf("top-level usage mentions the hidden __link")
	}
	stdout.Reset()
	if rc := Run([]string{"pair", "-h"}, &stdout, &stderr); rc != 0 {
		t.Fatalf("pair -h: rc = %d", rc)
	}
	for _, n := range []string{"/send <path>", "/accept", "/decline", "/quit", "Ctrl-C", "exit status",
		"stdout carries only the other side's messages", "path:", "never overwritten"} {
		if !strings.Contains(stdout.String(), n) {
			t.Errorf("pair -h does not explain %q", n)
		}
	}
	if _, ok := commandUsage["__link"]; ok {
		t.Error("__link must not be a documented command")
	}
}

// The relay sentence is a billing statement: it says when the code owner's
// relay allowance is spent. It must say what linkrtc.ChooseRTCConfig does —
// relay-only whenever a TURN server was issued, peer to peer otherwise — in
// every command that can link, and no help may claim a direct-first policy.
// If the policy changes (A09c ice-direct/1), this test fails until the help
// changes with it.
func TestLinkRelayPolicyHelpMatchesTheCode(t *testing.T) {
	turn := linkrtc.ICEConfig{ICEServers: []linkrtc.ICEServer{
		{URLs: []string{"stun:stun.example:3478"}},
		{URLs: []string{"turn:turn.example:3478?transport=udp"}, Username: "1:u", Credential: "p"},
	}}
	stunOnly := linkrtc.ICEConfig{ICEServers: []linkrtc.ICEServer{{URLs: []string{"stun:stun.example:3478"}}}}
	if !linkrtc.ChooseRTCConfig(turn, "").RelayOnly {
		t.Fatal("the code no longer relays every byte when TURN is issued: rewrite linkRelayPolicy (and this test) to say what it does")
	}
	if linkrtc.ChooseRTCConfig(stunOnly, "").RelayOnly {
		t.Fatal("the code relays without TURN: rewrite linkRelayPolicy")
	}
	for _, n := range []string{"whenever the server issues a TURN relay", "every byte through that relay",
		"even when the two ends could\nreach each other directly", "relay allowance", "Only when no relay is issued"} {
		if !strings.Contains(linkRelayPolicy, n) {
			t.Errorf("linkRelayPolicy lost %q", n)
		}
	}
	for _, cmd := range []string{"pair", "send", "receive", "text"} {
		var stdout, stderr bytes.Buffer
		if rc := Run([]string{cmd, "-h"}, &stdout, &stderr); rc != 0 {
			t.Fatalf("%s -h: rc = %d", cmd, rc)
		}
		got := stdout.String()
		if !strings.Contains(got, linkRelayPolicy) {
			t.Errorf("%s -h does not state the relay policy", cmd)
		}
		flat := strings.Join(strings.Fields(got), " ")
		for _, banned := range []string{"direct when a path exists", "direct when possible", "used when no direct path",
			"otherwise through a TURN relay", "direct-first"} {
			if strings.Contains(flat, banned) {
				t.Errorf("%s -h claims a direct-first policy (%q) the code does not have", cmd, banned)
			}
		}
	}
}

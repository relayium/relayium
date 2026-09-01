package main

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// publicCommands is the list every help test walks: what a person can type and
// what its help must be about. It is written out by hand rather than derived
// from commandUsage, so adding a command to the map without adding it here (or
// the reverse) fails TestHelpMatrixCoversEveryCommand below instead of quietly
// going untested.
var publicCommands = []struct {
	name string
	// title is the phrase the usage must open with, so a help form cannot pass
	// by printing SOME text — it has to print the right command's text.
	title string
}{
	{"push", "relayium push"},
	{"pull", "relayium pull"},
	{"sync", "relayium sync"},
	{"send", "relayium send"},
	{"receive", "relayium receive"},
	{"text", "relayium text"},
	{"serve", "relayium serve"},
	{"id", "relayium id"},
	{"authorize", "relayium authorize"},
	{"login", "relayium login"},
	{"logout", "relayium logout"},
	{"whoami", "relayium whoami"},
	{"up", "relayium up"},
	{"down", "relayium down"},
	{"inbox", "relayium inbox"},
	{"update", "relayium update"},
	{"version", "relayium version"},
}

// inboxSubcommands is the same for the one command that has a second level.
var inboxSubcommands = []struct {
	name  string
	title string
}{
	{"run", "relayium inbox run"},
	{"enable", "relayium inbox enable"},
	{"disable", "relayium inbox disable"},
	{"status", "relayium inbox status"},
	{"pause", "relayium inbox pause"},
	{"resume", "relayium inbox resume"},
	{"service", "relayium inbox service"},
}

// helpForms returns the argv spellings that must all answer identically for a
// command path: the two flags, and the `help` verb from the top.
func helpForms(path ...string) [][]string {
	var forms [][]string
	for _, flag := range []string{"-h", "--help", "-help"} {
		forms = append(forms, append(append([]string{}, path...), flag))
	}
	forms = append(forms, append([]string{"help"}, path...))
	if len(path) > 1 { // `relayium inbox help run` as well as `relayium help inbox run`
		forms = append(forms, append([]string{path[0], "help"}, path[1:]...))
	}
	return forms
}

// isolatedEnv points every config/credential lookup at an empty temp directory,
// and returns it so a test can assert nothing was written there. Help must not
// read a credential, mint an identity, or create a state directory — a person
// asking what a command does has not asked it to touch their machine.
func isolatedEnv(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", dir)
	t.Setenv("HOME", dir)
	return dir
}

// Every public command and every inbox subcommand answers every help form the
// same way: usage on stdout, exit 0, no flag-package diagnostic on stderr.
func TestHelpFormsAreUniform(t *testing.T) {
	cfg := isolatedEnv(t)

	check := func(t *testing.T, form []string, title string) {
		t.Helper()
		var stdout, stderr bytes.Buffer
		rc := Run(form, &stdout, &stderr)
		if rc != 0 {
			t.Errorf("`relayium %s`: rc = %d, want 0 (stderr: %s)", strings.Join(form, " "), rc, stderr.String())
		}
		if !strings.Contains(stdout.String(), title) {
			t.Errorf("`relayium %s`: stdout is not %s's usage:\n%s", strings.Join(form, " "), title, stdout.String())
		}
		if stderr.Len() != 0 {
			t.Errorf("`relayium %s`: wrote to stderr: %s", strings.Join(form, " "), stderr.String())
		}
	}

	for _, c := range publicCommands {
		for _, form := range helpForms(c.name) {
			t.Run(strings.Join(form, " "), func(t *testing.T) { check(t, form, c.title) })
		}
	}
	for _, sub := range inboxSubcommands {
		for _, form := range helpForms("inbox", sub.name) {
			t.Run(strings.Join(form, " "), func(t *testing.T) { check(t, form, sub.title) })
		}
	}
	for _, form := range [][]string{{"-h"}, {"--help"}, {"-help"}, {"help"}} {
		t.Run("top-level "+strings.Join(form, " "), func(t *testing.T) {
			check(t, form, "relayium — file and text transfer")
		})
	}

	// Nothing above may have touched the machine's configuration.
	entries, err := os.ReadDir(cfg)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 0 {
		var names []string
		for _, e := range entries {
			names = append(names, e.Name())
		}
		t.Errorf("help created state under the config directory: %v", names)
	}
}

// The registry `help <command>` reads from must match the list of commands the
// dispatcher actually accepts. Either half drifting is how a command ends up
// with no help at all.
func TestHelpMatrixCoversEveryCommand(t *testing.T) {
	if len(commandUsage) != len(publicCommands) {
		t.Errorf("commandUsage has %d entries, the tested list has %d", len(commandUsage), len(publicCommands))
	}
	for _, c := range publicCommands {
		if _, ok := commandUsage[c.name]; !ok {
			t.Errorf("commandUsage has no entry for %q", c.name)
		}
	}
	if len(inboxCommandUsage) != len(inboxSubcommands) {
		t.Errorf("inboxCommandUsage has %d entries, the tested list has %d", len(inboxCommandUsage), len(inboxSubcommands))
	}
	for _, sub := range inboxSubcommands {
		if _, ok := inboxCommandUsage[sub.name]; !ok {
			t.Errorf("inboxCommandUsage has no entry for %q", sub.name)
		}
	}
	// Every command in the top-level usage text must be one you can ask for help
	// about, since that text is where people learn the names.
	for _, c := range publicCommands {
		if !strings.Contains(usage, "relayium "+c.name) {
			t.Errorf("top-level usage never mentions %q", c.name)
		}
	}
}

// Help is not a run. These commands would otherwise read a credential, create
// an identity keypair, bind a port, or make a request; the help form must do
// none of it, which is what makes `-h` safe to type on a logged-out or
// disconnected machine.
func TestHelpDoesNoAccountOrNetworkWork(t *testing.T) {
	cfg := isolatedEnv(t)
	// A credential that must not be read, in the place the commands look.
	credDir := filepath.Join(cfg, "relayium")
	if err := os.MkdirAll(credDir, 0o700); err != nil {
		t.Fatal(err)
	}
	before, err := os.ReadDir(credDir)
	if err != nil {
		t.Fatal(err)
	}

	for _, args := range [][]string{
		{"id", "-h"}, {"login", "-h"}, {"logout", "-h"}, {"whoami", "-h"},
		{"up", "-h"}, {"down", "-h"}, {"update", "-h"}, {"authorize", "-h"},
		{"serve", "-h"}, {"send", "-h"}, {"receive", "-h"}, {"text", "-h"},
		{"inbox", "enable", "-h"}, {"inbox", "run", "-h"}, {"inbox", "status", "-h"},
		{"inbox", "disable", "-h"}, {"inbox", "service", "-h"},
	} {
		var stdout, stderr bytes.Buffer
		if rc := Run(args, &stdout, &stderr); rc != 0 {
			t.Errorf("`relayium %s`: rc = %d (stderr: %s)", strings.Join(args, " "), rc, stderr.String())
		}
	}

	after, err := os.ReadDir(credDir)
	if err != nil {
		t.Fatal(err)
	}
	if len(after) != len(before) {
		t.Errorf("help wrote into the config directory: %d entries, was %d", len(after), len(before))
	}
}

// A help request is answered; a mistake is still a mistake. Standardising help
// must not turn an unknown command or a missing argument into a success.
func TestMissingAndUnknownStillExitTwo(t *testing.T) {
	isolatedEnv(t)
	cases := []struct {
		args []string
		want int
	}{
		{nil, 2},                                  // bare `relayium`
		{[]string{"nope"}, 2},                     // unknown command
		{[]string{"help", "nope"}, 2},             // help for an unknown command
		{[]string{"inbox"}, 2},                    // inbox with no subcommand
		{[]string{"inbox", "nope"}, 2},            // unknown inbox subcommand
		{[]string{"inbox", "help", "nope"}, 2},    // help for an unknown one
		{[]string{"help", "inbox", "nope"}, 2},    // and from the top
		{[]string{"push"}, 2},                     // missing operands
		{[]string{"push", "only-one"}, 2},         //
		{[]string{"sync", "only-one"}, 2},         //
		{[]string{"pull", "only-one"}, 2},         //
		{[]string{"receive"}, 2},                  //
		{[]string{"up"}, 2},                       //
		{[]string{"down"}, 2},                     //
		{[]string{"authorize"}, 2},                //
		{[]string{"authorize", "not-hex"}, 2},     // bad fingerprint
		{[]string{"inbox", "enable"}, 2},          // --dir is required
		{[]string{"inbox", "service"}, 2},         // <kind> is required
		{[]string{"text", "one", "two"}, 2},       // one code at most
		{[]string{"push", "--nope", "a", "b"}, 2}, /* unknown flag */
	}
	for _, c := range cases {
		t.Run(strings.Join(append([]string{"relayium"}, c.args...), " "), func(t *testing.T) {
			var stdout, stderr bytes.Buffer
			if rc := Run(c.args, &stdout, &stderr); rc != c.want {
				t.Errorf("rc = %d, want %d (stdout: %s / stderr: %s)", rc, c.want, stdout.String(), stderr.String())
			}
		})
	}
}

// `help <command>` prints; it does not run the command with -h bolted on. The
// difference matters for the commands whose bare form does something.
func TestHelpVerbDoesNotRunTheCommand(t *testing.T) {
	isolatedEnv(t)
	var stdout, stderr bytes.Buffer
	if rc := Run([]string{"help", "version"}, &stdout, &stderr); rc != 0 {
		t.Fatalf("rc = %d", rc)
	}
	if strings.TrimSpace(stdout.String()) == version {
		t.Errorf("`help version` printed the version instead of the usage: %q", stdout.String())
	}
	if !strings.Contains(stdout.String(), "relayium version") {
		t.Errorf("`help version` printed no usage: %q", stdout.String())
	}
	// `relayium version` itself still prints the version.
	stdout.Reset()
	if rc := Run([]string{"version"}, &stdout, &stderr); rc != 0 || strings.TrimSpace(stdout.String()) != version {
		t.Errorf("`relayium version` = %q (rc %d), want %q", stdout.String(), rc, version)
	}
}

// The corrections this batch exists for, asserted where a user actually reads
// them. Each of these was previously stated wrongly, and each is a claim
// someone would act on.
func TestHelpStatesTheTransportGuaranteesTruthfully(t *testing.T) {
	help := func(args ...string) string {
		var stdout, stderr bytes.Buffer
		if rc := Run(args, &stdout, &stderr); rc != 0 {
			t.Fatalf("`relayium %s`: rc = %d (%s)", strings.Join(args, " "), rc, stderr.String())
		}
		return stdout.String()
	}

	push := help("push", "-h")
	if strings.Contains(push, "scp with resume") {
		t.Error("push help still describes the whole SSH path as scp with resume")
	}
	for _, n := range []string{
		"tar -x -k",       // the actual remote command
		"does NOT resume", // the fallback's limit
		"kept rather than overwritten",
		"partly applied", // a collision can follow files that already landed
	} {
		if !strings.Contains(push, n) {
			t.Errorf("push help omits %q:\n%s", n, push)
		}
	}

	// sync's --delete consent differs by destination, and the SSH side has no
	// --allow-delete to set. Saying otherwise tells an operator their mirror is
	// safe when it is not.
	sync := help("sync", "-h")
	for _, n := range []string{"relayium://", "--allow-delete", "top-level", "never touched", "empty source"} {
		if !strings.Contains(sync, n) {
			t.Errorf("sync help omits %q:\n%s", n, sync)
		}
	}
	ssh := strings.Index(sync, "[user@]host:dest — there is no separate listener")
	if ssh < 0 {
		t.Errorf("sync help does not say the SSH receiver has no separate consent step:\n%s", sync)
	}
	if !strings.Contains(sync[ssh:], "No --allow-delete is involved") {
		t.Errorf("sync help does not say --allow-delete is not part of the SSH path:\n%s", sync[ssh:])
	}

	// pull has no fallback at all; claiming one would send someone to a remote
	// that cannot answer.
	pull := help("pull", "-h")
	if !strings.Contains(pull, "INSTALLED ON THE REMOTE") || !strings.Contains(pull, "no tar fallback") {
		t.Errorf("pull help does not state its remote requirement:\n%s", pull)
	}
}

// Every command's help must be honest about what it needs before it will work:
// an account, a network, or neither. This is the question `-h` is most often
// asked to answer.
func TestHelpStatesAccountAndOnlineConstraints(t *testing.T) {
	want := map[string][]string{
		"push":      {"no Relayium account"},
		"pull":      {"no Relayium account"},
		"sync":      {"no Relayium account"},
		"send":      {"relayium login", "online at the same time"},
		"receive":   {"No Relayium\naccount is needed", "online at the same time"},
		"text":      {"relayium login", "online at the same time"},
		"serve":     {"No relay, no SSH, no Relayium account"},
		"id":        {"no Relayium account", "no network"},
		"authorize": {"no account and no network"},
		"login":     {"Needs network access"},
		"logout":    {"needs network access"},
		"whoami":    {"Local only"},
		"up":        {"requires \"relayium login\""},
		"down":      {"No account is needed"},
		"update":    {"no Relayium account is involved"},
		"version":   {"no account, no network"},
	}
	for cmd, needles := range want {
		var stdout, stderr bytes.Buffer
		if rc := Run([]string{cmd, "-h"}, &stdout, &stderr); rc != 0 {
			t.Fatalf("%s -h: rc = %d (%s)", cmd, rc, stderr.String())
		}
		for _, n := range needles {
			if !strings.Contains(stdout.String(), n) {
				t.Errorf("%s -h does not state %q:\n%s", cmd, n, stdout.String())
			}
		}
	}

	inboxWant := map[string][]string{
		"run":     {"Requires \"relayium login\"", "RECEIVE SIDE ONLY"},
		"enable":  {"Requires \"relayium login\"", "network access"},
		"disable": {"Requires network access"},
		"status":  {"works offline", "needs \"relayium login\""},
		"pause":   {"needs no network"},
		"resume":  {"needs network access"},
		"service": {"needs no\nnetwork, and needs no account"},
	}
	for sub, needles := range inboxWant {
		var stdout, stderr bytes.Buffer
		if rc := Run([]string{"inbox", sub, "-h"}, &stdout, &stderr); rc != 0 {
			t.Fatalf("inbox %s -h: rc = %d (%s)", sub, rc, stderr.String())
		}
		for _, n := range needles {
			if !strings.Contains(stdout.String(), n) {
				t.Errorf("inbox %s -h does not state %q:\n%s", sub, n, stdout.String())
			}
		}
	}
}

// Named positionals, not "<args>". Someone reading help has to be able to tell
// which slot is the source, which is the destination, and which is a code.
func TestHelpNamesItsPositionals(t *testing.T) {
	want := map[string][]string{
		"push":      {"<src...>", "<dest>"},
		"pull":      {"[user@]host:src", "<dest>"},
		"sync":      {"<src...>", "<dest>"},
		"send":      {"<src...>", "[code]"},
		"receive":   {"<code>", "[destdir]"},
		"text":      {"[code]"},
		"authorize": {"<fingerprint>"},
		"up":        {"<path...>"},
		"down":      {"<link-or-code>", "[destDir]"},
	}
	for cmd, needles := range want {
		var stdout, stderr bytes.Buffer
		if rc := Run([]string{cmd, "-h"}, &stdout, &stderr); rc != 0 {
			t.Fatalf("%s -h: rc = %d (%s)", cmd, rc, stderr.String())
		}
		got := stdout.String()
		if !strings.Contains(got, "positional arguments:") {
			t.Errorf("%s -h has no named positional section:\n%s", cmd, got)
		}
		for _, n := range needles {
			if !strings.Contains(got, n) {
				t.Errorf("%s -h does not name the positional %q:\n%s", cmd, n, got)
			}
		}
	}
	var stdout, stderr bytes.Buffer
	if rc := Run([]string{"inbox", "service", "-h"}, &stdout, &stderr); rc != 0 {
		t.Fatalf("inbox service -h: rc = %d (%s)", rc, stderr.String())
	}
	for _, n := range []string{"<kind>", "systemd-user", "systemd-system", "launchd", "container"} {
		if !strings.Contains(stdout.String(), n) {
			t.Errorf("inbox service -h does not name %q:\n%s", n, stdout.String())
		}
	}
}

// ── claims the help text must not make, and scopes it must state exactly ────

// The native push path preflights destination collisions before resume
// negotiation, so an existing partial destination is refused: an ordinary push
// neither continues nor restarts it. What this test pins is the batch behavior:
// push installs files one at a time, so a transport failure after earlier files
// completed leaves the batch partly applied. Calling that "all-or-nothing" or
// "atomic" tells an operator a re-run is unnecessary and that a failed push
// touched nothing, and both are false.
func TestPushHelpClaimsNoAtomicBatch(t *testing.T) {
	isolatedEnv(t)
	var stdout, stderr bytes.Buffer
	if rc := Run([]string{"push", "-h"}, &stdout, &stderr); rc != 0 {
		t.Fatalf("push -h: rc = %d (%s)", rc, stderr.String())
	}
	got := stdout.String()
	for _, banned := range []string{"all-or-nothing", "all or nothing", "atomic", "transactional"} {
		if strings.Contains(strings.ToLower(got), banned) {
			t.Errorf("push help claims %q; the native path is not a transaction:\n%s", banned, got)
		}
	}
	// The precise wording that replaces it must actually be there, or removing
	// the banned phrase above could pass by saying nothing at all. Matched on
	// collapsed whitespace because the prose is hard-wrapped.
	flat := strings.Join(strings.Fields(got), " ")
	for _, n := range []string{
		"BEFORE any bytes are sent", // the collision preflight, scoped
		"verified by SHA-256",       // per-file verification
		"NOT is a transaction",      // the limit, stated
		"leaves the files that already landed in place",
		"re-running the SAME push is refused", // and the recovery step is not a re-run
		"Push does not resume a partial file",
	} {
		if !strings.Contains(flat, n) {
			t.Errorf("push help omits %q:\n%s", n, got)
		}
	}
}

// "up" is a hosted asynchronous stored-link mode. It is NOT "the one CLI mode
// that is not direct": Device Inbox is server-stored and asynchronous too, and
// the CLI is its receive side. Someone reading the old claim would conclude
// inbox files move machine-to-machine, which is wrong about where their
// ciphertext sits.
func TestUpHelpDoesNotClaimToBeTheOnlyNonDirectMode(t *testing.T) {
	isolatedEnv(t)
	var stdout, stderr bytes.Buffer
	if rc := Run([]string{"up", "-h"}, &stdout, &stderr); rc != 0 {
		t.Fatalf("up -h: rc = %d (%s)", rc, stderr.String())
	}
	got := stdout.String()
	for _, banned := range []string{
		"the one CLI mode that is NOT direct",
		"the one CLI mode that is not direct",
		"the only CLI mode that is not direct",
	} {
		if strings.Contains(got, banned) {
			t.Errorf("up help still claims to be the sole non-direct mode (%q):\n%s", banned, got)
		}
	}
	// The prose is hard-wrapped, so match on collapsed whitespace: an edit that
	// only moves a line break must not read as the correction being deleted.
	flat := strings.Join(strings.Fields(got), " ")
	for _, n := range []string{
		"hosted, asynchronous stored-link mode",
		"Device Inbox is hosted and asynchronous too",
		"the CLI is only its receive side",
	} {
		if !strings.Contains(flat, n) {
			t.Errorf("up help omits %q:\n%s", n, got)
		}
	}
}

// Device Inbox sends come from the Web or a native app. `inbox run -h` has said
// so; `send -h` used to name only the Web, which reads as "there is no app
// path" to someone deciding how to reach a machine that is offline.
func TestSendHelpNamesBothInboxSenders(t *testing.T) {
	isolatedEnv(t)
	var stdout, stderr bytes.Buffer
	if rc := Run([]string{"send", "-h"}, &stdout, &stderr); rc != 0 {
		t.Fatalf("send -h: rc = %d (%s)", rc, stderr.String())
	}
	if !strings.Contains(stdout.String(), "Device Inbox from the Web or a native app") {
		t.Errorf("send help does not name both Device Inbox senders:\n%s", stdout.String())
	}
}

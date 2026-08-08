package deploy

import (
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func testParams() Params {
	return Params{
		Binary:      "/opt/relayium/bin/relayium",
		ConfigDir:   "/var/lib/relayium-inbox/config",
		StateDir:    "/var/lib/relayium-inbox/config/inbox",
		ReceiveDir:  "/srv/incoming",
		ServiceUser: "relayium",
		CurrentUser: "alice",
		LogDir:      "/var/log/relayium",
	}
}

// TestNoDefinitionHardcodesAPath is the "not the author's machine" rule. Every
// path in a shipped definition is a placeholder; a literal home directory, a
// literal Go workspace or a literal user name would be wrong on every machine
// but one.
func TestNoDefinitionHardcodesAPath(t *testing.T) {
	forbidden := []string{"/Users/", "/home/", "/Users/lily", "go/src", "GOPATH", "relayium/relayium/server"}
	for _, k := range Kinds() {
		raw := rawTemplate(t, k)
		for _, f := range forbidden {
			if strings.Contains(raw, f) {
				t.Errorf("%s template contains the hardcoded path fragment %q", k, f)
			}
		}
		// Every value that varies by machine must arrive as a placeholder.
		for _, ph := range []string{"@RELAYIUM_BIN@", "@CONFIG_DIR@"} {
			if !strings.Contains(raw, ph) {
				t.Errorf("%s template is missing the %s placeholder", k, ph)
			}
		}
	}
}

func rawTemplate(t *testing.T, k Kind) string {
	t.Helper()
	switch k {
	case SystemdUser:
		return systemdUser
	case SystemdSystem:
		return systemdSystem
	case Launchd:
		return launchdPlist
	}
	t.Fatalf("unknown kind %q", k)
	return ""
}

// TestRenderSubstitutesEveryPlaceholder: a leftover "@RECEIVE_DIR@" would be
// accepted by systemd's parser and fail only at runtime, so Render refuses it.
func TestRenderSubstitutesEveryPlaceholder(t *testing.T) {
	p := testParams()
	for _, k := range Kinds() {
		out, err := Render(k, p)
		if err != nil {
			t.Fatalf("render %s: %v", k, err)
		}
		if strings.Contains(out, "@RELAYIUM_BIN@") || strings.Contains(out, "@CONFIG_DIR@") {
			t.Fatalf("%s still contains a placeholder:\n%s", k, out)
		}
		if !strings.Contains(out, p.Binary) {
			t.Fatalf("%s does not name the binary %q", k, p.Binary)
		}
		if !strings.Contains(out, p.ConfigDir) {
			t.Fatalf("%s does not name the config dir %q", k, p.ConfigDir)
		}
	}
	if _, err := Render("upstart", p); err == nil {
		t.Fatal("an unknown service kind was rendered")
	}
}

// TestSystemdUnitsAreStructurallyValid parses the rendered units the way systemd
// does (INI-ish sections and key=value) and asserts the directives that carry
// the security and lifecycle decisions are actually present. A unit that parses
// but omits User= or ReadWritePaths= is not the unit that was reviewed.
func TestSystemdUnitsAreStructurallyValid(t *testing.T) {
	p := testParams()
	for _, k := range []Kind{SystemdUser, SystemdSystem} {
		out, err := Render(k, p)
		if err != nil {
			t.Fatalf("render: %v", err)
		}
		sections := parseUnit(t, out)
		for _, want := range []string{"Unit", "Service", "Install"} {
			if _, ok := sections[want]; !ok {
				t.Fatalf("%s has no [%s] section", k, want)
			}
		}
		svc := sections["Service"]
		if got := svc["ExecStart"]; !strings.Contains(got, p.Binary) || !strings.Contains(got, "inbox run") {
			t.Fatalf("%s ExecStart = %q; it must run the foreground worker", k, got)
		}
		if got := svc["Type"]; got != "simple" {
			t.Fatalf("%s Type = %q, want simple: `inbox run` never forks", k, got)
		}
		if got := svc["Restart"]; got != "on-failure" {
			t.Fatalf("%s Restart = %q, want on-failure: `inbox disable` exits 0 deliberately "+
				"and Restart=always would fight the operator", k, got)
		}
		if svc["NoNewPrivileges"] != "yes" {
			t.Fatalf("%s does not set NoNewPrivileges=yes; a receiver has no reason to gain privileges", k)
		}
		rw := svc["ReadWritePaths"]
		if !strings.Contains(rw, p.StateDir) || !strings.Contains(rw, p.ReceiveDir) {
			t.Fatalf("%s ReadWritePaths = %q; with ProtectSystem=strict the worker must be granted "+
				"exactly its state and receive directories", k, rw)
		}
		if svc["ProtectSystem"] != "strict" {
			t.Fatalf("%s ProtectSystem = %q, want strict", k, svc["ProtectSystem"])
		}
	}

	// Only the SYSTEM unit names a dedicated account, and it must never be root.
	sys := parseUnit(t, mustRender(t, SystemdSystem, p))["Service"]
	if sys["User"] != p.ServiceUser {
		t.Fatalf("system unit User = %q, want the dedicated account %q", sys["User"], p.ServiceUser)
	}
	if sys["User"] == "root" || sys["User"] == "" {
		t.Fatal("the system unit must run as a dedicated unprivileged account, never root")
	}
	user := parseUnit(t, mustRender(t, SystemdUser, p))["Service"]
	if _, ok := user["User"]; ok {
		t.Fatal("the USER unit must not set User=: it already runs as the invoking user")
	}
}

func mustRender(t *testing.T, k Kind, p Params) string {
	t.Helper()
	out, err := Render(k, p)
	if err != nil {
		t.Fatalf("render %s: %v", k, err)
	}
	return out
}

// parseUnit is a deliberately small systemd-unit parser: enough to assert what
// the directives say, on a host that has no systemd at all.
func parseUnit(t *testing.T, s string) map[string]map[string]string {
	t.Helper()
	out := map[string]map[string]string{}
	section := ""
	for i, line := range strings.Split(s, "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") || strings.HasPrefix(line, ";") {
			continue
		}
		if strings.HasPrefix(line, "[") {
			if !strings.HasSuffix(line, "]") {
				t.Fatalf("line %d: malformed section header %q", i+1, line)
			}
			section = line[1 : len(line)-1]
			out[section] = map[string]string{}
			continue
		}
		k, v, ok := strings.Cut(line, "=")
		if !ok {
			t.Fatalf("line %d: %q is neither a section nor key=value", i+1, line)
		}
		if section == "" {
			t.Fatalf("line %d: %q appears before any section", i+1, line)
		}
		out[section][strings.TrimSpace(k)] = strings.TrimSpace(v)
	}
	return out
}

// TestLaunchdPlistIsValid runs Apple's own parser where the host has it (macOS),
// and falls back to structural checks elsewhere. Running the real validator on
// the platform that owns the format is the point: a plist that "looks fine" and
// fails plutil is a service that silently never starts.
func TestLaunchdPlistIsValid(t *testing.T) {
	p := testParams()
	out := mustRender(t, Launchd, p)

	for _, want := range []string{"com.relayium.inbox", "<key>RunAtLoad</key>", "<string>inbox</string>", "<string>run</string>"} {
		if !strings.Contains(out, want) {
			t.Fatalf("plist is missing %q:\n%s", want, out)
		}
	}
	// A LaunchAgent, not a LaunchDaemon: the worker holds a user's credential and
	// writes into a directory that user chose.
	if strings.Contains(out, "LaunchDaemons") || strings.Contains(out, "<key>UserName</key>") {
		t.Fatal("the launchd definition must be a per-user LaunchAgent, not a root LaunchDaemon")
	}

	path := filepath.Join(t.TempDir(), "com.relayium.inbox.plist")
	if err := os.WriteFile(path, []byte(out), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}
	plutil, err := exec.LookPath("plutil")
	if err != nil {
		if runtime.GOOS == "darwin" {
			t.Fatalf("plutil is missing on a darwin host: %v", err)
		}
		t.Log("plutil unavailable on this host; structural checks only (the macOS gate runs the real validator)")
		return
	}
	if outBytes, err := exec.Command(plutil, "-lint", path).CombinedOutput(); err != nil {
		t.Fatalf("plutil -lint rejected the rendered plist: %v\n%s\n%s", err, outBytes, out)
	}
}

// TestSystemdVerifyWhereAvailable runs systemd's own validator when the host has
// it. On a macOS workstation it does not, which is exactly why the structural
// test above exists rather than being replaced by this one.
func TestSystemdVerifyWhereAvailable(t *testing.T) {
	analyze, err := exec.LookPath("systemd-analyze")
	if err != nil {
		t.Skipf("systemd-analyze unavailable on %s; structural parsing covers this host", runtime.GOOS)
	}
	dir := t.TempDir()
	p := testParams()
	// verify checks that ExecStart exists as well as parsing the unit. Point it
	// at an executable fixture rather than the illustrative /opt path used by
	// structural tests; otherwise a clean Linux runner fails for a missing local
	// installation, not for a malformed generated definition.
	p.Binary = filepath.Join(dir, "relayium")
	if err := os.WriteFile(p.Binary, []byte("#!/bin/sh\nexit 0\n"), 0o755); err != nil {
		t.Fatalf("write executable fixture: %v", err)
	}
	for _, k := range []Kind{SystemdUser, SystemdSystem} {
		path := filepath.Join(dir, string(k)+"-relayium-inbox.service")
		if err := os.WriteFile(path, []byte(mustRender(t, k, p)), 0o600); err != nil {
			t.Fatalf("write: %v", err)
		}
		// The generated Documentation= line names Relayium's eventual man page.
		// Its absence on a CI runner is not a unit syntax error; --man=no keeps
		// verify focused on the service definition itself.
		if out, err := exec.Command(analyze, "verify", "--man=no", path).CombinedOutput(); err != nil {
			t.Fatalf("systemd-analyze verify %s: %v\n%s", k, err, out)
		}
	}
}

// TestEscapingSurvivesAwkwardPaths. A directory with a space is legal and
// common ("~/Library/Application Support"); one with an ampersand is legal too.
// Both break a naive substitution — systemd would split ExecStart into two
// arguments, and the plist would stop parsing.
func TestEscapingSurvivesAwkwardPaths(t *testing.T) {
	p := testParams()
	p.ReceiveDir = "/srv/in & out"
	p.Binary = "/opt/my apps/relayium"
	// ConfigDir and LogDir are the two awkward values the plist actually carries.
	p.ConfigDir = `/srv/config & "state"`
	p.LogDir = "/var/log/relay & ium"

	unit := mustRender(t, SystemdSystem, p)
	svc := parseUnit(t, unit)["Service"]
	if !strings.Contains(svc["ExecStart"], `"/opt/my apps/relayium"`) {
		t.Fatalf("a binary path with a space was not quoted for systemd: %q", svc["ExecStart"])
	}
	if !strings.Contains(svc["ReadWritePaths"], `"/srv/in & out"`) {
		t.Fatalf("a receive directory with a space was not quoted for systemd: %q", svc["ReadWritePaths"])
	}

	plist := mustRender(t, Launchd, p)
	if strings.Contains(plist, "config & ") || strings.Contains(plist, "relay & ium") {
		t.Fatalf("an ampersand reached the plist unescaped; the file would not parse:\n%s", plist)
	}
	if !strings.Contains(plist, "config &amp; ") {
		t.Fatalf("the ampersand was not XML-escaped:\n%s", plist)
	}
	if strings.Contains(plist, `"state"`) {
		t.Fatal("double quotes reached the plist unescaped")
	}
	if plutil, err := exec.LookPath("plutil"); err == nil {
		path := filepath.Join(t.TempDir(), "awkward.plist")
		if err := os.WriteFile(path, []byte(plist), 0o600); err != nil {
			t.Fatalf("write: %v", err)
		}
		if out, err := exec.Command(plutil, "-lint", path).CombinedOutput(); err != nil {
			t.Fatalf("plutil rejected the escaped plist: %v\n%s", err, out)
		}
	}
}

// TestInstructionsDoNotClaimRootlessSystemInstall. A CLI that quietly acquires
// root to "help" is worse than one that prints four commands, and instructions
// that omit where root is required set an operator up to be surprised.
func TestInstructionsDoNotClaimRootlessSystemInstall(t *testing.T) {
	p := testParams()
	sys := strings.Join(Instructions(SystemdSystem, p), "\n")
	if !strings.Contains(sys, "sudo") {
		t.Fatal("the system-wide instructions never mention sudo; installing a system unit requires root")
	}
	if !strings.Contains(strings.ToLower(sys), "requires root") &&
		!strings.Contains(strings.ToLower(sys), "require root") {
		t.Fatalf("the system-wide instructions do not say root is required:\n%s", sys)
	}
	if !strings.Contains(sys, "useradd") {
		t.Fatal("the system-wide instructions do not create the dedicated account they depend on")
	}
	if !strings.Contains(sys, "sudo -u "+p.ServiceUser) {
		t.Fatal("the instructions must enrol AS the service account, or the credential and private key " +
			"would belong to the wrong user")
	}
	if !strings.Contains(sys, "login --config-dir "+p.ConfigDir) {
		t.Fatalf("system login and inbox enable must use the same credential directory:\n%s", sys)
	}

	agent := strings.Join(Instructions(Launchd, p), "\n")
	if strings.Contains(agent, "sudo launchctl") {
		t.Fatal("a LaunchAgent must be bootstrapped as the user, not with sudo")
	}
	user := strings.Join(Instructions(SystemdUser, p), "\n")
	if !strings.Contains(user, "--user") {
		t.Fatal("the user-service instructions do not use `systemctl --user`")
	}
	if !strings.Contains(user, "enable-linger "+p.CurrentUser) {
		t.Fatalf("linger must be enabled for the INVOKING user, not the service account:\n%s", user)
	}
}

func TestInstructionsShellQuoteMachinePaths(t *testing.T) {
	p := testParams()
	p.Binary = "/opt/relayium apps/relayium"
	p.ConfigDir = "/var/lib/relayium inbox/config"
	p.ReceiveDir = "/srv/incoming; touch /tmp/not-command"
	p.LogDir = "/tmp/relayium logs"

	sys := strings.Join(Instructions(SystemdSystem, p), "\n")
	for _, want := range []string{
		"'/opt/relayium apps/relayium'",
		"'/var/lib/relayium inbox/config'",
		"'/srv/incoming; touch /tmp/not-command'",
	} {
		if !strings.Contains(sys, want) {
			t.Fatalf("system instructions do not shell-quote %s:\n%s", want, sys)
		}
	}
	launchd := strings.Join(Instructions(Launchd, p), "\n")
	if !strings.Contains(launchd, "'/tmp/relayium logs'") {
		t.Fatalf("launchd instructions do not shell-quote the log directory:\n%s", launchd)
	}
	if got := shellQuote("it's here"); got != "'it'\"'\"'s here'" {
		t.Fatalf("single quote escaping = %q", got)
	}
}

// TestContainerNotesDoNotPromiseAnOfficialImage. Phase 4 owns the signed image;
// claiming one exists here would be a supply-chain statement this batch has not
// earned.
func TestContainerNotesDoNotPromiseAnOfficialImage(t *testing.T) {
	notes := strings.Join(ContainerNotes(testParams()), "\n")
	if !strings.Contains(notes, "inbox\", \"run") {
		t.Fatalf("the container notes do not show the foreground entrypoint:\n%s", notes)
	}
	if !strings.Contains(strings.ToLower(notes), "no official relayium container image") {
		t.Fatalf("the container notes must say no official image is published yet:\n%s", notes)
	}
	for _, forbidden := range []string{"docker pull relayium", "ghcr.io/relayium", "docker.io/relayium"} {
		if strings.Contains(notes, forbidden) {
			t.Fatalf("the container notes advertise an image that does not exist: %q", forbidden)
		}
	}
}

// TestFileNamesAreConventional keeps the printed instructions and the file names
// they tell the operator to create in agreement.
func TestFileNamesAreConventional(t *testing.T) {
	if FileName(SystemdUser) != "relayium-inbox.service" || FileName(SystemdSystem) != "relayium-inbox.service" {
		t.Fatal("systemd unit file name changed without updating the instructions")
	}
	if FileName(Launchd) != "com.relayium.inbox.plist" {
		t.Fatal("launchd plist file name changed without updating the instructions")
	}
	for _, k := range Kinds() {
		if !strings.Contains(strings.Join(Instructions(k, testParams()), "\n"), FileName(k)) {
			t.Fatalf("the %s instructions never mention %s", k, FileName(k))
		}
	}
}

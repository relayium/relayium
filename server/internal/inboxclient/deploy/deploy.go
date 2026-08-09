// Package deploy holds the Device Inbox service definitions and renders them
// with the paths of the machine they are being installed on.
//
// WHY RENDERED AND NOT SHIPPED VERBATIM. A service file that hardcodes a path
// is either wrong on the reader's machine or right only on the author's. Every
// path in these templates is a placeholder, and `relayium inbox service` fills
// them from the running executable, the resolved config directory, and the
// receive directory the operator actually chose. Nothing here can carry a
// developer's home directory into a user's system.
//
// WHAT THIS PACKAGE DOES NOT DO. It never installs anything. Copying a unit into
// /etc/systemd/system, creating a service account, and reloading systemd all
// require root, and a CLI that quietly acquires root to "help" is a much worse
// thing than one that prints four commands. `Instructions` prints them; the
// human runs them.
package deploy

import (
	_ "embed"
	"fmt"
	"sort"
	"strings"
)

//go:embed systemd-user.service
var systemdUser string

//go:embed systemd-system.service
var systemdSystem string

//go:embed launchd.plist
var launchdPlist string

// Kind names one supported supervision target.
type Kind string

const (
	SystemdUser   Kind = "systemd-user"
	SystemdSystem Kind = "systemd-system"
	Launchd       Kind = "launchd"
)

// Kinds lists every renderable definition, in a stable order.
func Kinds() []Kind { return []Kind{SystemdUser, SystemdSystem, Launchd} }

// Params are the machine-specific values substituted into a definition.
type Params struct {
	// Binary is the absolute path of the relayium executable to supervise.
	Binary string
	// ConfigDir is the CLI configuration directory holding the credentials and
	// the Device Inbox state.
	ConfigDir string
	// StateDir is the Device Inbox state directory (inside ConfigDir).
	StateDir string
	// ReceiveDir is the fixed directory deliveries are committed into.
	ReceiveDir string
	// ServiceUser is the dedicated account a system-wide unit runs as. It is
	// deliberately NOT the invoking user: a system service that writes files a
	// remote sender named should own nothing but its own directory.
	ServiceUser string
	// CurrentUser is the invoking account, used only where the instructions
	// genuinely mean "you" — enabling linger for a user service.
	CurrentUser string
	// LogDir is where launchd writes the worker's stdout/stderr.
	LogDir string
}

// FileName is the conventional file name for a kind.
func FileName(k Kind) string {
	switch k {
	case SystemdUser, SystemdSystem:
		return "relayium-inbox.service"
	case Launchd:
		return "com.relayium.inbox.plist"
	}
	return ""
}

// ErrUnknownKind is returned for an unsupported target.
var ErrUnknownKind = fmt.Errorf("unknown service kind")

// Render substitutes p into the definition for k.
//
// Escaping is per-format and is not optional: a path containing a space breaks a
// systemd ExecStart into two arguments, and a path containing "&" or "<" makes a
// plist unparseable. Both are legal directory names, and a user who chose one
// should get a working service rather than a mysterious one.
func Render(k Kind, p Params) (string, error) {
	var tmpl string
	var escape func(string) string
	switch k {
	case SystemdUser:
		tmpl, escape = systemdUser, systemdEscape
	case SystemdSystem:
		tmpl, escape = systemdSystem, systemdEscape
	case Launchd:
		tmpl, escape = launchdPlist, xmlEscape
	default:
		return "", fmt.Errorf("%w: %q", ErrUnknownKind, k)
	}
	subs := map[string]string{
		"RELAYIUM_BIN": p.Binary,
		"CONFIG_DIR":   p.ConfigDir,
		"STATE_DIR":    p.StateDir,
		"RECEIVE_DIR":  p.ReceiveDir,
		"SERVICE_USER": p.ServiceUser,
		"CURRENT_USER": p.CurrentUser,
		"LOG_DIR":      p.LogDir,
	}
	// Longest key first so no placeholder name can be a prefix of another and
	// get half-replaced.
	names := make([]string, 0, len(subs))
	for name := range subs {
		names = append(names, name)
	}
	sort.Slice(names, func(i, j int) bool { return len(names[i]) > len(names[j]) })
	out := tmpl
	for _, name := range names {
		out = strings.ReplaceAll(out, "@"+name+"@", escape(subs[name]))
	}
	// A leftover placeholder would ship a literal "@RECEIVE_DIR@" into a unit
	// file, which systemd accepts and then fails on at runtime. Fail here instead.
	for _, name := range names {
		if strings.Contains(out, "@"+name+"@") {
			return "", fmt.Errorf("service definition still contains placeholder %q", name)
		}
	}
	return out, nil
}

// systemdEscape quotes a value for a systemd unit. systemd splits ExecStart on
// whitespace unless the argument is double-quoted, and treats a backslash as an
// escape inside quotes.
func systemdEscape(v string) string {
	if v == "" {
		return v
	}
	if !strings.ContainsAny(v, " \t\"'\\") {
		return v
	}
	r := strings.NewReplacer(`\`, `\\`, `"`, `\"`)
	return `"` + r.Replace(v) + `"`
}

// xmlEscape makes a value safe as XML character data.
func xmlEscape(v string) string {
	r := strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;", `"`, "&quot;", "'", "&apos;")
	return r.Replace(v)
}

// Instructions returns the exact commands a human runs to install a rendered
// definition, and states plainly where root is required.
func Instructions(k Kind, p Params) []string {
	bin := shellQuote(p.Binary)
	cfg := shellQuote(p.ConfigDir)
	receive := shellQuote(p.ReceiveDir)
	serviceUser := shellQuote(p.ServiceUser)
	currentUser := shellQuote(p.CurrentUser)
	logDir := shellQuote(p.LogDir)
	switch k {
	case SystemdUser:
		return []string{
			"# 1. Save the unit above (no root needed):",
			"mkdir -p ~/.config/systemd/user",
			"$EDITOR ~/.config/systemd/user/relayium-inbox.service",
			"# 2. Start it, and keep it running after you log out:",
			"systemctl --user daemon-reload",
			"systemctl --user enable --now relayium-inbox.service",
			"sudo loginctl enable-linger " + currentUser + "   # requires root; without it the service stops at logout",
			"# 3. Watch it:",
			"journalctl --user -u relayium-inbox.service -f",
		}
	case SystemdSystem:
		return []string{
			"# Every step below requires root. `relayium inbox service` deliberately",
			"# does not run any of them for you: a system-wide service and a service",
			"# account are changes an administrator should make knowingly.",
			"sudo useradd --system --home-dir /var/lib/relayium-inbox --create-home --shell /usr/sbin/nologin " + serviceUser,
			"sudo install -d -o " + serviceUser + " -g " + serviceUser + " -m 0700 " + cfg,
			"sudo install -d -o " + serviceUser + " -g " + serviceUser + " -m 0750 " + receive,
			"# Log in and enable the inbox AS THAT USER, so the credential and the",
			"# device private key belong to the account that will run the worker:",
			"sudo -u " + serviceUser + " " + bin + " login --config-dir " + cfg,
			"sudo -u " + serviceUser + " " + bin + " inbox enable --dir " + receive + " --config-dir " + cfg,
			"sudo $EDITOR /etc/systemd/system/relayium-inbox.service   # paste the unit above",
			"sudo systemctl daemon-reload",
			"sudo systemctl enable --now relayium-inbox.service",
			"sudo journalctl -u relayium-inbox.service -f",
		}
	case Launchd:
		stdoutLog := shellQuote(p.LogDir + "/relayium-inbox.log")
		stderrLog := shellQuote(p.LogDir + "/relayium-inbox.err.log")
		return []string{
			"# 1. Save the agent above (no root needed):",
			"mkdir -p ~/Library/LaunchAgents " + logDir,
			"$EDITOR ~/Library/LaunchAgents/com.relayium.inbox.plist",
			"# 2. Validate and load it:",
			"plutil -lint ~/Library/LaunchAgents/com.relayium.inbox.plist",
			"launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.relayium.inbox.plist",
			"# 3. Watch it:",
			"tail -f " + stdoutLog + " " + stderrLog,
			"# To stop:",
			"launchctl bootout gui/$(id -u)/com.relayium.inbox",
		}
	}
	return nil
}

// shellQuote returns one POSIX-shell word. Install instructions are intended to
// be pasted into a shell, and every path in them can legally contain spaces or
// metacharacters. Single-quoting (with the standard close/escape/reopen form)
// keeps those values data rather than turning a receive directory into syntax.
func shellQuote(v string) string {
	if v == "" {
		return "''"
	}
	safe := true
	for _, r := range v {
		if !((r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') ||
			(r >= '0' && r <= '9') || strings.ContainsRune("_@%+=:,./-", r)) {
			safe = false
			break
		}
	}
	if safe {
		return v
	}
	return "'" + strings.ReplaceAll(v, "'", "'\"'\"'") + "'"
}

// ContainerNotes describes running the worker as a container foreground process.
// No image is built or published here: an official image is a supply-chain
// artifact with its own signing, SBOM and provenance requirements, and shipping
// an unsigned one alongside these notes would be worse than shipping none.
func ContainerNotes(p Params) []string {
	return []string{
		"`relayium inbox run` is already a correct container entrypoint: it stays in",
		"the foreground, logs to stdout/stderr, and exits 0 on SIGTERM.",
		"",
		"  ENTRYPOINT [\"relayium\", \"inbox\", \"run\"]",
		"",
		"Mount two volumes and nothing else:",
		"  " + p.ConfigDir + "   the credential and the device private key (0700)",
		"  " + p.ReceiveDir + "   the receive directory",
		"",
		"Run `relayium login` and `relayium inbox enable --dir` once against the same",
		"config volume before starting the container; the worker refuses to invent an",
		"opt-in of its own.",
		"",
		"No official Relayium container image is published yet.",
	}
}

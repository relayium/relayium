// Package admincmd is `relayium-server admin`: the local, privileged manager
// for the Passkey-only admin console.
//
// It is the ONLY way to add, approve or revoke an admin passkey and to sign
// every admin session out. It has no network listener and exposes nothing over
// HTTP: it runs in a shell on the server, opens the server's SQLite file
// directly (account.OpenAdminAuthStore — admin tables only, no server boot
// jobs, no customer reads or writes), and exits. Whoever can run it can already
// read the database file, so it adds no privilege that shell access did not
// have.
//
// main dispatches here before parsing any server flag or reading .env, so this
// command initialises no mail, billing, storage or background work.
package admincmd

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/user"
	"strings"
	"text/tabwriter"
	"time"

	"github.com/relayium/relayium/account"
)

const usage = `relayium-server admin — manage the Passkey-only admin console (local only)

Usage:
  relayium-server admin [--db PATH] [--base-url URL] <command> [flags]

Run it on the server, as the user that owns the database (the service user,
e.g. "sudo -u relayium"). --db defaults to $RELAYIUM_DB, --base-url to
$RELAYIUM_BASE_URL; neither has a built-in default, so pass them explicitly
when the service gets them from its unit file.

Commands:
  status                                   counts of passkeys, live sessions, open enrollments
  enroll start --name NAME [--ttl 15m]     print a one-time link that creates a PENDING passkey
  enroll list                              recent enrollments and their state
  enroll status ID                         one enrollment, with the pending fingerprint
  enroll approve ID --fingerprint FP       activate the pending passkey (FP as shown in the browser)
  enroll cancel ID                         cancel an issued or pending enrollment
  credentials list                         registered passkeys (ID, name, fingerprint, last use)
  credentials revoke ID [--allow-last]     delete a passkey and end every session it opened
  sessions list                            live admin sessions (no tokens)
  sessions revoke-all                      end every session, confirmation and open enrollment

See docs/admin-passkeys.md for the full runbook.
`

// Main runs the command and returns the process exit code.
func Main(args []string, stdout, stderr io.Writer) int {
	return run(args, stdout, stderr, time.Now, isTerminal(stdout))
}

type env struct {
	db, baseURL string
	out, errw   io.Writer
	now         func() time.Time
	tty         bool
}

func run(args []string, stdout, stderr io.Writer, now func() time.Time, tty bool) int {
	g := flag.NewFlagSet("admin", flag.ContinueOnError)
	g.SetOutput(stderr)
	g.Usage = func() { fmt.Fprint(stderr, usage) }
	db := g.String("db", os.Getenv("RELAYIUM_DB"), "path of the server's SQLite database")
	base := g.String("base-url", os.Getenv("RELAYIUM_BASE_URL"), "the server's public base URL (e.g. https://relayium.com)")
	if err := g.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return 0
		}
		return 2
	}
	rest := g.Args()
	if len(rest) == 0 {
		fmt.Fprint(stderr, usage)
		return 2
	}
	e := &env{db: *db, baseURL: *base, out: stdout, errw: stderr, now: now, tty: tty}
	var err error
	switch rest[0] {
	case "help", "-h", "--help":
		fmt.Fprint(stdout, usage)
		return 0
	case "status":
		err = e.status(rest[1:])
	case "enroll":
		err = e.enroll(rest[1:])
	case "credentials":
		err = e.credentials(rest[1:])
	case "sessions":
		err = e.sessions(rest[1:])
	default:
		fmt.Fprintf(stderr, "unknown command %q\n\n%s", rest[0], usage)
		return 2
	}
	var ue usageError
	if errors.As(err, &ue) {
		fmt.Fprintf(stderr, "%v\n", err)
		return 2
	}
	if err != nil {
		fmt.Fprintf(stderr, "error: %v\n", err)
		return 1
	}
	return 0
}

type usageError struct{ msg string }

func (u usageError) Error() string { return u.msg }

// sub parses a subcommand's flags. --db/--base-url are accepted after the
// subcommand too, so either placement works.
func (e *env) sub(name string, args []string, define func(*flag.FlagSet)) (*flag.FlagSet, error) {
	fs := flag.NewFlagSet(name, flag.ContinueOnError)
	fs.SetOutput(e.errw)
	fs.StringVar(&e.db, "db", e.db, "path of the server's SQLite database")
	fs.StringVar(&e.baseURL, "base-url", e.baseURL, "the server's public base URL")
	if define != nil {
		define(fs)
	}
	if err := fs.Parse(interleave(args)); err != nil {
		return nil, usageError{err.Error()}
	}
	return fs, nil
}

// interleave lets positional arguments come before flags ("approve ID
// --fingerprint X"), which the standard flag package would otherwise stop at.
func interleave(args []string) []string {
	var flags, pos []string
	for i := 0; i < len(args); i++ {
		a := args[i]
		if a == "--" {
			pos = append(pos, args[i+1:]...)
			break
		}
		if strings.HasPrefix(a, "-") && a != "-" {
			flags = append(flags, a)
			if !strings.Contains(a, "=") && i+1 < len(args) && !isBoolFlag(a) {
				flags = append(flags, args[i+1])
				i++
			}
			continue
		}
		pos = append(pos, a)
	}
	return append(flags, append([]string{"--"}, pos...)...)
}

func isBoolFlag(a string) bool {
	a = strings.TrimLeft(a, "-")
	return a == "allow-last" || a == "allow-non-terminal"
}

func (e *env) open() (*account.AdminAuthStore, error) {
	if e.db == "" {
		return nil, usageError{"--db is required (or set RELAYIUM_DB)"}
	}
	return account.OpenAdminAuthStore(e.db)
}

func (e *env) binding() (origin, rpID string, err error) {
	if e.baseURL == "" {
		return "", "", usageError{"--base-url is required (or set RELAYIUM_BASE_URL): the passkey is bound to it"}
	}
	return account.AdminRelyingParty(e.baseURL)
}

func actor() string {
	if u, err := user.Current(); err == nil && u.Username != "" {
		return "cli:" + u.Username
	}
	return fmt.Sprintf("cli:uid-%d", os.Getuid())
}

func ts(sec int64) string {
	if sec == 0 {
		return "never"
	}
	return time.Unix(sec, 0).UTC().Format("2006-01-02 15:04:05Z")
}

func (e *env) status(args []string) error {
	if _, err := e.sub("status", args, nil); err != nil {
		return err
	}
	st, err := e.open()
	if err != nil {
		return err
	}
	defer st.Close()
	ctx := context.Background()
	creds, err := st.ListCredentials(ctx)
	if err != nil {
		return err
	}
	sessions, err := st.ListLiveSessions(ctx, e.now().Unix())
	if err != nil {
		return err
	}
	enrolls, err := st.ListEnrollments(ctx)
	if err != nil {
		return err
	}
	open := 0
	for _, en := range enrolls {
		if s := enrollState(en, e.now().Unix()); s == "issued" || s == "pending" {
			open++
		}
	}
	fmt.Fprintf(e.out, "database:          %s\n", e.db)
	fmt.Fprintf(e.out, "admin passkeys:    %d\n", len(creds))
	fmt.Fprintf(e.out, "live sessions:     %d\n", len(sessions))
	fmt.Fprintf(e.out, "open enrollments:  %d\n", open)
	if len(creds) == 0 {
		fmt.Fprintln(e.out, "No passkey is registered: nobody can sign in to /admin. Enroll one with `enroll start`.")
	} else if len(creds) == 1 {
		fmt.Fprintln(e.out, "Only one passkey is registered. Consider enrolling a second device or a hardware security key as a backup.")
	}
	return nil
}

func (e *env) enroll(args []string) error {
	if len(args) == 0 {
		return usageError{"usage: enroll start|list|status|approve|cancel"}
	}
	switch args[0] {
	case "start":
		return e.enrollStart(args[1:])
	case "list":
		return e.enrollList(args[1:])
	case "status":
		return e.enrollStatus(args[1:])
	case "approve":
		return e.enrollApprove(args[1:])
	case "cancel":
		return e.enrollCancel(args[1:])
	}
	return usageError{fmt.Sprintf("unknown enroll command %q", args[0])}
}

func (e *env) enrollStart(args []string) error {
	var name string
	var ttl time.Duration
	var allowNonTTY bool
	if _, err := e.sub("enroll start", args, func(fs *flag.FlagSet) {
		fs.StringVar(&name, "name", "", "label for the new passkey, e.g. \"MacBook\" or \"YubiKey backup\"")
		fs.DurationVar(&ttl, "ttl", 15*time.Minute, "how long the link (and its pending passkey) stays valid, 1m-1h")
		fs.BoolVar(&allowNonTTY, "allow-non-terminal", false, "print the one-time link even though stdout is not a terminal")
	}); err != nil {
		return err
	}
	if name == "" {
		return usageError{"--name is required"}
	}
	// The link is a bearer secret until it is spent or expires. Refuse to write
	// it into a pipe or a log file by accident.
	if !e.tty && !allowNonTTY {
		return usageError{"stdout is not a terminal; refusing to print the one-time enrollment link (pass --allow-non-terminal if you really mean it)"}
	}
	origin, rpID, err := e.binding()
	if err != nil {
		return err
	}
	st, err := e.open()
	if err != nil {
		return err
	}
	defer st.Close()
	g, err := st.StartEnrollment(context.Background(), name, origin, rpID, ttl, e.now().Unix(), actor())
	if err != nil {
		return err
	}
	fmt.Fprintf(e.out, "Enrollment %s for %q created; it expires at %s.\n\n", g.ID, g.Name, ts(g.ExpiresAt))
	fmt.Fprintln(e.out, "Open this one-time link in the browser on the device that will hold the passkey.")
	fmt.Fprintln(e.out, "It is a secret until used: do not paste it into chat, tickets or shared notes.")
	fmt.Fprintln(e.out)
	fmt.Fprintf(e.out, "  %s/admin/enroll#%s\n\n", origin, g.Grant)
	fmt.Fprintln(e.out, "After the browser shows a fingerprint, approve it here:")
	fmt.Fprintf(e.out, "  relayium-server admin enroll approve %s --fingerprint <FINGERPRINT>\n", g.ID)
	return nil
}

// enrollState reports an enrollment's effective state, folding expiry in.
func enrollState(en account.AdminEnrollment, now int64) string {
	if (en.State == "issued" || en.State == "pending") && en.ExpiresAt <= now {
		return "expired"
	}
	return en.State
}

func (e *env) enrollList(args []string) error {
	if _, err := e.sub("enroll list", args, nil); err != nil {
		return err
	}
	st, err := e.open()
	if err != nil {
		return err
	}
	defer st.Close()
	list, err := st.ListEnrollments(context.Background())
	if err != nil {
		return err
	}
	if len(list) == 0 {
		fmt.Fprintln(e.out, "No enrollments.")
		return nil
	}
	tw := tabwriter.NewWriter(e.out, 0, 2, 2, ' ', 0)
	fmt.Fprintln(tw, "ID\tNAME\tSTATE\tCREATED\tEXPIRES\tFINGERPRINT")
	for _, en := range list {
		fmt.Fprintf(tw, "%s\t%s\t%s\t%s\t%s\t%s\n", en.ID, en.Name, enrollState(en, e.now().Unix()),
			ts(en.CreatedAt), ts(en.ExpiresAt), dash(en.Fingerprint))
	}
	return tw.Flush()
}

func dash(s string) string {
	if s == "" {
		return "-"
	}
	return s
}

func oneID(fs *flag.FlagSet, what string) (string, error) {
	if fs.NArg() != 1 || strings.TrimSpace(fs.Arg(0)) == "" {
		return "", usageError{"exactly one " + what + " ID is required"}
	}
	return strings.TrimSpace(fs.Arg(0)), nil
}

func (e *env) enrollStatus(args []string) error {
	fs, err := e.sub("enroll status", args, nil)
	if err != nil {
		return err
	}
	id, err := oneID(fs, "enrollment")
	if err != nil {
		return err
	}
	st, err := e.open()
	if err != nil {
		return err
	}
	defer st.Close()
	en, ok, err := st.Enrollment(context.Background(), id)
	if err != nil {
		return err
	}
	if !ok {
		return account.ErrAdminEnrollmentNotFound
	}
	fmt.Fprintf(e.out, "enrollment:   %s\n", en.ID)
	fmt.Fprintf(e.out, "name:         %s\n", en.Name)
	fmt.Fprintf(e.out, "state:        %s\n", enrollState(en, e.now().Unix()))
	fmt.Fprintf(e.out, "bound to:     %s (RP ID %s)\n", en.Origin, en.RPID)
	fmt.Fprintf(e.out, "created:      %s\n", ts(en.CreatedAt))
	fmt.Fprintf(e.out, "expires:      %s\n", ts(en.ExpiresAt))
	fmt.Fprintf(e.out, "fingerprint:  %s\n", dash(en.Fingerprint))
	return nil
}

func (e *env) enrollApprove(args []string) error {
	var fp string
	fs, err := e.sub("enroll approve", args, func(fs *flag.FlagSet) {
		fs.StringVar(&fp, "fingerprint", "", "the fingerprint the enrollment page showed (required)")
	})
	if err != nil {
		return err
	}
	id, err := oneID(fs, "enrollment")
	if err != nil {
		return err
	}
	if strings.TrimSpace(fp) == "" {
		return usageError{"--fingerprint is required: type the fingerprint the browser showed, so you approve exactly that passkey"}
	}
	origin, rpID, err := e.binding()
	if err != nil {
		return err
	}
	st, err := e.open()
	if err != nil {
		return err
	}
	defer st.Close()
	c, err := st.ApproveEnrollment(context.Background(), id, fp, origin, rpID, e.now().Unix(), actor())
	if err != nil {
		return err
	}
	fmt.Fprintf(e.out, "Approved: passkey %q (ID %s, fingerprint %s) can now sign in to %s/admin.\n",
		c.Name, c.ID, account.AdminCredentialFingerprint(c), origin)
	return nil
}

func (e *env) enrollCancel(args []string) error {
	fs, err := e.sub("enroll cancel", args, nil)
	if err != nil {
		return err
	}
	id, err := oneID(fs, "enrollment")
	if err != nil {
		return err
	}
	st, err := e.open()
	if err != nil {
		return err
	}
	defer st.Close()
	if err := st.CancelEnrollment(context.Background(), id, e.now().Unix(), actor()); err != nil {
		return err
	}
	fmt.Fprintf(e.out, "Cancelled enrollment %s.\n", id)
	return nil
}

func (e *env) credentials(args []string) error {
	if len(args) == 0 {
		return usageError{"usage: credentials list|revoke"}
	}
	switch args[0] {
	case "list":
		if _, err := e.sub("credentials list", args[1:], nil); err != nil {
			return err
		}
		st, err := e.open()
		if err != nil {
			return err
		}
		defer st.Close()
		creds, err := st.ListCredentials(context.Background())
		if err != nil {
			return err
		}
		if len(creds) == 0 {
			fmt.Fprintln(e.out, "No admin passkey is registered.")
			return nil
		}
		tw := tabwriter.NewWriter(e.out, 0, 2, 2, ' ', 0)
		fmt.Fprintln(tw, "ID\tNAME\tFINGERPRINT\tADDED\tLAST USED")
		for _, c := range creds {
			fmt.Fprintf(tw, "%s\t%s\t%s\t%s\t%s\n", c.ID, c.Name, account.AdminCredentialFingerprint(c), ts(c.CreatedAt), ts(c.LastUsedAt))
		}
		return tw.Flush()
	case "revoke":
		var allowLast bool
		fs, err := e.sub("credentials revoke", args[1:], func(fs *flag.FlagSet) {
			fs.BoolVar(&allowLast, "allow-last", false, "allow revoking the only registered passkey")
		})
		if err != nil {
			return err
		}
		id, err := oneID(fs, "passkey")
		if err != nil {
			return err
		}
		st, err := e.open()
		if err != nil {
			return err
		}
		defer st.Close()
		n, err := st.RevokeCredential(context.Background(), id, allowLast, e.now().Unix(), actor())
		if err != nil {
			return err
		}
		fmt.Fprintf(e.out, "Revoked passkey %s and ended %d session(s) it had opened.\n", id, n)
		return nil
	}
	return usageError{fmt.Sprintf("unknown credentials command %q", args[0])}
}

func (e *env) sessions(args []string) error {
	if len(args) == 0 {
		return usageError{"usage: sessions list|revoke-all"}
	}
	switch args[0] {
	case "list":
		if _, err := e.sub("sessions list", args[1:], nil); err != nil {
			return err
		}
		st, err := e.open()
		if err != nil {
			return err
		}
		defer st.Close()
		list, err := st.ListLiveSessions(context.Background(), e.now().Unix())
		if err != nil {
			return err
		}
		if len(list) == 0 {
			fmt.Fprintln(e.out, "No live admin sessions.")
			return nil
		}
		tw := tabwriter.NewWriter(e.out, 0, 2, 2, ' ', 0)
		fmt.Fprintln(tw, "PASSKEY ID\tSIGNED IN\tLAST ACTIVE")
		for _, s := range list {
			fmt.Fprintf(tw, "%s\t%s\t%s\n", s.CredentialID, ts(s.CreatedAt), ts(s.LastSeenAt))
		}
		return tw.Flush()
	case "revoke-all":
		if _, err := e.sub("sessions revoke-all", args[1:], nil); err != nil {
			return err
		}
		st, err := e.open()
		if err != nil {
			return err
		}
		defer st.Close()
		r, err := st.RevokeAllSessions(context.Background(), e.now().Unix(), actor())
		if err != nil {
			return err
		}
		fmt.Fprintf(e.out, "Ended %d session(s), dropped %d pending confirmation(s) and %d in-flight passkey challenge(s), cancelled %d open enrollment(s). Registered passkeys are unchanged.\n",
			r.Sessions, r.PendingActions, r.Ceremonies, r.Enrollments)
		return nil
	}
	return usageError{fmt.Sprintf("unknown sessions command %q", args[0])}
}

func isTerminal(w io.Writer) bool {
	f, ok := w.(*os.File)
	if !ok {
		return false
	}
	fi, err := f.Stat()
	return err == nil && fi.Mode()&os.ModeCharDevice != 0
}

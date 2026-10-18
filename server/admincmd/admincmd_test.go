package admincmd

import (
	"bytes"
	"context"
	"database/sql"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/relayium/relayium/account"
)

// newDB creates an initialised server database file the way the server would,
// then closes it so the command opens it the way an operator would.
func newDB(t *testing.T) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "relayium.db")
	st, err := account.OpenSQLite(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := st.Close(); err != nil {
		t.Fatal(err)
	}
	return path
}

var fixedNow = func() time.Time { return time.Unix(1_800_000_000, 0) }

func cli(t *testing.T, tty bool, args ...string) (code int, stdout, stderr string) {
	t.Helper()
	t.Setenv("RELAYIUM_DB", "")
	t.Setenv("RELAYIUM_BASE_URL", "")
	var o, e bytes.Buffer
	code = run(args, &o, &e, fixedNow, tty)
	return code, o.String(), e.String()
}

var linkRE = regexp.MustCompile(`https://admin\.example/admin/enroll#([0-9a-f]{64})`)

func TestEnrollStartPrintsTheLinkOnceAndOnlyToATerminal(t *testing.T) {
	db := newDB(t)
	base := []string{"--db", db, "--base-url", "https://admin.example"}

	// Not a terminal: refused, nothing created, no link anywhere.
	code, out, errOut := cli(t, false, append(base, "enroll", "start", "--name", "MacBook")...)
	if code != 2 || linkRE.MatchString(out+errOut) {
		t.Fatalf("non-terminal start: code %d out=%q err=%q", code, out, errOut)
	}
	if code, out, _ := cli(t, true, append(base, "enroll", "list")...); code != 0 || !strings.Contains(out, "No enrollments") {
		t.Fatalf("refused start still created an enrollment: %q", out)
	}

	// Terminal: exactly one link, on stdout only.
	code, out, errOut = cli(t, true, append(base, "enroll", "start", "--name", "MacBook")...)
	if code != 0 {
		t.Fatalf("start: %d %s", code, errOut)
	}
	if m := linkRE.FindAllString(out, -1); len(m) != 1 {
		t.Fatalf("start printed %d links: %q", len(m), out)
	}
	if linkRE.MatchString(errOut) {
		t.Fatal("link printed to stderr")
	}
	grant := linkRE.FindStringSubmatch(out)[1]

	// The grant is never shown again: not by list, status, or in the audit.
	idRE := regexp.MustCompile(`Enrollment (\w+) for`)
	id := idRE.FindStringSubmatch(out)[1]
	for _, args := range [][]string{{"enroll", "list"}, {"enroll", "status", id}, {"status"}} {
		_, o, e := cli(t, true, append(base, args...)...)
		if strings.Contains(o+e, grant) {
			t.Fatalf("%v re-printed the grant", args)
		}
	}
	a, err := account.OpenAdminAuthStore(db)
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	en, ok, _ := a.Enrollment(context.Background(), id)
	if !ok || en.State != "issued" || en.Origin != "https://admin.example" || en.RPID != "admin.example" {
		t.Fatalf("stored enrollment: %+v", en)
	}
	raw, _ := os.ReadFile(db)
	if bytes.Contains(raw, []byte(grant)) {
		t.Fatal("the raw grant is in the database file")
	}
}

func TestApproveRequiresFingerprintAndBaseURL(t *testing.T) {
	db := newDB(t)
	if code, _, e := cli(t, true, "--db", db, "--base-url", "https://admin.example", "enroll", "approve", "abc"); code != 2 || !strings.Contains(e, "--fingerprint is required") {
		t.Fatalf("approve without fingerprint: %d %q", code, e)
	}
	if code, _, e := cli(t, true, "--db", db, "enroll", "approve", "abc", "--fingerprint", "X"); code != 2 || !strings.Contains(e, "--base-url is required") {
		t.Fatalf("approve without base URL: %d %q", code, e)
	}
	if code, _, e := cli(t, true, "--db", db, "--base-url", "https://admin.example", "enroll", "approve", "nope", "--fingerprint", "AAAA"); code != 1 || !strings.Contains(e, "not found") {
		t.Fatalf("approve unknown: %d %q", code, e)
	}
}

func TestRefusesMissingDatabaseWithoutCreatingIt(t *testing.T) {
	missing := filepath.Join(t.TempDir(), "typo.db")
	if code, _, e := cli(t, true, "--db", missing, "status"); code != 1 || !strings.Contains(e, "refusing to create") {
		t.Fatalf("missing db: %d %q", code, e)
	}
	if _, err := os.Stat(missing); !os.IsNotExist(err) {
		t.Fatal("the command created a database file")
	}
	if code, _, e := cli(t, true, "status"); code != 2 || !strings.Contains(e, "--db is required") {
		t.Fatalf("no db: %d %q", code, e)
	}
}

func TestCredentialRevokeAndRevokeAll(t *testing.T) {
	db := newDB(t)
	st, err := account.OpenSQLite(db)
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	for _, id := range []string{"key-a", "key-b"} {
		if _, err := st.AdminAuth().StartEnrollment(ctx, id, "https://admin.example", "admin.example", 0, fixedNow().Unix(), "t"); err != nil {
			t.Fatal(err)
		}
	}
	st.Close()
	// Seed two credentials directly (as approved enrollments would leave them).
	seed := func(id string) {
		raw, err := sql.Open("sqlite", db)
		if err != nil {
			t.Fatal(err)
		}
		defer raw.Close()
		if _, err := raw.Exec(`INSERT INTO admin_credentials (id, user_handle, cred_json, name, created_at, last_used_at)
			VALUES (?, x'00', '{}', ?, 1, 0)`, id, id); err != nil {
			t.Fatal(err)
		}
	}
	seed("key-a")
	seed("key-b")
	base := []string{"--db", db}

	code, out, _ := cli(t, true, append(base, "credentials", "list")...)
	if code != 0 || !strings.Contains(out, "key-a") || !strings.Contains(out, "key-b") {
		t.Fatalf("list: %d %q", code, out)
	}
	if code, out, _ := cli(t, true, append(base, "credentials", "revoke", "key-a")...); code != 0 || !strings.Contains(out, "Revoked passkey key-a") {
		t.Fatalf("revoke: %d %q", code, out)
	}
	if code, _, e := cli(t, true, append(base, "credentials", "revoke", "key-b")...); code != 1 || !strings.Contains(e, "--allow-last") {
		t.Fatalf("revoking the last key without --allow-last: %d %q", code, e)
	}
	if code, _, _ := cli(t, true, append(base, "credentials", "revoke", "key-b", "--allow-last")...); code != 0 {
		t.Fatal("revoke --allow-last failed")
	}
	if code, out, _ := cli(t, true, append(base, "sessions", "revoke-all")...); code != 0 || !strings.Contains(out, "cancelled 2 open enrollment") {
		t.Fatalf("revoke-all: %d %q", code, out)
	}
	_, out, _ = cli(t, true, append(base, "status")...)
	if !strings.Contains(out, "admin passkeys:    0") || !strings.Contains(out, "nobody can sign in") {
		t.Fatalf("status: %q", out)
	}
}

func TestHelpAndUnknownCommands(t *testing.T) {
	if code, out, _ := cli(t, true, "help"); code != 0 || !strings.Contains(out, "enroll approve ID --fingerprint FP") {
		t.Fatalf("help: %d %q", code, out)
	}
	if code, _, e := cli(t, true, "frobnicate"); code != 2 || !strings.Contains(e, "unknown command") {
		t.Fatalf("unknown: %d %q", code, e)
	}
	if code, _, _ := cli(t, true); code != 2 {
		t.Fatal("no command must be a usage error")
	}
}

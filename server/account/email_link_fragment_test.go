package account

import (
	"context"
	"net/url"
	"strings"
	"testing"
)

// Every emailed bearer credential must stay out of the HTTP request target.
// A new mailer method or a regression to ?token= belongs in this one table.
func TestAllEmailCredentialLinksUseFragments(t *testing.T) {
	ctx := context.Background()
	svc, mail := newTestService(t)
	u, err := svc.Register(ctx, "links@example.com", "password-1", "")
	if err != nil {
		t.Fatal(err)
	}
	if err := svc.RequestMagicLink(ctx, u.Email); err != nil {
		t.Fatal(err)
	}
	if err := svc.RequestPasswordReset(ctx, u.Email); err != nil {
		t.Fatal(err)
	}
	if err := svc.RequestAccountDeletion(ctx, u.ID, u.Email); err != nil {
		t.Fatal(err)
	}
	reactivate, err := svc.IssueReactivateLink(ctx, u.ID, u.Email)
	if err != nil {
		t.Fatal(err)
	}
	passwordless, err := svc.store.UpsertUserByEmail(ctx, "passwordless-links@example.com", "Passwordless")
	if err != nil {
		t.Fatal(err)
	}
	if err := svc.RequestFirstPasswordProof(ctx, passwordless); err != nil {
		t.Fatal(err)
	}

	links := map[string]string{
		"verify":       mail.verify,
		"magic":        mail.magic,
		"reset":        mail.reset,
		"set-password": mail.firstPassword,
		"delete":       mail.deleteConfirm,
		"reactivate":   reactivate,
	}
	for kind, link := range links {
		t.Run(kind, func(t *testing.T) {
			u, err := url.Parse(link)
			if err != nil {
				t.Fatalf("parse %q: %v", link, err)
			}
			if u.RawQuery != "" || strings.Contains(u.Path, "token=") {
				t.Fatalf("credential appears in HTTP request target: %q", link)
			}
			if !strings.HasPrefix(u.Fragment, "token=") || len(u.Fragment) == len("token=") {
				t.Fatalf("missing credential fragment: %q", link)
			}
		})
	}
}

package main

import (
	"strings"
	"testing"
)

const localBase = "http://localhost:8080"

// TestPlanMailAutoWithoutSMTPIsRedacted: the default posture. No SMTP means no
// mail is delivered, the log mailer stays redacted, and the operator is warned
// in terms that name the user-visible consequence.
func TestPlanMailAutoWithoutSMTPIsRedacted(t *testing.T) {
	p, err := planMail("", "", "noreply@relayium.com", "", "https://relayium.com")
	if err != nil {
		t.Fatalf("auto with no SMTP must be valid: %v", err)
	}
	if p.Transport != mailTransportAuto || p.UseSMTP || p.RevealLinks {
		t.Fatalf("want redacted log mailer, got %+v", p)
	}
	if len(p.Warnings) == 0 {
		t.Error("a deployment that delivers no email must warn")
	}
	if !strings.Contains(strings.Join(p.Warnings, " "), "NO EMAIL") {
		t.Errorf("the warning should name the consequence: %v", p.Warnings)
	}
}

// TestPlanMailAutoWithSMTPUsesSMTP: auto is the only transport whose outcome
// depends on other configuration.
func TestPlanMailAutoWithSMTPUsesSMTP(t *testing.T) {
	p, err := planMail("auto", "mail.relayium.com:587", "noreply@relayium.com", "smtpuser", "https://relayium.com")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !p.UseSMTP || p.RevealLinks {
		t.Fatalf("want SMTP without reveal, got %+v", p)
	}
}

// TestPlanMailSMTPRequiresAddr is I7: selecting smtp without an address is a
// boot failure, never a silent downgrade to logging.
func TestPlanMailSMTPRequiresAddr(t *testing.T) {
	for _, addr := range []string{"", "   "} {
		if _, err := planMail("smtp", addr, "noreply@relayium.com", "", "https://relayium.com"); err == nil {
			t.Fatalf("smtp with addr %q must fail at startup", addr)
		}
	}
	if _, err := planMail("smtp", "mail.relayium.com:587", "noreply@relayium.com", "", "https://relayium.com"); err != nil {
		t.Fatalf("smtp with an addr must succeed: %v", err)
	}
}

// TestPlanMailSummaryHasNoSecret is I10: the boot line describes the transport
// without printing the SMTP username or password.
func TestPlanMailSummaryHasNoSecret(t *testing.T) {
	p, err := planMail("smtp", "mail.relayium.com:587", "noreply@relayium.com", "smtp-login-name", "https://relayium.com")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	all := p.Summary + " " + strings.Join(p.Warnings, " ")
	for _, secret := range []string{"smtp-login-name"} {
		if strings.Contains(all, secret) {
			t.Errorf("boot output leaked %q: %s", secret, all)
		}
	}
	for _, want := range []string{"transport=smtp", "addr=mail.relayium.com:587", "from=noreply@relayium.com", "auth=configured"} {
		if !strings.Contains(p.Summary, want) {
			t.Errorf("summary missing %q: %s", want, p.Summary)
		}
	}
	noAuth, err := planMail("smtp", "127.0.0.1:25", "noreply@relayium.com", "", localBase)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !strings.Contains(noAuth.Summary, "auth=none") {
		t.Errorf("unauthenticated relay should report auth=none: %s", noAuth.Summary)
	}
}

// TestPlanMailDevLogLinksNeedsAllThreeConditions is I6, the security core: the
// plaintext-link transport requires an explicit selection, no SMTP, AND a
// literal local base URL. Each condition is shown to be independently required.
func TestPlanMailDevLogLinksNeedsAllThreeConditions(t *testing.T) {
	// All three hold.
	p, err := planMail("dev-log-links", "", "noreply@relayium.com", "", localBase)
	if err != nil {
		t.Fatalf("the fully local case must be allowed: %v", err)
	}
	if !p.RevealLinks || p.UseSMTP {
		t.Fatalf("want a revealing log mailer, got %+v", p)
	}
	if len(p.Warnings) == 0 || !strings.Contains(strings.Join(p.Warnings, " "), "never on a shared") {
		t.Errorf("plaintext links must carry an explicit warning: %v", p.Warnings)
	}

	// Condition 2 removed: SMTP configured alongside it.
	if _, err := planMail("dev-log-links", "mail.relayium.com:587", "noreply@relayium.com", "", localBase); err == nil {
		t.Error("dev-log-links must refuse to run alongside SMTP")
	}

	// Condition 3 removed: a non-local base URL.
	for _, base := range []string{
		"https://relayium.com",
		"https://relayium.com:8080",
		"http://8.8.8.8:8080",
		"http://[2606:4700:4700::1111]:8080",
		"http://relayium.internal:8080",  // a NAME, however local it looks
		"http://0.0.0.0:8080",            // the wildcard is not a local address
		"http://localhost.relayium.com/", // suffix trick
		"http://notlocalhost/",           // prefix trick
		"http://127.0.0.1.relayium.com/", // IP-shaped name
		"ftp://127.0.0.1/",               // wrong scheme
		"",
		"://broken",
	} {
		if _, err := planMail("dev-log-links", "", "noreply@relayium.com", "", base); err == nil {
			t.Errorf("dev-log-links must refuse base URL %q", base)
		}
	}

	// Literal local addresses that ARE allowed.
	for _, base := range []string{
		"http://localhost:8080",
		"http://LOCALHOST:8080",
		"http://127.0.0.1:18080",
		"http://127.9.9.9/",
		"http://[::1]:8080",
		"http://10.0.0.5:8080",
		"http://192.168.1.10:8080",
		"http://172.16.4.4:8080",
		"http://169.254.10.1:8080", // link-local
		"http://[fd00::1]:8080",    // ULA
		"https://127.0.0.1:8443",
	} {
		if _, err := planMail("dev-log-links", "", "noreply@relayium.com", "", base); err != nil {
			t.Errorf("base URL %q should be accepted as local: %v", base, err)
		}
	}
}

// TestPlanMailUnknownTransportFails: a typo must not silently fall back to a
// permissive default in either direction.
func TestPlanMailUnknownTransportFails(t *testing.T) {
	for _, tr := range []string{"log", "dev", "none", "smtps", "dev_log_links", "log-links"} {
		if _, err := planMail(tr, "", "noreply@relayium.com", "", localBase); err == nil {
			t.Errorf("transport %q should be rejected", tr)
		}
	}
}

// TestPlanMailNormalizesTransport: surrounding whitespace and case from a .env
// file must not change the decision.
func TestPlanMailNormalizesTransport(t *testing.T) {
	for _, tr := range []string{" SMTP ", "Smtp", "smtp\t"} {
		p, err := planMail(tr, "mail.relayium.com:587", "noreply@relayium.com", "", localBase)
		if err != nil {
			t.Fatalf("%q: %v", tr, err)
		}
		if p.Transport != mailTransportSMTP || !p.UseSMTP {
			t.Errorf("%q should normalize to smtp, got %+v", tr, p)
		}
	}
}

// TestPlanMailNeverRevealsExceptDevLogLinks is the summary invariant: no input
// other than an explicit dev-log-links selection can produce RevealLinks.
func TestPlanMailNeverRevealsExceptDevLogLinks(t *testing.T) {
	bases := []string{localBase, "http://127.0.0.1:8080", "https://relayium.com", ""}
	addrs := []string{"", "mail.relayium.com:587"}
	for _, tr := range []string{"", "auto", "smtp", "AUTO"} {
		for _, addr := range addrs {
			for _, base := range bases {
				p, err := planMail(tr, addr, "noreply@relayium.com", "u", base)
				if err != nil {
					continue // rejected configurations reveal nothing at all
				}
				if p.RevealLinks {
					t.Errorf("transport=%q addr=%q base=%q must not reveal links", tr, addr, base)
				}
			}
		}
	}
}

// TestPlanMailWarnsOnEmptyFrom: SMTP with no From is a delivery failure waiting
// to happen at the relay, so it is surfaced at boot.
func TestPlanMailWarnsOnEmptyFrom(t *testing.T) {
	p, err := planMail("smtp", "mail.relayium.com:587", "", "", localBase)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(p.Warnings) == 0 {
		t.Error("an empty From address should warn")
	}
}

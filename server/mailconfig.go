package main

import (
	"fmt"
	"net"
	"net/url"
	"strings"
)

// The selectable mail transports. The value is what an operator writes in
// RELAYIUM_MAIL_TRANSPORT or -mail-transport.
const (
	// mailTransportAuto sends by SMTP when an SMTP address is configured and
	// otherwise falls back to the REDACTED log mailer. It is the default and
	// the only value that changes behaviour based on other configuration.
	mailTransportAuto = "auto"
	// mailTransportSMTP requires SMTP. Missing an address is a fatal boot
	// error rather than a silent downgrade to logging, so a deployment that
	// believes it emails its users never quietly stops.
	mailTransportSMTP = "smtp"
	// mailTransportDevLogLinks prints full credential-bearing links to the log
	// for local development. It is accepted only under the three conditions
	// enforced in planMail.
	mailTransportDevLogLinks = "dev-log-links"
)

// mailPlan is the resolved, non-secret outcome of the mail configuration. main
// turns it into a Mailer and prints Summary plus every entry of Warnings.
type mailPlan struct {
	Transport   string   // normalized transport name
	UseSMTP     bool     // build an SMTPMailer rather than a LogMailer
	RevealLinks bool     // the single place that authorizes plaintext links
	Summary     string   // one non-secret boot line, always present
	Warnings    []string // operator-visible hazards, may be empty
}

// planMail validates the mail configuration and decides which mailer to build.
// It resolves everything from the passed values alone — it performs no name
// resolution and reads no environment — so the decision is deterministic and
// cannot be changed by a DNS answer between boot and the first email.
//
// It returns an error for exactly the contradictory configurations: an unknown
// transport, "smtp" without an address, and "dev-log-links" that is not
// provably local.
func planMail(transport, smtpAddr, smtpFrom, smtpUser, baseURL string) (mailPlan, error) {
	t := strings.ToLower(strings.TrimSpace(transport))
	if t == "" {
		t = mailTransportAuto
	}
	smtpAddr = strings.TrimSpace(smtpAddr)

	switch t {
	case mailTransportAuto:
		if smtpAddr != "" {
			return smtpPlan(t, smtpAddr, smtpFrom, smtpUser), nil
		}
		return mailPlan{
			Transport: t,
			Summary:   "mail: transport=auto mailer=log-redacted (no SMTP address configured)",
			Warnings: []string{
				"WARNING: no SMTP address is configured, so Relayium DELIVERS NO EMAIL. " +
					"Email verification, password reset and account-deletion confirmation " +
					"cannot complete for your users. Their links are recorded REDACTED in " +
					"this log. Set RELAYIUM_SMTP_ADDR for a real deployment.",
			},
		}, nil

	case mailTransportSMTP:
		if smtpAddr == "" {
			return mailPlan{}, fmt.Errorf(
				"mail transport %q requires an SMTP address: set RELAYIUM_SMTP_ADDR (or -smtp-addr), "+
					"or choose RELAYIUM_MAIL_TRANSPORT=auto to fall back to a redacted log", t)
		}
		return smtpPlan(t, smtpAddr, smtpFrom, smtpUser), nil

	case mailTransportDevLogLinks:
		if smtpAddr != "" {
			return mailPlan{}, fmt.Errorf(
				"mail transport %q prints credential links in plaintext and refuses to run alongside SMTP: "+
					"unset RELAYIUM_SMTP_ADDR (or -smtp-addr), or choose RELAYIUM_MAIL_TRANSPORT=smtp", t)
		}
		if err := requireLocalBaseURL(baseURL); err != nil {
			return mailPlan{}, fmt.Errorf("mail transport %q: %w", t, err)
		}
		return mailPlan{
			Transport:   t,
			RevealLinks: true,
			Summary:     "mail: transport=dev-log-links mailer=log-plaintext base-url=" + baseURL,
			Warnings: []string{
				"WARNING: mail transport dev-log-links prints FULL sign-in, verification, " +
					"password-reset and account-deletion links, tokens included, to this log. " +
					"Anyone who can read the log can take over an account. Local development only — " +
					"never on a shared, hosted or production instance.",
			},
		}, nil
	}

	return mailPlan{}, fmt.Errorf(
		"unknown mail transport %q: valid values are %q, %q and %q",
		transport, mailTransportAuto, mailTransportSMTP, mailTransportDevLogLinks)
}

// smtpPlan builds the SMTP outcome and its non-secret summary. The summary
// names the address, the From header and WHETHER authentication is configured;
// it never prints the SMTP username or password.
func smtpPlan(transport, smtpAddr, smtpFrom, smtpUser string) mailPlan {
	auth := "none"
	if strings.TrimSpace(smtpUser) != "" {
		auth = "configured"
	}
	p := mailPlan{
		Transport: transport,
		UseSMTP:   true,
		Summary: fmt.Sprintf("mail: transport=%s mailer=smtp addr=%s from=%s auth=%s",
			transport, smtpAddr, smtpFrom, auth),
	}
	if strings.TrimSpace(smtpFrom) == "" {
		p.Warnings = append(p.Warnings,
			"WARNING: SMTP is configured with an empty From address; many relays reject such a message. "+
				"Set RELAYIUM_SMTP_FROM.")
	}
	return p
}

// requireLocalBaseURL accepts a base URL only when its host is UNAMBIGUOUSLY
// this machine or a private network, decided from the literal text:
//
//   - the exact name "localhost", or
//   - an IP literal that is loopback, private (RFC 1918 / RFC 4193 ULA) or
//     link-local.
//
// Any other hostname is refused even if it currently resolves somewhere local.
// Nothing is looked up, so the answer cannot change under the server, and a
// public deployment cannot be talked into plaintext links by a DNS record.
func requireLocalBaseURL(baseURL string) error {
	raw := strings.TrimSpace(baseURL)
	if raw == "" {
		return fmt.Errorf("base URL is empty; it must be a local http(s) URL such as http://localhost:8080")
	}
	u, err := url.Parse(raw)
	if err != nil {
		return fmt.Errorf("base URL is not a valid URL")
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return fmt.Errorf("base URL must use http or https")
	}
	host := u.Hostname()
	if host == "" {
		return fmt.Errorf("base URL has no host")
	}
	if strings.EqualFold(host, "localhost") {
		return nil
	}
	ip := net.ParseIP(host)
	if ip == nil {
		return fmt.Errorf(
			"base URL host %q is a name, not a literal local address; plaintext mail links are allowed only on "+
				"localhost or a literal loopback/private/link-local IP, because a name can resolve anywhere", host)
	}
	if ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast() {
		return nil
	}
	return fmt.Errorf(
		"base URL host %q is a public address; plaintext mail links are allowed only on localhost or a "+
			"literal loopback/private/link-local IP", host)
}

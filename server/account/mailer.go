package account

import (
	"context"
	"fmt"
	"log"
	"net"
	"net/mail"
	"net/smtp"
	"net/url"
	"strings"
	"time"

	"github.com/relayium/relayium/authx"
)

// Mailer sends the magic-link email. Abstracted so dev uses a log and prod uses SMTP.
type Mailer interface {
	SendMagicLink(ctx context.Context, email, link string) error
	SendVerifyEmail(ctx context.Context, email, link string) error
	SendPasswordReset(ctx context.Context, email, link string) error
	// SendAccountDeletionConfirm emails the double-opt-in confirm link for a
	// self-serve account-deletion request (Task 3). No account state changes
	// until the link is used.
	SendAccountDeletionConfirm(ctx context.Context, email, link string) error
	// SendAccountDeletionScheduled emails confirmation that deletion is
	// scheduled: the account is now suspended and will be hard-purged at
	// purgeAt (unix seconds) unless reactivateLink is used first.
	SendAccountDeletionScheduled(ctx context.Context, email string, purgeAt int64, reactivateLink string) error
	// SendAccountDeletionReminder emails a one-time warning shortly before
	// purgeAt that the grace window is about to end (Task 5).
	SendAccountDeletionReminder(ctx context.Context, email string, purgeAt int64, reactivateLink string) error
	// SendAccountDeleted emails final confirmation once GC has hard-purged the
	// account (Task 5).
	SendAccountDeleted(ctx context.Context, email string) error
}

// LogMailer records mail events on a log instead of sending them. It exists so
// a deployment without SMTP still boots and still tells an operator that a mail
// event happened — not so that credentials end up in a log file.
//
// By default it is REDACTED: the recipient's local part is masked, and a
// credential-bearing link is reduced to its URL path, because the token lives in
// the query or the fragment. Anything that does not parse is replaced outright,
// so no caller-controlled bytes (newlines, control characters, terminal escapes)
// can be written into the log.
//
// The zero value is usable and safe: a nil Log falls back to the standard
// logger, and RevealLinks defaults to false.
type LogMailer struct {
	Log *log.Logger

	// RevealLinks prints the full recipient and the full credential-bearing
	// link. It defeats every redaction in this type and is for local
	// development only. Exactly one non-test production site constructs it
	// true — the `dev-log-links` mail transport in the server's main package,
	// which the server accepts only when no SMTP is configured AND the base URL
	// is a literal local address. Do not set it anywhere else.
	RevealLinks bool
}

// redactedPlaceholder is what a value that could not be parsed becomes. It is a
// constant, never derived from the input, so a malformed address or link cannot
// smuggle bytes into the log.
const redactedPlaceholder = "[redacted]"

// logf writes through the configured logger, or the standard one when the
// LogMailer was built as a zero value.
func (m *LogMailer) logf(format string, args ...any) {
	l := m.Log
	if l == nil {
		l = log.Default()
	}
	l.Printf(format, args...)
}

// maskEmail keeps only what an operator needs to correlate a log line with a
// user report: the first rune of the local part and the domain. An address that
// does not parse as exactly one RFC 5322 address is not echoed at all.
func maskEmail(email string) string {
	a, err := mail.ParseAddress(email)
	if err != nil {
		return redactedPlaceholder
	}
	at := strings.LastIndex(a.Address, "@")
	if at <= 0 || at+1 >= len(a.Address) {
		return redactedPlaceholder
	}
	local, domain := a.Address[:at], a.Address[at+1:]
	first := []rune(local)[0]
	return string(first) + "***@" + domain
}

// linkPath reduces a credential-bearing link to its escaped path. The token is
// carried in the query or the fragment, so both are dropped, and so are the
// host and any userinfo. A link that is not an absolute http(s) URL with a host
// is not echoed at all. url.Parse rejects raw control bytes and EscapedPath
// percent-encodes the rest, which is what keeps a crafted link from injecting a
// second line into the log.
func linkPath(link string) string {
	u, err := url.Parse(link)
	if err != nil {
		return redactedPlaceholder
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return redactedPlaceholder
	}
	if u.Host == "" {
		return redactedPlaceholder
	}
	p := u.EscapedPath()
	if p == "" {
		p = "/"
	}
	return p
}

// logLink records one credential-bearing mail event under the redaction rules
// above. RevealLinks restores the plaintext for local development.
func (m *LogMailer) logLink(kind, email, link string) {
	if m.RevealLinks {
		m.logf("%s for %s: %s", kind, email, link)
		return
	}
	m.logf("%s for %s: link redacted (path %s); set -mail-transport=dev-log-links locally to print it",
		kind, maskEmail(email), linkPath(link))
}

func (m *LogMailer) SendMagicLink(_ context.Context, email, link string) error {
	m.logLink("magic link", email, link)
	return nil
}

func (m *LogMailer) SendVerifyEmail(_ context.Context, email, link string) error {
	m.logLink("verify email", email, link)
	return nil
}

func (m *LogMailer) SendPasswordReset(_ context.Context, email, link string) error {
	m.logLink("password reset", email, link)
	return nil
}

func (m *LogMailer) SendAccountDeletionConfirm(_ context.Context, email, link string) error {
	m.logLink("account deletion confirm", email, link)
	return nil
}

func (m *LogMailer) SendAccountDeletionScheduled(_ context.Context, email string, purgeAt int64, reactivateLink string) error {
	m.logDeletion("account deletion scheduled", email, purgeAt, reactivateLink)
	return nil
}

func (m *LogMailer) SendAccountDeletionReminder(_ context.Context, email string, purgeAt int64, reactivateLink string) error {
	m.logDeletion("account deletion reminder", email, purgeAt, reactivateLink)
	return nil
}

// logDeletion records a deletion-lifecycle event. The purge time is not a
// credential and stays readable; the reactivation link is a credential and is
// redacted exactly like every other link.
func (m *LogMailer) logDeletion(kind, email string, purgeAt int64, reactivateLink string) {
	when := time.Unix(purgeAt, 0).UTC().Format(time.RFC1123)
	if m.RevealLinks {
		m.logf("%s for %s, purge at %s: reactivate via %s", kind, email, when, reactivateLink)
		return
	}
	m.logf("%s for %s, purge at %s: reactivation link redacted (path %s)",
		kind, maskEmail(email), when, linkPath(reactivateLink))
}

func (m *LogMailer) SendAccountDeleted(_ context.Context, email string) error {
	if m.RevealLinks {
		m.logf("account deleted (purged) for %s", email)
		return nil
	}
	m.logf("account deleted (purged) for %s", maskEmail(email))
	return nil
}

// SMTPMailer sends via a standard SMTP server.
type SMTPMailer struct {
	Addr string    // host:port
	From string    // From header / envelope sender
	Auth smtp.Auth // nil for unauthenticated relays
}

// NewSMTPMailer builds an SMTPMailer. When user is non-empty it attaches
// PlainAuth bound to the SMTP host (parsed from addr); otherwise Auth stays nil,
// suitable for an unauthenticated local relay (e.g. 127.0.0.1:25). Go's
// smtp.SendMail upgrades the connection with STARTTLS before sending
// credentials, so authenticated providers on :587 (Gmail, SES, …) work.
func NewSMTPMailer(addr, from, user, pass string) *SMTPMailer {
	m := &SMTPMailer{Addr: addr, From: from}
	if user != "" {
		host, _, err := net.SplitHostPort(addr)
		if err != nil {
			host = addr
		}
		m.Auth = smtp.PlainAuth("", user, pass, host)
	}
	return m
}

// buildMessage assembles a well-formed text+HTML multipart/alternative message.
// It includes Date and Message-ID headers: both are effectively required by
// RFC 5322 / RFC 2822, and mail filters (e.g. docker-mailserver's amavis) reject
// a message that lacks them as a bad header — which is exactly what silently
// quarantined the first verification emails.
func (m *SMTPMailer) buildMessage(to, subject, text, html string) []byte {
	boundary := "relayium-boundary-8f2a1c"
	var b strings.Builder
	b.WriteString("From: " + m.From + "\r\n")
	b.WriteString("To: " + to + "\r\n")
	b.WriteString("Subject: " + subject + "\r\n")
	b.WriteString("Date: " + time.Now().Format(time.RFC1123Z) + "\r\n")
	b.WriteString("Message-ID: <" + authx.RandToken() + "@" + smtpDomain(m.From, m.Addr) + ">\r\n")
	b.WriteString("MIME-Version: 1.0\r\n")
	b.WriteString("Content-Type: multipart/alternative; boundary=\"" + boundary + "\"\r\n\r\n")
	b.WriteString("--" + boundary + "\r\n")
	b.WriteString("Content-Type: text/plain; charset=UTF-8\r\n\r\n")
	b.WriteString(text + "\r\n\r\n")
	b.WriteString("--" + boundary + "\r\n")
	b.WriteString("Content-Type: text/html; charset=UTF-8\r\n\r\n")
	b.WriteString(html + "\r\n\r\n")
	b.WriteString("--" + boundary + "--\r\n")
	return []byte(b.String())
}

// send builds a text+HTML multipart/alternative message and delivers it via SMTP.
func (m *SMTPMailer) send(to, subject, text, html string) error {
	if err := smtp.SendMail(m.Addr, m.Auth, m.From, []string{to}, m.buildMessage(to, subject, text, html)); err != nil {
		return fmt.Errorf("send mail: %w", err)
	}
	return nil
}

// smtpDomain derives the Message-ID right-hand-side domain from the From address
// (its part after '@'), falling back to the SMTP host, then "localhost". A
// globally-unique Message-ID is what RFC 5322 wants and what filters check for.
func smtpDomain(from, addr string) string {
	if a, err := mail.ParseAddress(from); err == nil {
		if i := strings.LastIndex(a.Address, "@"); i >= 0 && i+1 < len(a.Address) {
			return a.Address[i+1:]
		}
	}
	if host, _, err := net.SplitHostPort(addr); err == nil && host != "" {
		return host
	}
	return "localhost"
}

func (m *SMTPMailer) SendMagicLink(_ context.Context, email, link string) error {
	return m.send(email, "Your Relayium sign-in link",
		"Click to sign in to Relayium:\n"+link+"\n\nThis link expires shortly and can be used once. If you didn't request it, ignore this email.",
		`<p>Click to sign in to Relayium:</p><p><a href="`+link+`">`+link+`</a></p><p style="color:#666">This link expires shortly and can be used once. If you didn't request it, ignore this email.</p>`)
}

func (m *SMTPMailer) SendVerifyEmail(_ context.Context, email, link string) error {
	return m.send(email, "Verify your Relayium email",
		"Confirm your email to activate your Relayium account:\n"+link+"\n\nThis link is valid for 24 hours. If you didn't sign up, ignore this email.",
		`<p>Confirm your email to activate your Relayium account:</p><p><a href="`+link+`">Verify email</a></p><p style="color:#666">This link is valid for 24 hours. If you didn't sign up, ignore this email.</p>`)
}

func (m *SMTPMailer) SendPasswordReset(_ context.Context, email, link string) error {
	return m.send(email, "Reset your Relayium password",
		"Reset your Relayium password:\n"+link+"\n\nThis link is valid for 1 hour. If you didn't request it, ignore this email and your password stays unchanged.",
		`<p>Reset your Relayium password:</p><p><a href="`+link+`">Reset password</a></p><p style="color:#666">This link is valid for 1 hour. If you didn't request it, ignore this email and your password stays unchanged.</p>`)
}

func (m *SMTPMailer) SendAccountDeletionConfirm(_ context.Context, email, link string) error {
	return m.send(email, "Confirm Relayium account deletion",
		"Confirm you want to delete your Relayium account:\n"+link+"\n\nDeleting Relayium does not cancel an App Store subscription. Manage it with Apple before or after deletion: https://apps.apple.com/account/subscriptions\n\nThis link is valid for 1 hour and can be used once. If you didn't request this, ignore this email and no changes will be made.",
		`<p>Confirm you want to delete your Relayium account:</p><p><a href="`+link+`">Confirm deletion</a></p><p>Deleting Relayium does not cancel an App Store subscription. <a href="https://apps.apple.com/account/subscriptions">Manage it with Apple</a> before or after deletion.</p><p style="color:#666">This link is valid for 1 hour and can be used once. If you didn't request this, ignore this email and no changes will be made.</p>`)
}

func (m *SMTPMailer) SendAccountDeletionScheduled(_ context.Context, email string, purgeAt int64, reactivateLink string) error {
	when := time.Unix(purgeAt, 0).UTC().Format(time.RFC1123)
	return m.send(email, "Your Relayium account deletion is scheduled",
		"Your Relayium account is now scheduled for deletion. All data will be permanently purged on "+when+".\n\n"+
			"Changed your mind? Reactivate before then:\n"+reactivateLink,
		`<p>Your Relayium account is now scheduled for deletion. All data will be permanently purged on `+when+`.</p>`+
			`<p>Changed your mind? <a href="`+reactivateLink+`">Reactivate your account</a> before then.</p>`)
}

func (m *SMTPMailer) SendAccountDeletionReminder(_ context.Context, email string, purgeAt int64, reactivateLink string) error {
	when := time.Unix(purgeAt, 0).UTC().Format(time.RFC1123)
	return m.send(email, "Reminder: your Relayium account will be permanently deleted soon",
		"This is a reminder that your Relayium account and all its data will be permanently purged on "+when+".\n\n"+
			"Changed your mind? Reactivate before then:\n"+reactivateLink,
		`<p>This is a reminder that your Relayium account and all its data will be permanently purged on `+when+`.</p>`+
			`<p>Changed your mind? <a href="`+reactivateLink+`">Reactivate your account</a> before then.</p>`)
}

func (m *SMTPMailer) SendAccountDeleted(_ context.Context, email string) error {
	return m.send(email, "Your Relayium account has been deleted",
		"Your Relayium account and all its data have been permanently deleted. If you didn't request this, please contact support immediately.",
		`<p>Your Relayium account and all its data have been permanently deleted.</p><p style="color:#666">If you didn't request this, please contact support immediately.</p>`)
}

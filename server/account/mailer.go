package account

import (
	"context"
	"fmt"
	"log"
	"net"
	"net/mail"
	"net/smtp"
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

// LogMailer prints the link instead of sending it. For local development only.
type LogMailer struct{ Log *log.Logger }

func (m *LogMailer) SendMagicLink(_ context.Context, email, link string) error {
	m.Log.Printf("magic link for %s: %s", email, link)
	return nil
}

func (m *LogMailer) SendVerifyEmail(_ context.Context, email, link string) error {
	m.Log.Printf("verify email for %s: %s", email, link)
	return nil
}

func (m *LogMailer) SendPasswordReset(_ context.Context, email, link string) error {
	m.Log.Printf("password reset for %s: %s", email, link)
	return nil
}

func (m *LogMailer) SendAccountDeletionConfirm(_ context.Context, email, link string) error {
	m.Log.Printf("account deletion confirm for %s: %s", email, link)
	return nil
}

func (m *LogMailer) SendAccountDeletionScheduled(_ context.Context, email string, purgeAt int64, reactivateLink string) error {
	m.Log.Printf("account deletion scheduled for %s, purge at %s: reactivate via %s",
		email, time.Unix(purgeAt, 0).UTC().Format(time.RFC1123), reactivateLink)
	return nil
}

func (m *LogMailer) SendAccountDeletionReminder(_ context.Context, email string, purgeAt int64, reactivateLink string) error {
	m.Log.Printf("account deletion reminder for %s, purge at %s: reactivate via %s",
		email, time.Unix(purgeAt, 0).UTC().Format(time.RFC1123), reactivateLink)
	return nil
}

func (m *LogMailer) SendAccountDeleted(_ context.Context, email string) error {
	m.Log.Printf("account deleted (purged) for %s", email)
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

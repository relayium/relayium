package account

import (
	"context"
	"fmt"
	"log"
	"net"
	"net/smtp"
	"strings"
)

// Mailer sends the magic-link email. Abstracted so dev uses a log and prod uses SMTP.
type Mailer interface {
	SendMagicLink(ctx context.Context, email, link string) error
	SendVerifyEmail(ctx context.Context, email, link string) error
	SendPasswordReset(ctx context.Context, email, link string) error
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

// send builds a text+HTML multipart/alternative message and delivers it via SMTP.
func (m *SMTPMailer) send(to, subject, text, html string) error {
	boundary := "relayium-boundary-8f2a1c"
	var b strings.Builder
	b.WriteString("From: " + m.From + "\r\n")
	b.WriteString("To: " + to + "\r\n")
	b.WriteString("Subject: " + subject + "\r\n")
	b.WriteString("MIME-Version: 1.0\r\n")
	b.WriteString("Content-Type: multipart/alternative; boundary=\"" + boundary + "\"\r\n\r\n")
	b.WriteString("--" + boundary + "\r\n")
	b.WriteString("Content-Type: text/plain; charset=UTF-8\r\n\r\n")
	b.WriteString(text + "\r\n\r\n")
	b.WriteString("--" + boundary + "\r\n")
	b.WriteString("Content-Type: text/html; charset=UTF-8\r\n\r\n")
	b.WriteString(html + "\r\n\r\n")
	b.WriteString("--" + boundary + "--\r\n")
	if err := smtp.SendMail(m.Addr, m.Auth, m.From, []string{to}, []byte(b.String())); err != nil {
		return fmt.Errorf("send mail: %w", err)
	}
	return nil
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

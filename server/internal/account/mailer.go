package account

import (
	"context"
	"fmt"
	"log"
	"net/smtp"
	"strings"
)

// Mailer sends the magic-link email. Abstracted so dev uses a log and prod uses SMTP.
type Mailer interface {
	SendMagicLink(ctx context.Context, email, link string) error
}

// LogMailer prints the link instead of sending it. For local development only.
type LogMailer struct{ Log *log.Logger }

func (m *LogMailer) SendMagicLink(_ context.Context, email, link string) error {
	m.Log.Printf("magic link for %s: %s", email, link)
	return nil
}

// SMTPMailer sends via a standard SMTP server.
type SMTPMailer struct {
	Addr string    // host:port
	From string    // From header / envelope sender
	Auth smtp.Auth // nil for unauthenticated relays
}

func (m *SMTPMailer) SendMagicLink(_ context.Context, email, link string) error {
	body := strings.Join([]string{
		"From: " + m.From,
		"To: " + email,
		"Subject: Your Relayium sign-in link",
		"",
		"Click to sign in to Relayium:",
		link,
		"",
		"This link expires shortly and can be used once. If you didn't request it, ignore this email.",
	}, "\r\n")
	if err := smtp.SendMail(m.Addr, m.Auth, m.From, []string{email}, []byte(body)); err != nil {
		return fmt.Errorf("send magic link: %w", err)
	}
	return nil
}

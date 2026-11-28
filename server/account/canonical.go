package account

import (
	"net/mail"
	"strings"

	"golang.org/x/net/idna"
)

// validRegistrationEmail checks a bare mailbox with a multi-label DNS domain.
// Mailbox ownership is checked separately by the verification email.
func validRegistrationEmail(email string) bool {
	if _, err := mail.ParseAddress("<" + email + ">"); err != nil {
		return false
	}
	at := strings.LastIndexByte(email, '@')
	if at < 1 {
		return false
	}
	domain, err := idna.Lookup.ToASCII(email[at+1:])
	if err != nil || len(domain) > 253 {
		return false
	}
	labels := strings.Split(domain, ".")
	if len(labels) < 2 {
		return false
	}
	for _, label := range labels {
		if len(label) == 0 || len(label) > 63 {
			return false
		}
	}
	return strings.Trim(labels[len(labels)-1], "0123456789") != ""
}

// canonicalEmail folds an address to the form used ONLY for anti-Sybil
// register dedupe (NOT for login/identity — normEmail stays exact). It lowercases
// and trims, strips a "+tag" suffix from the local part for ALL domains, and for
// gmail.com / googlemail.com additionally removes dots from the local part
// (Gmail treats "a.b" and "ab" as the same mailbox). Input without '@' is just
// lowercased+trimmed and returned unchanged.
func canonicalEmail(email string) string {
	e := strings.ToLower(strings.TrimSpace(email))
	at := strings.LastIndex(e, "@")
	if at < 0 {
		return e
	}
	local, domain := e[:at], e[at+1:]
	if i := strings.IndexByte(local, '+'); i >= 0 {
		local = local[:i]
	}
	if domain == "gmail.com" || domain == "googlemail.com" {
		local = strings.ReplaceAll(local, ".", "")
	}
	return local + "@" + domain
}

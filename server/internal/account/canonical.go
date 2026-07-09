package account

import "strings"

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

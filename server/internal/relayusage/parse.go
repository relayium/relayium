// Package relayusage parses coturn/pion TURN-REST usernames into their billing
// attribution parts. Shared by the metering worker (Redis path) and the node
// heartbeat handler (HTTPS path) so username parsing has one source of truth.
package relayusage

import "strings"

// TokenFromUsername returns the token after the first ':' in "<expiry>:<token>",
// or "" if the username is malformed.
func TokenFromUsername(username string) string {
	parts := strings.SplitN(username, ":", 2)
	if len(parts) != 2 || parts[1] == "" {
		return ""
	}
	return parts[1]
}

// SplitAttrib splits a token "<userID>.<code>" into its parts. A token with no
// '.' (legacy anonymous codes) yields ("", token), keeping global relay
// accounting working without attribution.
func SplitAttrib(token string) (userID, code string) {
	parts := strings.SplitN(token, ".", 2)
	if len(parts) == 2 {
		return parts[0], parts[1]
	}
	return "", token
}

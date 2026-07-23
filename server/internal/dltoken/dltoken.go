// Package dltoken mints and verifies short-lived, per-file download tokens that
// let a client fetch a blob directly from the storage node holding it, without
// central proxying the bytes. Central signs (it knows each node's secret); the
// node verifies with the same secret — no round-trip back to central.
package dltoken

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"strconv"
	"strings"
)

// mac computes the token MAC over the fields the node re-derives at verify time:
// the domain tag "dl", the blob key, the expiry, and the nonce. NUL separators
// keep field boundaries unambiguous so distinct (key, exp, nonce) triples can
// never collide into the same MAC input.
func mac(secret, key string, exp int64, nonce string) string {
	h := hmac.New(sha256.New, []byte(secret))
	h.Write([]byte("dl\x00"))
	h.Write([]byte(key))
	h.Write([]byte("\x00"))
	h.Write([]byte(strconv.FormatInt(exp, 10)))
	h.Write([]byte("\x00"))
	h.Write([]byte(nonce))
	return base64.RawURLEncoding.EncodeToString(h.Sum(nil))
}

// Sign returns a token authorizing a download of key from a node, valid until
// exp (unix seconds). nonce makes repeated tokens for the same key distinct.
// Format: "<exp>.<nonce>.<mac>" — exp and nonce travel in the clear so the node
// can recompute the MAC; the MAC is what makes them unforgeable.
func Sign(secret, key string, exp int64, nonce string) string {
	return strconv.FormatInt(exp, 10) + "." + nonce + "." + mac(secret, key, exp, nonce)
}

// Nonce returns the nonce embedded in a token (the middle field), or "" if the
// token is malformed. The node uses it to correlate its download receipt back to
// the 302 central issued. It does NOT verify the token — Verify does that.
func Nonce(token string) string {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return ""
	}
	return parts[1]
}

// Exp returns the expiry embedded in a token (the first field), or false if the
// token is malformed. The node uses it to know how long a spent token has to be
// remembered for (see replayGuard). Like Nonce, it does NOT verify the token —
// only call it on a token Verify already accepted.
func Exp(token string) (int64, bool) {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return 0, false
	}
	exp, err := strconv.ParseInt(parts[0], 10, 64)
	if err != nil {
		return 0, false
	}
	return exp, true
}

// Verify reports whether token authorizes key under secret and has not expired
// as of now (unix seconds). The MAC comparison is constant-time.
func Verify(secret, key string, now int64, token string) bool {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return false
	}
	exp, err := strconv.ParseInt(parts[0], 10, 64)
	if err != nil {
		return false
	}
	if now > exp {
		return false
	}
	want := mac(secret, key, exp, parts[1])
	return hmac.Equal([]byte(want), []byte(parts[2]))
}

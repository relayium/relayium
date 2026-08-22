package dltoken

import (
	"math"
	"strconv"
	"strings"
	"testing"
)

// nonceAlphabet is the alphabet a minted nonce actually uses: central produces
// it with base64 raw-URL encoding, and none of those characters is the "."
// this token format separates its three fields with.
//
// The round-trip property below is stated only over this alphabet ON PURPOSE.
// Sign concatenates the nonce verbatim, so a nonce containing "." would produce
// a four-field string that Verify refuses as malformed — a token that cannot be
// verified rather than one that can be forged. That is a property of a caller
// that does not exist; pinning it here would freeze the current spelling of a
// sharp edge instead of the contract, and this task may not change Sign.
const nonceAlphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"

// maxFuzzNonce bounds the nonce a seed can grow into. Real nonces are a couple
// of dozen characters; the bound keeps one input from spending the budget
// hashing a megabyte.
const maxFuzzNonce = 128

// safeNonce maps arbitrary bytes into the minted alphabet, deterministically.
func safeNonce(seed string) string {
	if len(seed) > maxFuzzNonce {
		seed = seed[:maxFuzzNonce]
	}
	var b strings.Builder
	b.Grow(len(seed))
	for i := 0; i < len(seed); i++ {
		b.WriteByte(nonceAlphabet[int(seed[i])%len(nonceAlphabet)])
	}
	return b.String()
}

// FuzzSignVerify is the authorization contract a storage node relies on: it
// verifies with the node secret alone, with no round trip back to central, so
// everything that decides whether those bytes may leave the node is in this
// file.
//
// The three bindings asserted below — key, secret, expiry — are exactly what
// stops one signed URL from being reused for a different blob, on a different
// node, or forever.
//
// A note on why "a distinct key means a distinct MAC" is safe to assert even
// when the fuzzer hands us a key containing NUL: mac() frames its input as
// "dl\0" ‖ key ‖ "\0" ‖ exp ‖ "\0" ‖ nonce, and both exp (decimal digits, with
// an optional sign) and a minted nonce are NUL-free. The last two NULs in that
// string are therefore always the two separators, so the triple is recoverable
// from the MAC input and two distinct triples can never share one.
func FuzzSignVerify(f *testing.F) {
	f.Add("node-secret", "blob/2026/abcdef", "Zm9vYmFy", int64(1_700_000_000), int64(1_699_999_000))
	f.Add("", "", "", int64(0), int64(0))
	f.Add("s", "k", "", int64(-1), int64(-1))
	f.Add("s", "k\x00with-nul", "n", int64(math.MaxInt64), int64(math.MinInt64))

	f.Fuzz(func(t *testing.T, secret, key, nonceSeed string, exp, now int64) {
		nonce := safeNonce(nonceSeed)
		token := Sign(secret, key, exp, nonce)

		// The two fields that travel in the clear must read back exactly, or
		// the node cannot correlate its download receipt (Nonce) or know how
		// long to remember a spent token (Exp).
		if got := Nonce(token); got != nonce {
			t.Fatalf("Nonce(%q) = %q, want %q", token, got, nonce)
		}
		if got, ok := Exp(token); !ok || got != exp {
			t.Fatalf("Exp(%q) = (%d, %v), want (%d, true)", token, got, ok, exp)
		}

		// Expiry, as the boundary rather than as an example: valid at exp,
		// invalid at exp+1, and the two agree with the general rule.
		if !Verify(secret, key, exp, token) {
			t.Fatalf("a token minted for exp=%d was refused at now=%d", exp, exp)
		}
		if exp != math.MaxInt64 && Verify(secret, key, exp+1, token) {
			t.Fatalf("a token minted for exp=%d was accepted one second later", exp)
		}
		if want := now <= exp; Verify(secret, key, now, token) != want {
			t.Fatalf("Verify at now=%d for exp=%d returned %v, want %v", now, exp, !want, want)
		}

		// Binding. Each of these is a different node, a different blob, or a
		// rotated secret, and none of them may open this token.
		if Verify(secret+"x", key, exp, token) {
			t.Fatalf("a token signed with one secret verified under another")
		}
		if Verify(secret, key+"x", exp, token) {
			t.Fatalf("a token authorizing %q also authorized %q", key, key+"x")
		}

		// Tampering. Each field is rewritten to a value that is ACTUALLY
		// different — a rewrite that lands on the same value would be asserting
		// that a token rejects itself.
		parts := strings.Split(token, ".")
		if len(parts) != 3 {
			t.Fatalf("Sign produced %d fields for nonce %q, want 3", len(parts), nonce)
		}
		// Compared as parsed integers, not as strings: Verify re-derives the
		// MAC from the PARSED expiry, so "007" and "7" are the same expiry
		// wearing different spellings and neither is a forgery of the other.
		otherExp := exp ^ 1
		reExp := strconv.FormatInt(otherExp, 10) + "." + parts[1] + "." + parts[2]
		if Verify(secret, key, math.MinInt64, reExp) {
			t.Fatalf("moving the expiry from %d to %d left the token valid", exp, otherExp)
		}
		reNonce := parts[0] + "." + nonce + "A" + "." + parts[2]
		if Verify(secret, key, math.MinInt64, reNonce) {
			t.Fatalf("changing the nonce left the token valid")
		}
		// The MAC is 43 base64url characters, so there is always a first one to
		// change; flipping it in place keeps the length so the constant-time
		// comparison is the thing that rejects it.
		flipped := "A"
		if parts[2][0] == 'A' {
			flipped = "B"
		}
		reMAC := parts[0] + "." + parts[1] + "." + flipped + parts[2][1:]
		if Verify(secret, key, math.MinInt64, reMAC) {
			t.Fatalf("a token with a changed MAC verified")
		}
	})
}

// FuzzVerifyArbitraryToken is the node's actual input: a token string out of a
// URL somebody typed. Nothing here may panic, and anything Verify accepts has
// to be something the accessors can also read.
func FuzzVerifyArbitraryToken(f *testing.F) {
	f.Add("node-secret", "blob/2026/abcdef", Sign("node-secret", "blob/2026/abcdef", 1_700_000_000, "Zm9vYmFy"), int64(1_699_999_000))
	f.Add("s", "k", "", int64(0))
	f.Add("s", "k", "...", int64(0))
	f.Add("s", "k", "1.2", int64(0))
	f.Add("s", "k", "1.2.3.4", int64(0))
	f.Add("s", "k", "99999999999999999999.n.m", int64(0))
	f.Add("s", "k", "-1.n.m", int64(0))

	f.Fuzz(func(t *testing.T, secret, key, token string, now int64) {
		ok := Verify(secret, key, now, token)
		nonce := Nonce(token)
		exp, hasExp := Exp(token)

		// A string that is not three dot-separated fields is not a token, and
		// all three entry points have to agree about that rather than each
		// having its own idea of malformed.
		if strings.Count(token, ".") != 2 {
			if ok || nonce != "" || hasExp {
				t.Fatalf("%q has %d dots but Verify=%v, Nonce=%q, Exp ok=%v", token, strings.Count(token, "."), ok, nonce, hasExp)
			}
			return
		}
		if !ok {
			return
		}
		// From here the token was ACCEPTED, so the node is about to serve
		// bytes on the strength of it.
		if !hasExp {
			t.Fatalf("Verify accepted %q but Exp cannot read its expiry", token)
		}
		if now > exp {
			t.Fatalf("Verify accepted %q at now=%d, past its expiry %d", token, now, exp)
		}
		// And it is reproducible: re-signing the expiry and nonce it carries,
		// under the same secret and key, yields a token that verifies too.
		// Stated this way rather than as equality with `token` because the
		// expiry field is not canonicalized — "007" and "7" are one expiry —
		// and asserting equality would pin a stricter format than Sign has.
		if !Verify(secret, key, now, Sign(secret, key, exp, nonce)) {
			t.Fatalf("re-signing the (exp=%d, nonce=%q) of an accepted token produced one that does not verify", exp, nonce)
		}
	})
}

package account

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"encoding/binary"
	"encoding/json"
	"math/big"
	"testing"

	"github.com/fxamacker/cbor/v2"
)

// testAuthenticator is a minimal software WebAuthn authenticator (ES256, "none"
// attestation). It exists because the real ceremony signs a server-generated
// challenge, so no static fixture can exercise the finish endpoints — the only
// code path that actually decides who gets into the admin panel.
type testAuthenticator struct {
	key       *ecdsa.PrivateKey
	credID    []byte
	signCount uint32
}

func newTestAuthenticator(t *testing.T) *testAuthenticator {
	t.Helper()
	k, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatalf("generate key: %v", err)
	}
	id := make([]byte, 32)
	if _, err := rand.Read(id); err != nil {
		t.Fatalf("credential id: %v", err)
	}
	return &testAuthenticator{key: k, credID: id}
}

// b64url is defined in apple_web.go (base64.RawURLEncoding.EncodeToString);
// reused here rather than redeclared.

// pad32 left-pads an EC coordinate to the fixed 32 bytes COSE requires.
func pad32(i *big.Int) []byte {
	b := i.Bytes()
	out := make([]byte, 32)
	copy(out[32-len(b):], b)
	return out
}

func cborEnc(t *testing.T, v any) []byte {
	t.Helper()
	em, err := cbor.CanonicalEncOptions().EncMode()
	if err != nil {
		t.Fatalf("cbor encmode: %v", err)
	}
	b, err := em.Marshal(v)
	if err != nil {
		t.Fatalf("cbor marshal: %v", err)
	}
	return b
}

// coseKey encodes the public key as a COSE_Key: kty=EC2, alg=ES256, crv=P-256.
func (a *testAuthenticator) coseKey(t *testing.T) []byte {
	t.Helper()
	return cborEnc(t, map[int]any{
		1: 2, 3: -7, -1: 1,
		-2: pad32(a.key.PublicKey.X),
		-3: pad32(a.key.PublicKey.Y),
	})
}

func (a *testAuthenticator) clientData(typ, challenge, origin string) []byte {
	b, _ := json.Marshal(map[string]any{
		"type": typ, "challenge": challenge, "origin": origin, "crossOrigin": false,
	})
	return b
}

// authData builds authenticatorData: rpIdHash || flags || signCount
// [|| aaguid || credIdLen || credId || coseKey when attested].
func (a *testAuthenticator) authData(t *testing.T, rpID string, flags byte, attested bool) []byte {
	t.Helper()
	h := sha256.Sum256([]byte(rpID))
	out := append([]byte{}, h[:]...)
	out = append(out, flags)
	var ctr [4]byte
	binary.BigEndian.PutUint32(ctr[:], a.signCount)
	out = append(out, ctr[:]...)
	if attested {
		out = append(out, make([]byte, 16)...) // zero AAGUID
		var l [2]byte
		binary.BigEndian.PutUint16(l[:], uint16(len(a.credID)))
		out = append(out, l[:]...)
		out = append(out, a.credID...)
		out = append(out, a.coseKey(t)...)
	}
	return out
}

// registerBody produces the JSON navigator.credentials.create() would POST.
// Flags 0x45 = UserPresent | UserVerified | AttestedCredentialData.
func (a *testAuthenticator) registerBody(t *testing.T, rpID, origin, challenge string) string {
	t.Helper()
	cd := a.clientData("webauthn.create", challenge, origin)
	ad := a.authData(t, rpID, 0x45, true)
	att := cborEnc(t, map[string]any{
		"fmt": "none", "attStmt": map[string]any{}, "authData": ad,
	})
	body, _ := json.Marshal(map[string]any{
		"id": b64url(a.credID), "rawId": b64url(a.credID), "type": "public-key",
		"response": map[string]any{
			"clientDataJSON":    b64url(cd),
			"attestationObject": b64url(att),
		},
	})
	return string(body)
}

// assertBody produces the JSON navigator.credentials.get() would POST, signing
// over authenticatorData || SHA256(clientDataJSON). Flags 0x05 = UP | UV.
func (a *testAuthenticator) assertBody(t *testing.T, rpID, origin, challenge string, userHandle []byte) string {
	t.Helper()
	a.signCount++
	cd := a.clientData("webauthn.get", challenge, origin)
	ad := a.authData(t, rpID, 0x05, false)
	cdh := sha256.Sum256(cd)
	signed := sha256.Sum256(append(append([]byte{}, ad...), cdh[:]...))
	sig, err := ecdsa.SignASN1(rand.Reader, a.key, signed[:])
	if err != nil {
		t.Fatalf("sign assertion: %v", err)
	}
	body, _ := json.Marshal(map[string]any{
		"id": b64url(a.credID), "rawId": b64url(a.credID), "type": "public-key",
		"response": map[string]any{
			"clientDataJSON":    b64url(cd),
			"authenticatorData": b64url(ad),
			"signature":         b64url(sig),
			"userHandle":        b64url(userHandle),
		},
	})
	return string(body)
}

// replayAssertBody re-signs with a stale (non-incrementing) counter to simulate
// a cloned authenticator.
func (a *testAuthenticator) replayAssertBody(t *testing.T, rpID, origin, challenge string, userHandle []byte, counter uint32) string {
	t.Helper()
	saved := a.signCount
	a.signCount = counter - 1 // assertBody increments before use
	defer func() { a.signCount = saved }()
	return a.assertBody(t, rpID, origin, challenge, userHandle)
}

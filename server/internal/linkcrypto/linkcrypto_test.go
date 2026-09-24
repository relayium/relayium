package linkcrypto

import (
	"bytes"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"regexp"
	"strings"
	"testing"
)

func mustPair(t *testing.T) *KeyPair {
	t.Helper()
	kp, err := GenerateKeyPair()
	if err != nil {
		t.Fatalf("GenerateKeyPair: %v", err)
	}
	return kp
}

func key32(b byte) []byte { return bytes.Repeat([]byte{b}, 32) }

// ── key pairs ───────────────────────────────────────────────────────────────

func TestKeyPairFromSecretRejectsInvalid(t *testing.T) {
	for _, secret := range [][]byte{nil, {}, make([]byte, 31), make([]byte, 33), make([]byte, 32)} {
		if kp, err := KeyPairFromSecret(secret); !errors.Is(err, ErrInvalidKey) || kp != nil {
			t.Errorf("KeyPairFromSecret(len %d, zero=%v) = %v, %v; want nil, ErrInvalidKey",
				len(secret), isZero(secret), kp, err)
		}
	}
}

func TestKeyPairCopiesAndIsNotAliased(t *testing.T) {
	secret := key32(0x11)
	kp, err := KeyPairFromSecret(secret)
	if err != nil {
		t.Fatal(err)
	}
	pub := kp.PublicKey()
	secret[0] ^= 0xff // caller reuses its buffer
	pub[0] ^= 0xff    // caller scribbles on the returned key
	again, _ := KeyPairFromSecret(key32(0x11))
	if !bytes.Equal(kp.PublicKey(), again.PublicKey()) {
		t.Fatal("mutating the input secret or a returned public key changed the pair")
	}
	peer := mustPair(t)
	a, _ := DeriveSession(Initiator, kp, peer.PublicKey())
	b, _ := DeriveSession(Initiator, again, peer.PublicKey())
	if !bytes.Equal(a.Send(), b.Send()) {
		t.Fatal("mutating the input secret changed the pair's derived keys")
	}
}

func TestGenerateKeyPairIsFreshAndUsable(t *testing.T) {
	a, b := mustPair(t), mustPair(t)
	if bytes.Equal(a.PublicKey(), b.PublicKey()) {
		t.Fatal("two generated key pairs are identical")
	}
	ak, err := DeriveSession(Initiator, a, b.PublicKey())
	if err != nil {
		t.Fatal(err)
	}
	bk, err := DeriveSession(Responder, b, a.PublicKey())
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(ak.Send(), bk.Recv()) || !bytes.Equal(ak.Recv(), bk.Send()) ||
		!bytes.Equal(ak.ResumeAuth(), bk.ResumeAuth()) ||
		!bytes.Equal(ak.TextSend(), bk.TextRecv()) || !bytes.Equal(ak.TextRecv(), bk.TextSend()) {
		t.Fatal("generated pairs do not derive mirrored sessions")
	}
	ct, _ := Seal(ak.TextSend(), 0, []byte("hi"))
	if pt, err := Open(bk.TextRecv(), 0, ct); err != nil || string(pt) != "hi" {
		t.Fatalf("round trip across generated pairs: %q, %v", pt, err)
	}
}

type failingReader struct{ n int }

func (r *failingReader) Read(p []byte) (int, error) {
	if r.n <= 0 {
		return 0, errors.New("entropy unavailable")
	}
	// Non-zero filler, so a caller that ignores the error cannot be rescued by
	// the all-zero-secret check and still be counted as failing closed.
	n := min(r.n, len(p))
	for i := range p[:n] {
		p[i] = 0xaa
	}
	r.n -= n
	return n, nil
}

func withRand(t *testing.T, r io.Reader) {
	t.Helper()
	prev := randReader
	randReader = r
	t.Cleanup(func() { randReader = prev })
}

func TestRandomnessFailurePropagates(t *testing.T) {
	for _, short := range []int{0, 31} {
		withRand(t, &failingReader{n: short})
		if kp, err := GenerateKeyPair(); err == nil || kp != nil {
			t.Errorf("GenerateKeyPair with %d random bytes = %v, %v; want an error", short, kp, err)
		}
		withRand(t, &failingReader{n: short})
		if n, err := RandomCommitNonce(); err == nil || n != nil {
			t.Errorf("RandomCommitNonce with %d random bytes = %x, %v; want an error", short, n, err)
		}
	}
}

// ── session derivation ──────────────────────────────────────────────────────

func TestDeriveSessionRejectsRoleAndLength(t *testing.T) {
	self, peer := mustPair(t), mustPair(t)
	for _, role := range []Role{0, Responder + 1, -1} {
		if s, err := DeriveSession(role, self, peer.PublicKey()); !errors.Is(err, ErrInvalidRole) || s != nil {
			t.Errorf("role %v: %v, %v; want ErrInvalidRole", role, s, err)
		}
	}
	for _, pub := range [][]byte{nil, make([]byte, 31), append(peer.PublicKey(), 0)} {
		if s, err := DeriveSession(Initiator, self, pub); !errors.Is(err, ErrInvalidKey) || s != nil {
			t.Errorf("peer key len %d: %v, %v; want ErrInvalidKey", len(pub), s, err)
		}
	}
	if s, err := DeriveSession(Initiator, nil, peer.PublicKey()); !errors.Is(err, ErrInvalidKey) || s != nil {
		t.Errorf("nil self: %v, %v; want ErrInvalidKey", s, err)
	}
	if s, err := DeriveSession(Initiator, &KeyPair{}, peer.PublicKey()); !errors.Is(err, ErrInvalidKey) || s != nil {
		t.Errorf("zero-value self: %v, %v; want ErrInvalidKey", s, err)
	}
}

// libsodium's crypto_scalarmult_curve25519 blacklist (has_small_order): the
// points of order 1, 2, 4 and 8 and the non-canonical encodings of 0, 1 and
// p-1, each also with the ignored top bit set.
var smallOrderPoints = []string{
	"0000000000000000000000000000000000000000000000000000000000000000",
	"0100000000000000000000000000000000000000000000000000000000000000",
	"e0eb7a7c3b41b8ae1656e3faf19fc46ada098deb9c32b1fd866205165f49b800",
	"5f9c95bca3508c24b1d0b1559c83ef5b04445cc4581c8e86d8224eddd09f1157",
	"ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f", // p-1
	"edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f", // p
	"eeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f", // p+1
}

func TestDeriveSessionRejectsLowOrderPeers(t *testing.T) {
	self := mustPair(t)
	for _, h := range smallOrderPoints {
		p, _ := hex.DecodeString(h)
		for _, variant := range [][]byte{p, append(bytes.Clone(p[:31]), p[31]|0x80)} {
			for _, role := range []Role{Initiator, Responder} {
				s, err := DeriveSession(role, self, variant)
				if !errors.Is(err, ErrLowOrderPeer) || s != nil {
					t.Errorf("%v with peer %x: %v, %v; want ErrLowOrderPeer", role, variant, s, err)
				}
				if err != nil && strings.Contains(err.Error(), hex.EncodeToString(variant[:8])) {
					t.Errorf("error message carries key bytes: %q", err)
				}
			}
		}
	}
}

func TestSessionAccessorsReturnCopies(t *testing.T) {
	a, b := mustPair(t), mustPair(t)
	s, _ := DeriveSession(Initiator, a, b.PublicKey())
	for name, get := range map[string]func() []byte{
		"Send": s.Send, "Recv": s.Recv, "ResumeAuth": s.ResumeAuth,
		"TextSend": s.TextSend, "TextRecv": s.TextRecv,
	} {
		first := get()
		want := bytes.Clone(first)
		first[0] ^= 0xff
		if got := get(); !bytes.Equal(got, want) || len(got) != SessionKeySize {
			t.Errorf("%s: mutating a returned key changed the session", name)
		}
	}
	// And the five keys are pairwise distinct: no two roles of key collapsed.
	all := [][]byte{s.Send(), s.Recv(), s.ResumeAuth(), s.TextSend(), s.TextRecv()}
	for i := range all {
		for j := i + 1; j < len(all); j++ {
			if bytes.Equal(all[i], all[j]) {
				t.Errorf("session keys %d and %d are equal", i, j)
			}
		}
	}
}

func TestSameRoleOnBothSidesDoesNotMirror(t *testing.T) {
	a, b := mustPair(t), mustPair(t)
	ak, _ := DeriveSession(Initiator, a, b.PublicKey())
	bk, _ := DeriveSession(Initiator, b, a.PublicKey())
	if bytes.Equal(ak.Send(), bk.Recv()) {
		t.Fatal("two initiators derived mirrored keys; roles are not being applied")
	}
}

func TestFormattingNeverPrintsSecrets(t *testing.T) {
	secret := key32(0x11)
	kp, _ := KeyPairFromSecret(secret)
	peer := mustPair(t)
	s, _ := DeriveSession(Initiator, kp, peer.PublicKey())
	secrets := [][]byte{secret, s.Send(), s.Recv(), s.ResumeAuth(), s.TextSend(), s.TextRecv()}
	for _, verb := range []string{"%v", "%+v", "%#v", "%s", "%x", "%X", "%d", "%q"} {
		for _, subject := range []any{kp, *kp, s, *s} {
			out := strings.ToLower(fmt.Sprintf(verb, subject))
			for _, sec := range secrets {
				// A 4-byte window is enough to catch hex, and %d prints
				// decimal bytes, so check both spellings.
				if strings.Contains(out, hex.EncodeToString(sec[:4])) ||
					strings.Contains(out, strings.Trim(fmt.Sprint(sec[:4]), "[]")) {
					t.Fatalf("%s of %T prints key material: %s", verb, subject, out)
				}
			}
		}
	}
	if got := fmt.Sprint(kp); !strings.Contains(got, hex.EncodeToString(kp.PublicKey())) {
		t.Fatalf("KeyPair formatting lost its public key: %s", got)
	}
	if (&KeyPair{}).PublicKey() != nil || (*KeyPair)(nil).PublicKey() != nil {
		t.Fatal("a KeyPair not built by this package reports a public key")
	}
}

func TestRoleString(t *testing.T) {
	if Initiator.String() != "initiator" || Responder.String() != "responder" || Role(0).String() != "Role(0)" {
		t.Fatal("Role.String")
	}
}

// ── AEAD ────────────────────────────────────────────────────────────────────

func TestNonceFromSeqLayout(t *testing.T) {
	for seq, want := range map[uint64]string{
		0:                  "000000000000000000000000",
		5:                  "000000000000000000000005",
		1 << 32:            "000000000000000100000000",
		0x0102030405060708: "000000000102030405060708",
		^uint64(0):         "00000000ffffffffffffffff",
	} {
		n := NonceFromSeq(seq)
		if got := hex.EncodeToString(n[:]); got != want {
			t.Errorf("NonceFromSeq(%#x) = %s, want %s", seq, got, want)
		}
	}
}

func TestSealOpenRejectsBadKeys(t *testing.T) {
	for _, n := range []int{0, 16, 24, 31, 33} {
		k := make([]byte, n)
		if ct, err := Seal(k, 0, []byte("x")); !errors.Is(err, ErrInvalidKey) || ct != nil {
			t.Errorf("Seal with %d-byte key: %x, %v", n, ct, err)
		}
		if pt, err := Open(k, 0, make([]byte, 32)); !errors.Is(err, ErrInvalidKey) || pt != nil {
			t.Errorf("Open with %d-byte key: %x, %v", n, pt, err)
		}
	}
}

func TestOpenFailsClosed(t *testing.T) {
	key := key32(0x44)
	pt := []byte("relayium frame payload")
	const seq = 1<<32 + 7
	ct, err := Seal(key, seq, pt)
	if err != nil {
		t.Fatal(err)
	}
	if len(ct) != len(pt)+AEADTagSize {
		t.Fatalf("ciphertext length %d, want %d", len(ct), len(pt)+AEADTagSize)
	}
	fail := func(name string, key []byte, seq uint64, ct []byte) {
		t.Helper()
		got, err := Open(key, seq, ct)
		if !errors.Is(err, ErrOpen) || got != nil {
			t.Errorf("%s: Open = %x, %v; want nil, ErrOpen", name, got, err)
		}
	}
	for i := range ct {
		bad := bytes.Clone(ct)
		bad[i] ^= 0x01
		fail(fmt.Sprintf("flipped byte %d", i), key, seq, bad)
	}
	fail("wrong key", key32(0x45), seq, ct)
	fail("wrong seq low word", key, seq+1, ct)
	fail("wrong seq high word", key, seq&0xffffffff, ct)
	fail("truncated tag", key, seq, ct[:len(ct)-1])
	fail("tag only, body dropped", key, seq, ct[len(ct)-AEADTagSize:])
	fail("appended byte", key, seq, append(bytes.Clone(ct), 0))
	fail("shorter than a tag", key, seq, ct[:AEADTagSize-1])
	fail("empty", key, seq, nil)

	got, err := Open(key, seq, ct)
	if err != nil || !bytes.Equal(got, pt) {
		t.Fatalf("round trip: %q, %v", got, err)
	}
}

func TestSealOpenDoNotAlias(t *testing.T) {
	key := key32(0x44)
	pt := []byte("payload")
	ct, _ := Seal(key, 9, pt)
	want := bytes.Clone(ct)
	pt[0] ^= 0xff
	if !bytes.Equal(ct, want) {
		t.Fatal("ciphertext aliases the plaintext buffer")
	}
	out, err := Open(key, 9, ct)
	if err != nil {
		t.Fatal(err)
	}
	out[0] ^= 0xff
	if !bytes.Equal(ct, want) {
		t.Fatal("opened plaintext aliases the ciphertext buffer")
	}
	empty, err := Seal(key, 0, nil)
	if err != nil || len(empty) != AEADTagSize {
		t.Fatalf("empty plaintext: %x, %v", empty, err)
	}
}

func FuzzOpenRejectsForgeries(f *testing.F) {
	key := key32(0x44)
	genuine, _ := Seal(key, 5, []byte("relayium frame payload"))
	f.Add(uint64(5), genuine[:len(genuine)-1])
	f.Add(uint64(5), make([]byte, 16))
	f.Add(uint64(6), genuine)
	f.Add(uint64(0), []byte{})
	f.Fuzz(func(t *testing.T, seq uint64, ct []byte) {
		pt, err := Open(key, seq, ct)
		if err != nil {
			if pt != nil {
				t.Fatalf("Open returned bytes alongside an error: %x", pt)
			}
			return
		}
		// Anything that opens must be exactly what this key sealed at this seq.
		again, _ := Seal(key, seq, pt)
		if !bytes.Equal(again, ct) {
			t.Fatalf("Open accepted a ciphertext Seal would not produce")
		}
	})
}

// ── commitment ──────────────────────────────────────────────────────────────

func TestCommitRejectsBadLengths(t *testing.T) {
	pub, nonce := key32(1), key32(2)
	for _, c := range []struct{ pub, nonce []byte }{
		{pub[:31], nonce}, {pub, nonce[:31]}, {append(bytes.Clone(pub), 0), nonce}, {nil, nil},
	} {
		if got, err := CommitKey(c.pub, c.nonce); !errors.Is(err, ErrInvalidKey) || got != nil {
			t.Errorf("CommitKey(len %d, len %d) = %x, %v", len(c.pub), len(c.nonce), got, err)
		}
		if VerifyCommit(make([]byte, CommitSize), c.pub, c.nonce) {
			t.Errorf("VerifyCommit accepted pub len %d nonce len %d", len(c.pub), len(c.nonce))
		}
	}
	good, _ := CommitKey(pub, nonce)
	for _, commit := range [][]byte{nil, good[:31], append(bytes.Clone(good), 0)} {
		if VerifyCommit(commit, pub, nonce) {
			t.Errorf("VerifyCommit accepted a %d-byte commitment", len(commit))
		}
	}
}

func TestRandomCommitNonce(t *testing.T) {
	a, err := RandomCommitNonce()
	if err != nil || len(a) != CommitNonceSize {
		t.Fatalf("RandomCommitNonce: %x, %v", a, err)
	}
	b, _ := RandomCommitNonce()
	if bytes.Equal(a, b) {
		t.Fatal("two commitment nonces are identical")
	}
}

// ── SAS ─────────────────────────────────────────────────────────────────────

func TestSASFormatAndOrder(t *testing.T) {
	six := regexp.MustCompile(`^[0-9]{6}$`)
	for range 200 {
		a, b := mustPair(t).PublicKey(), mustPair(t).PublicKey()
		ab, err1 := SAS(a, b)
		ba, err2 := SAS(b, a)
		if err1 != nil || err2 != nil || ab != ba || !six.MatchString(ab) {
			t.Fatalf("SAS(%x, %x) = %q/%q (%v, %v)", a, b, ab, ba, err1, err2)
		}
	}
	if _, err := SAS(key32(1)[:31], key32(2)); !errors.Is(err, ErrInvalidKey) {
		t.Fatal("SAS accepted a short key")
	}
	if _, err := SAS(key32(1), append(key32(2), 0)); !errors.Is(err, ErrInvalidKey) {
		t.Fatal("SAS accepted a long key")
	}
}

// ── resume tags ─────────────────────────────────────────────────────────────

func TestVerifyResumeFailsClosed(t *testing.T) {
	key := key32(0x2e)
	const payload = "resume:offset=1024"
	tag, err := SignResume(key, payload)
	if err != nil || len(tag) != ResumeTagEncodedLen {
		t.Fatalf("SignResume: %q, %v", tag, err)
	}
	if !VerifyResume(key, payload, tag) {
		t.Fatal("genuine tag rejected")
	}
	raw, _ := base64.StdEncoding.DecodeString(tag)
	flipped := bytes.Clone(raw)
	flipped[31] ^= 0x01

	// 32 bytes = 42 full sextets + one carrying 2 data bits and 4 padding bits.
	// Setting a padding bit keeps a lenient decoder's output identical.
	last := strings.IndexByte("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/", tag[42])
	nonCanonical := tag[:42] + string("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"[last|0x01]) + "="
	if nonCanonical == tag {
		t.Fatal("test setup: non-canonical spelling equals the tag")
	}

	for name, c := range map[string]struct {
		key          []byte
		payload, tag string
	}{
		"absent":             {key, payload, ""},
		"malformed":          {key, payload, strings.Repeat("!", ResumeTagEncodedLen)},
		"unpadded":           {key, payload, strings.TrimRight(tag, "=")},
		"trailing newline":   {key, payload, tag + "\n"},
		"non-canonical bits": {key, payload, nonCanonical},
		"flipped tag bit":    {key, payload, base64.StdEncoding.EncodeToString(flipped)},
		"truncated MAC":      {key, payload, base64.StdEncoding.EncodeToString(raw[:31]) + "="},
		"changed payload":    {key, "resume:offset=1025", tag},
		"empty payload":      {key, "", tag},
		"wrong key":          {key32(0x2f), payload, tag},
		"short key":          {key[:31], payload, tag},
		"long key":           {append(bytes.Clone(key), 0), payload, tag},
	} {
		if bytes.Equal(c.key, key) && c.payload == payload && c.tag == tag {
			t.Fatalf("test setup: case %q is the genuine triple", name)
		}
		if VerifyResume(c.key, c.payload, c.tag) {
			t.Errorf("%s: VerifyResume accepted", name)
		}
	}
	// The URL-safe alphabet differs only where the tag has '+' or '/', so find a
	// payload whose tag does rather than hoping the fixed one happens to.
	for i := 0; ; i++ {
		p := fmt.Sprintf("resume:offset=%d", i)
		std, _ := SignResume(key, p)
		if !strings.ContainsAny(std, "+/") {
			continue
		}
		if url := strings.NewReplacer("+", "-", "/", "_").Replace(std); VerifyResume(key, p, url) {
			t.Fatalf("VerifyResume accepted the URL-alphabet spelling %q", url)
		}
		break
	}
	if _, err := SignResume(key[:31], payload); !errors.Is(err, ErrInvalidKey) {
		t.Fatal("SignResume accepted a short key")
	}
}

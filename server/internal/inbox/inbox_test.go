package inbox

import (
	"bytes"
	"crypto/ecdh"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"reflect"
	"testing"
	"time"
)

func TestNegotiateProtocolVersionPicksHighestCommon(t *testing.T) {
	// A rolling client that speaks more than central does must land on the
	// highest version CENTRAL supports, not on whatever it asked for first.
	got, err := NegotiateProtocolVersion([]int{1, 2, 99})
	if err != nil || got != ProtocolV2 {
		t.Fatalf("mixed set: got %d err %v, want %d", got, err, ProtocolV2)
	}
}

func TestNegotiateProtocolVersionRefusesV1Only(t *testing.T) {
	// The owner waived old-protocol compatibility: v2 replaced v1 outright.
	// A v1-only client must be REFUSED so it reports "upgrade", not silently
	// enrolled at a version whose manifests it cannot read.
	v, err := NegotiateProtocolVersion([]int{ProtocolV1})
	if !errors.Is(err, ErrUnsupportedProtocol) {
		t.Fatalf("v1-only: err = %v, want ErrUnsupportedProtocol", err)
	}
	if v != 0 {
		t.Fatalf("a refused v1 client must get no version, got %d", v)
	}
	// And the refusal must carry an actionable set, not an empty one.
	if got := SupportedProtocolVersions(); !reflect.DeepEqual(got, []int{ProtocolV2}) {
		t.Fatalf("SupportedProtocolVersions() = %v, want [2]", got)
	}
}

func TestNegotiateProtocolVersionFailsClosed(t *testing.T) {
	// Invariant 2: an unrecognised set is an error, never a silent fallback to
	// MinProtocolVersion. If this ever returns (2, nil), a client that never
	// claimed v2 is being treated as a v2 device.
	for _, tc := range []struct {
		name string
		in   []int
		want error
	}{
		{"empty", nil, ErrUnsupportedProtocol},
		{"past only", []int{1}, ErrUnsupportedProtocol},
		{"future only", []int{3, 4}, ErrUnsupportedProtocol},
		{"zero", []int{0}, ErrUnsupportedProtocol},
		{"negative", []int{-1}, ErrUnsupportedProtocol},
		{"flood", make([]int, MaxProtocolVersions+1), ErrTooManyProtocolVer},
	} {
		t.Run(tc.name, func(t *testing.T) {
			v, err := NegotiateProtocolVersion(tc.in)
			if !errors.Is(err, tc.want) {
				t.Fatalf("err = %v, want %v", err, tc.want)
			}
			if v != 0 {
				t.Fatalf("a failed negotiation must yield no version, got %d", v)
			}
		})
	}
}

func TestNegotiateReceiveCapability(t *testing.T) {
	got, err := NegotiateReceiveCapability([]string{CapAutoAcceptV1, CapReceiveV2})
	if err != nil || got != CapReceiveV2 {
		t.Fatalf("got %q err %v, want %q", got, err, CapReceiveV2)
	}
	// A device that only implements a receive version central does not know
	// must not be registered as receiving: central cannot say what claiming a
	// task means for it, so listing it as a send target would be a guess.
	if _, err := NegotiateReceiveCapability([]string{"inbox.receive.v3", CapResumeV1}); !errors.Is(err, ErrUnsupportedCapability) {
		t.Fatalf("future-only receive capability must fail closed, got %v", err)
	}
	if _, err := NegotiateReceiveCapability(nil); !errors.Is(err, ErrUnsupportedCapability) {
		t.Fatalf("no receive capability must fail closed, got %v", err)
	}
	// v1 is not a downgrade path. A device announcing only the historical
	// receive capability is refused, because it cannot decode a v2 manifest and
	// listing it as a send target would promise a delivery it would fail.
	if _, err := NegotiateReceiveCapability([]string{CapReceiveV1, CapAutoAcceptV1, CapResumeV1}); !errors.Is(err, ErrUnsupportedCapability) {
		t.Fatalf("v1-only receive capability must fail closed, got %v", err)
	}
	// Announcing an unknown SIBLING alongside a supported one is fine — the
	// unknown one is carried, not negotiated.
	if got, err := NegotiateReceiveCapability([]string{"inbox.receive.v3", CapReceiveV2}); err != nil || got != CapReceiveV2 {
		t.Fatalf("mixed receive set: got %q err %v", got, err)
	}
	// The exported set the API echoes on a refusal must be the negotiable one,
	// so a rejection cannot tell a client to implement a version central just
	// stopped supporting.
	if got := SupportedReceiveCapabilities(); !reflect.DeepEqual(got, []string{CapReceiveV2}) {
		t.Fatalf("SupportedReceiveCapabilities() = %v, want [%s]", got, CapReceiveV2)
	}
}

func TestValidateCapabilitiesCanonicalises(t *testing.T) {
	got, err := ValidateCapabilities([]string{CapResumeV1, CapReceiveV2, CapReceiveV2, "vendor.thing.v12"})
	if err != nil {
		t.Fatalf("validate: %v", err)
	}
	want := []string{CapReceiveV2, CapResumeV1, "vendor.thing.v12"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v, want %v (deduped and sorted)", got, want)
	}
}

func TestTextCapabilityIsCarriedNotNegotiated(t *testing.T) {
	// Content kind lives only inside the encrypted manifest, so central could
	// not verify a text claim even if it wanted to. inbox.text.v1 must
	// therefore survive validation verbatim (the SENDER reads it) and must
	// never become a second gate on registration.
	got, err := ValidateCapabilities([]string{CapReceiveV2, CapTextV1})
	if err != nil {
		t.Fatalf("validate: %v", err)
	}
	if !reflect.DeepEqual(got, []string{CapReceiveV2, CapTextV1}) {
		t.Fatalf("got %v, want the text token carried verbatim", got)
	}
	// A receiver that does NOT announce text is still a fully valid target for
	// files. Absence of the token must not block registration.
	if _, err := NegotiateReceiveCapability([]string{CapReceiveV2}); err != nil {
		t.Fatalf("a file-only receiver must still register: %v", err)
	}
}

func TestValidateCapabilitiesRejectsMalformed(t *testing.T) {
	// The version suffix is mandatory precisely so no unversioned token can
	// exist to be silently redefined in a later release.
	for _, bad := range []string{
		"",                  // empty
		"inbox.receive",     // unversioned
		"inbox.receive.v0",  // v0 is not a version
		"inbox.receive.v01", // non-canonical spelling of v1
		"Inbox.Receive.v1",  // uppercase
		"inbox..receive.v1", // empty segment
		"inbox.receive.v1x", // trailing junk
		".v1",               // no name
		"v1",                // no name, single segment
		"inbox.receive.vv1",
		"inbox receive.v1", // space
	} {
		if _, err := ValidateCapabilities([]string{bad}); !errors.Is(err, ErrMalformedCapability) {
			t.Errorf("%q: err = %v, want ErrMalformedCapability", bad, err)
		}
	}
	long := "a." + string(make([]byte, MaxCapabilityLen)) + ".v1"
	if _, err := ValidateCapabilities([]string{long}); !errors.Is(err, ErrMalformedCapability) {
		t.Errorf("oversized token: err = %v", err)
	}
	flood := make([]string, MaxCapabilities+1)
	for i := range flood {
		flood[i] = CapReceiveV2
	}
	if _, err := ValidateCapabilities(flood); !errors.Is(err, ErrTooManyCapabilities) {
		t.Errorf("flood: err = %v, want ErrTooManyCapabilities", err)
	}
}

func TestValidatePublicKeyAcceptsRealX25519Key(t *testing.T) {
	priv, err := ecdh.X25519().GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	encoded := EncodePublicKey(priv.PublicKey().Bytes())
	raw, err := ValidatePublicKey(KeyAlgX25519SealedBoxV1, encoded)
	if err != nil {
		t.Fatalf("a real X25519 public key must validate: %v", err)
	}
	if !reflect.DeepEqual(raw, priv.PublicKey().Bytes()) {
		t.Fatal("decoded bytes differ from the announced key")
	}
}

func TestValidatePublicKeyRejectsLowOrderPoints(t *testing.T) {
	// Invariant 3. Each of these drives every X25519 exchange to the all-zero
	// shared secret, so a content key "wrapped" to one is wrapped to a value
	// anybody can compute. They are refused at REGISTRATION so that no sender
	// ever seals a task to one.
	//
	// The list is the canonical Curve25519 low-order set (libsodium's
	// blacklist); it is written out as literals here rather than derived from
	// the implementation under test, so a change to ValidatePublicKey cannot
	// quietly move the goalposts with it.
	for _, hexKey := range []string{
		"0000000000000000000000000000000000000000000000000000000000000000",
		"0100000000000000000000000000000000000000000000000000000000000000",
		"e0eb7a7c3b41b8ae1656e3faf19fc46ada098deb9c32b1fd866205165f49b800",
		"5f9c95bca3508c24b1d0b1559c83ef5b04445cc4581c8e86d8224eddd09f1157",
		"ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
		"edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
		"eeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
	} {
		raw, err := hex.DecodeString(hexKey)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := ValidatePublicKey(KeyAlgX25519SealedBoxV1, EncodePublicKey(raw)); !errors.Is(err, ErrUnusablePublicKey) {
			t.Errorf("%s: err = %v, want ErrUnusablePublicKey", hexKey, err)
		}
	}
}

func TestValidatePublicKeyRejectsMalformed(t *testing.T) {
	good := make([]byte, X25519PublicKeyBytes)
	good[0] = 9 // the standard base point: a valid, usable key
	for _, tc := range []struct {
		name, alg, key string
		want           error
	}{
		{"unknown algorithm", "rsa-oaep-v1", EncodePublicKey(good), ErrUnknownKeyAlgorithm},
		{"empty algorithm", "", EncodePublicKey(good), ErrUnknownKeyAlgorithm},
		{"not base64", KeyAlgX25519SealedBoxV1, "!!!!not base64!!!!", ErrMalformedPublicKey},
		{"standard base64 padding", KeyAlgX25519SealedBoxV1, base64.StdEncoding.EncodeToString(good), ErrMalformedPublicKey},
		{"too short", KeyAlgX25519SealedBoxV1, EncodePublicKey(good[:16]), ErrMalformedPublicKey},
		{"too long", KeyAlgX25519SealedBoxV1, EncodePublicKey(append(good, 0)), ErrMalformedPublicKey},
		{"empty", KeyAlgX25519SealedBoxV1, "", ErrMalformedPublicKey},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := ValidatePublicKey(tc.alg, tc.key); !errors.Is(err, tc.want) {
				t.Fatalf("err = %v, want %v", err, tc.want)
			}
		})
	}
}

func TestValidatePublicKeyRejectsNonCanonicalTrailingBits(t *testing.T) {
	good := make([]byte, X25519PublicKeyBytes)
	good[0] = 9
	canonical := EncodePublicKey(good)
	const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
	last := bytes.IndexByte([]byte(alphabet), canonical[len(canonical)-1])
	if last < 0 || last%16 != 0 {
		t.Fatalf("unexpected canonical final base64url digit %q", canonical[len(canonical)-1])
	}
	nonCanonical := canonical[:len(canonical)-1] + string(alphabet[last+1])
	decoded, err := base64.RawURLEncoding.DecodeString(nonCanonical)
	if err != nil || !bytes.Equal(decoded, good) {
		t.Fatalf("test precondition: permissive decoder did not produce the same bytes: %x, %v", decoded, err)
	}
	if _, err := ValidatePublicKey(KeyAlgX25519SealedBoxV1, nonCanonical); !errors.Is(err, ErrMalformedPublicKey) {
		t.Fatalf("non-canonical spelling %q: err = %v, want ErrMalformedPublicKey", nonCanonical, err)
	}
}

func TestValidateAutoAcceptDefaultsOff(t *testing.T) {
	// PRD §8: automatic write-to-disk is default-off. Omission must resolve to
	// "off" and never to "auto"; an unknown value is refused rather than
	// coerced.
	got, err := ValidateAutoAccept("")
	if err != nil || got != AutoAcceptOff {
		t.Fatalf("unspecified policy: got %q err %v, want %q", got, err, AutoAcceptOff)
	}
	for _, p := range []string{AutoAcceptOff, AutoAcceptAsk, AutoAcceptAuto} {
		if got, err := ValidateAutoAccept(p); err != nil || got != p {
			t.Fatalf("%q: got %q err %v", p, got, err)
		}
	}
	for _, bad := range []string{"AUTO", "always", "on", "true", "1"} {
		if _, err := ValidateAutoAccept(bad); !errors.Is(err, ErrInvalidAutoAccept) {
			t.Errorf("%q: err = %v, want ErrInvalidAutoAccept", bad, err)
		}
	}
}

func TestAutomaticPolicyRequiresVersionedCapability(t *testing.T) {
	if err := ValidateAutoAcceptCapability(AutoAcceptAuto, []string{CapReceiveV2}); !errors.Is(err, ErrUnsupportedAutoAcceptCapability) {
		t.Fatalf("auto without capability: err = %v", err)
	}
	if err := ValidateAutoAcceptCapability(AutoAcceptAuto, []string{CapReceiveV1, CapAutoAcceptV1}); err != nil {
		t.Fatalf("auto with capability: %v", err)
	}
	for _, policy := range []string{AutoAcceptOff, AutoAcceptAsk} {
		if err := ValidateAutoAcceptCapability(policy, []string{CapReceiveV2}); err != nil {
			t.Fatalf("%s should not require auto capability: %v", policy, err)
		}
	}
}

func TestPresenceExpiresTruthfully(t *testing.T) {
	// Invariant 4: presence is derived, so a device that dies without saying
	// goodbye goes offline by itself.
	now := time.Unix(1_000_000, 0)
	exp := PresenceExpiry(now)
	if want := now.Add(PresenceTTL).Unix(); exp != want {
		t.Fatalf("expiry = %d, want %d", exp, want)
	}
	if got := Presence(exp, now.Unix(), false); got != PresenceOnline {
		t.Fatalf("fresh heartbeat: %q", got)
	}
	if got := Presence(exp, exp-1, false); got != PresenceOnline {
		t.Fatalf("one second before expiry: %q", got)
	}
	// The boundary is inclusive-offline: at exactly the expiry second the
	// device is no longer claimed to be online.
	if got := Presence(exp, exp, false); got != PresenceOffline {
		t.Fatalf("at expiry: %q, want offline", got)
	}
	if got := Presence(exp, exp+1, false); got != PresenceOffline {
		t.Fatalf("after expiry: %q, want offline", got)
	}
	if got := Presence(0, now.Unix(), false); got != PresenceOffline {
		t.Fatalf("never heartbeat: %q, want offline", got)
	}
	// A revoked device is offline even while its last heartbeat is still
	// inside the window — it cannot be sent to, so "online" would mislead.
	if got := Presence(exp, now.Unix(), true); got != PresenceOffline {
		t.Fatalf("revoked with a live heartbeat: %q, want offline", got)
	}
	// PresenceTTL must stay a multiple of the interval central advertises, or
	// a device is declared dead before it was ever due to check in.
	if PresenceTTL <= HeartbeatInterval {
		t.Fatalf("PresenceTTL %v must exceed HeartbeatInterval %v", PresenceTTL, HeartbeatInterval)
	}
}

// Invariant 1 (central never receives private key material) is NOT asserted
// here. A raw X25519 private scalar is 32 bytes, exactly like a public key, so
// nothing this package can inspect tells them apart — a check here would look
// like coverage while being incapable of failing. It is asserted where it can
// actually fail: account.TestDeviceKeyRegistrationNeverStoresPrivateMaterial
// sweeps every column of the database for the private bytes after a
// registration that deliberately submits them.

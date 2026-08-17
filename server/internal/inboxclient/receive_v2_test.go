package inboxclient

import (
	"errors"
	"slices"
	"testing"

	"github.com/relayium/relayium/internal/inbox"
	"github.com/relayium/relayium/internal/inboxmanifest"
)

// The CLI receiver's half of Device Inbox v2: it reads the DEDICATED v2
// manifest, and it refuses a message deterministically rather than inventing
// somewhere to put one.
//
// Every case below is driven through the whole worker — real content key, real
// AEAD, real frames — because the property being asserted is what central is
// TOLD and what is left on disk, and neither is visible from the codec alone.

// TestWorkerRefusesATextDelivery is the invariant this build exists on the
// wrong side of: it has no message store, so a message is refused as
// `unsupported` and nothing is written.
//
// The failure this prevents is not a crash. It is a `.txt` file appearing in
// somebody's receive folder containing what they were told was a message —
// a different thing delivered from the one that was sent.
func TestWorkerRefusesATextDelivery(t *testing.T) {
	f := newFixture(t)
	f.enrol()
	message := []byte("meet me at six")
	id := f.fc.enqueueSealed(t, inboxManifestJSON(inboxmanifest.Manifest{
		V:     inboxmanifest.Version,
		Items: []inboxmanifest.Item{{Kind: inboxmanifest.KindText, Size: int64(len(message))}},
	}), [][]byte{message})

	if err := f.runOnce(); err != nil {
		t.Fatalf("run: %v", err)
	}
	assertReceiveDirEmpty(t, f.root)
	state, code := f.fc.taskState(id)
	if state != inbox.TaskFailedTerminal || code != inbox.TaskErrUnsupported {
		t.Fatalf("task = %s/%s, want failed_terminal/unsupported", state, code)
	}
}

// TestWorkerRefusesAV1ShapedManifest proves the receiver decodes the v2 codec
// and not the shared Stored-Wire manifest. `{"files":[…]}` is a perfectly valid
// StoredManifest and authenticates under the same key; if the shared codec were
// still in the path this delivery would land.
func TestWorkerRefusesAV1ShapedManifest(t *testing.T) {
	f := newFixture(t)
	f.enrol()
	body := []byte("hello")
	id := f.fc.enqueueSealed(t, []byte(`{"files":[{"name":"doc.txt","size":5}]}`),
		[][]byte{body})

	if err := f.runOnce(); err != nil {
		t.Fatalf("run: %v", err)
	}
	assertReceiveDirEmpty(t, f.root)
	state, code := f.fc.taskState(id)
	if state != inbox.TaskFailedTerminal || code != inbox.TaskErrVerifyFailed {
		t.Fatalf("task = %s/%s, want failed_terminal/verify_failed", state, code)
	}
}

// TestWorkerRefusesANonCanonicalManifest: the canonical-form rule is not a
// stylistic preference, and it has to hold through the receiver rather than only
// in the codec's own unit tests.
func TestWorkerRefusesANonCanonicalManifest(t *testing.T) {
	f := newFixture(t)
	f.enrol()
	body := []byte("hello")
	id := f.fc.enqueueSealed(t, []byte(`{"items":[{"kind":"file","name":"doc.txt","size":5}],"v":2}`),
		[][]byte{body})

	if err := f.runOnce(); err != nil {
		t.Fatalf("run: %v", err)
	}
	assertReceiveDirEmpty(t, f.root)
	state, code := f.fc.taskState(id)
	if state != inbox.TaskFailedTerminal || code != inbox.TaskErrVerifyFailed {
		t.Fatalf("task = %s/%s, want failed_terminal/verify_failed", state, code)
	}
}

// TestCheckManifestRefusesEveryKindThisBuildCannotCommit fixes the gate at the
// unit level too, so a future caller that reaches `checkManifest` by another
// route inherits the same refusal.
func TestCheckManifestRefusesEveryKindThisBuildCannotCommit(t *testing.T) {
	text := inboxmanifest.Manifest{
		V:     inboxmanifest.Version,
		Items: []inboxmanifest.Item{{Kind: inboxmanifest.KindText, Size: 11}},
	}
	if _, err := checkManifest(text, 1<<20); !errors.Is(err, ErrUnsupportedKind) {
		t.Fatalf("checkManifest(text) = %v, want ErrUnsupportedKind", err)
	}
	// And the classification it earns, which is what central is actually told.
	if f := classifyCrypto(ErrUnsupportedKind); f.State != inbox.TaskFailedTerminal ||
		f.Code != inbox.TaskErrUnsupported {
		t.Fatalf("classify = %s/%s, want failed_terminal/unsupported", f.State, f.Code)
	}

	files := inboxmanifest.Manifest{
		V:     inboxmanifest.Version,
		Items: []inboxmanifest.Item{{Kind: inboxmanifest.KindFile, Name: "a.txt", Size: 5}},
	}
	total, err := checkManifest(files, 1<<20)
	if err != nil || total != 5 {
		t.Fatalf("checkManifest(files) = %d, %v; want 5, nil", total, err)
	}
}

// TestCapabilitiesNeverAnnounceText is the truth claim. `inbox.text.v1` means
// "this receiver presents a message as a message"; announcing it here would tell
// a sender that a text send to this server ends somewhere a person can read it.
func TestCapabilitiesNeverAnnounceText(t *testing.T) {
	caps := Capabilities()
	if slices.Contains(caps, inbox.CapTextV1) {
		t.Fatalf("this build announces %s and has no message store: %v", inbox.CapTextV1, caps)
	}
	if !slices.Contains(caps, inbox.CapReceiveV2) {
		t.Fatalf("capabilities lack %s: %v", inbox.CapReceiveV2, caps)
	}
	if got := ProtocolVersions(); !slices.Equal(got, []int{inbox.ProtocolV2}) {
		t.Fatalf("protocol versions = %v, want [%d]", got, inbox.ProtocolV2)
	}
}

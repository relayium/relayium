package account

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/relayium/relayium/internal/storage"
)

// The completion capability's shared contract, pinned as a frozen vector.
//
// The same three constants appear in web/src/lib/store-crypto.completion.test.ts.
// They are duplicated rather than generated on purpose: the property under test
// is that two independent implementations — Go's crypto/hkdf and the browser's
// WebCrypto — derive the same bytes from the same key, and a vector either side
// computed for itself would prove nothing at all. If these two files ever
// disagree, a receiver cannot complete an object the sender uploaded.
const (
	// completionVectorKey is one pair-room file key, hex. Any 32 bytes would do;
	// this one is frozen so the two suites can be compared by eye.
	completionVectorKey = "5f3a1c9d0e2b47861fa4d8c30b95e27614af8b52c1d093e7a6b4f80c2d517e39"
	// completionVectorProof is what the RECEIVER derives from that key and sends.
	completionVectorProof = "9ae23a9d9aa452cad99682066c0a31d380f5365e3d098799434e95eec7225dbc"
	// completionVectorVerifier is what the SENDER derives from the same key and
	// hands the server at finalize. The server only ever sees this one.
	completionVectorVerifier = "4d65d3b38f80783cf6dd042e7620a9c3ddab790f12937cf8486be7b2fecc90c5"
)

func mustHex(t *testing.T, s string) []byte {
	t.Helper()
	b, err := hex.DecodeString(s)
	if err != nil {
		t.Fatalf("decode %q: %v", s, err)
	}
	return b
}

// The vector itself. Both derivations, against constants no implementation
// detail can drift under.
func TestCompletionProofAndVerifierMatchTheFrozenVector(t *testing.T) {
	key := mustHex(t, completionVectorKey)

	proof, err := pairRoomCompletionProof(key)
	if err != nil {
		t.Fatalf("derive proof: %v", err)
	}
	if got := hex.EncodeToString(proof); got != completionVectorProof {
		t.Fatalf("proof = %s, want %s", got, completionVectorProof)
	}
	verifier := pairRoomCompletionVerifier(proof)
	if got := hex.EncodeToString(verifier); got != completionVectorVerifier {
		t.Fatalf("verifier = %s, want %s", got, completionVectorVerifier)
	}
}

// The info string is the domain separator, and changing it is a wire break: a
// sender on the old string and a receiver on the new one would derive different
// proofs for the same key, and every completion would 403. Pinned as its exact
// ASCII bytes so a stray rename cannot pass review by looking plausible.
func TestCompletionInfoStringIsExactlyTheProtocolConstant(t *testing.T) {
	if pairRoomCompletionInfo != "relayium-preupload-complete-v1" {
		t.Fatalf("info = %q", pairRoomCompletionInfo)
	}
}

// A proof is a capability for ONE object: it is derived from that object's own
// file key, so it cannot be replayed against a sibling in the same batch.
func TestCompletionProofsDifferPerFileKey(t *testing.T) {
	a, err := pairRoomCompletionProof(mustHex(t, completionVectorKey))
	if err != nil {
		t.Fatalf("derive: %v", err)
	}
	other := mustHex(t, completionVectorKey)
	other[0] ^= 0x01
	b, err := pairRoomCompletionProof(other)
	if err != nil {
		t.Fatalf("derive: %v", err)
	}
	if string(a) == string(b) {
		t.Fatal("two different file keys derived the same completion proof")
	}
}

// The wire encoding both directions use, pinned alongside the bytes: the client
// sends base64url with no padding, and that is what the strict parser accepts.
func TestCompletionVectorWireEncoding(t *testing.T) {
	proof := mustHex(t, completionVectorProof)
	if got := base64.RawURLEncoding.EncodeToString(proof); got != "muI6nZqkUsrZloIGbAox04D1Nl49CYeZQ06V7sciXbw" {
		t.Fatalf("proof base64url = %s", got)
	}
	verifier := mustHex(t, completionVectorVerifier)
	if got := base64.RawURLEncoding.EncodeToString(verifier); got != "TWXTs4-AeDz23QQudiCpw92reQ8Sk3z4SGvnsv7MkMU" {
		t.Fatalf("verifier base64url = %s", got)
	}
}

// finalizeWith runs finalize with `body` as the raw request body ("" = no body
// at all, which is what every client before this feature sent) and returns the
// status and the new object's id.
func (h *pairHarness) finalizeWith(t *testing.T, uploadID, body string) (int, string) {
	t.Helper()
	var rdr io.Reader
	if body != "" {
		rdr = strings.NewReader(body)
	}
	req, _ := http.NewRequest("POST", h.ts.URL+"/api/uploads/"+uploadID+"/finalize", rdr)
	req.AddCookie(h.cookie)
	resp, err := h.ts.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return resp.StatusCode, ""
	}
	var out struct {
		ID string `json:"id"`
	}
	decodeJSON(t, resp, &out)
	return 200, out.ID
}

// verifierBody renders a finalize body carrying `v` as the completion verifier.
func verifierBody(v string) string { return `{"completionVerifier":"` + v + `"}` }

// preUploadWith runs a whole pre-upload and finalizes it with `body`.
func (h *pairHarness) preUploadWith(t *testing.T, code string, blob []byte, body string) (int, string) {
	t.Helper()
	status, uploadID, _ := h.initPairUpload(t, code, len(blob), "")
	if status != 200 {
		t.Fatalf("init: %d", status)
	}
	if got := h.patch(t, uploadID, blob, 0, len(blob), len(blob)); got != 200 {
		t.Fatalf("patch: %d", got)
	}
	return h.finalizeWith(t, uploadID, body)
}

// storedVerifier reads back the verifier column of an object.
func (h *pairHarness) storedVerifier(t *testing.T, id string) []byte {
	t.Helper()
	sf, err := h.store.GetStoredFile(context.Background(), id)
	if err != nil {
		t.Fatalf("stored file %s: %v", id, err)
	}
	return sf.CompletionVerifier
}

// The sender's half of the contract: what it hands finalize is stored, verbatim,
// on the object's own row.
func TestFinalizeStoresTheSenderCompletionVerifier(t *testing.T) {
	h := newPairHarness(t)
	h.mintCode("310000", "")
	want := mustHex(t, completionVectorVerifier)

	status, id := h.preUploadWith(t, "310000", bytes.Repeat([]byte("V"), 1024),
		verifierBody(base64.RawURLEncoding.EncodeToString(want)))
	if status != 200 {
		t.Fatalf("finalize: %d", status)
	}
	if got := h.storedVerifier(t, id); !bytes.Equal(got, want) {
		t.Fatalf("stored verifier = %x, want %x", got, want)
	}
}

// BACKWARD COMPATIBILITY, in the direction that actually ships first: every
// client that exists today finalizes with no body at all, and must keep getting
// exactly the object it always got. NULL, not an empty blob — the column has to
// be indistinguishable from the rows written before it existed.
func TestFinalizeWithoutAVerifierStoresNull(t *testing.T) {
	h := newPairHarness(t)
	h.mintCode("310001", "")

	status, id := h.preUploadWith(t, "310001", bytes.Repeat([]byte("V"), 1024), "")
	if status != 200 {
		t.Fatalf("finalize: %d", status)
	}
	if got := h.storedVerifier(t, id); got != nil {
		t.Fatalf("stored verifier = %x, want NULL", got)
	}
	// And the same for a body that is a well-formed JSON object with no verifier
	// in it: absent is absent, however it is spelled.
	status, id = h.preUploadWith(t, "310001", bytes.Repeat([]byte("V"), 1024), `{}`)
	if status != 200 {
		t.Fatalf("finalize with {}: %d", status)
	}
	if got := h.storedVerifier(t, id); got != nil {
		t.Fatalf("stored verifier for {} = %x, want NULL", got)
	}
}

// ONLY a pair-room object may carry one. A share or a Device Inbox object has no
// completion lifecycle at all — its retention is its own — so a verifier on one
// is a caller that has misunderstood the endpoint, and it is refused rather than
// stored and ignored. Refused, never overridden, exactly as the pair-room upload
// path already refuses retention parameters.
func TestFinalizeRefusesAVerifierOnANonPairRoomUpload(t *testing.T) {
	h := newPairHarness(t)
	blob := bytes.Repeat([]byte("S"), 512)
	uploadID := initUpload(t, h.ts, h.cookie, []byte("MANIFEST"), len(blob), 3600)
	if code, _ := patchChunk(t, h.ts, h.cookie, uploadID, blob, 0, len(blob), len(blob)); code != 200 {
		t.Fatalf("patch: %d", code)
	}
	body := verifierBody(base64.RawURLEncoding.EncodeToString(mustHex(t, completionVectorVerifier)))
	if status, _ := h.finalizeWith(t, uploadID, body); status != 400 {
		t.Fatalf("share finalize with a verifier: %d, want 400", status)
	}
	// And the refusal cost the sender nothing: the upload is still finalizable,
	// because a 400 must be answered before anything claims the session.
	status, id := h.finalizeWith(t, uploadID, "")
	if status != 200 {
		t.Fatalf("retry without a verifier: %d, want 200", status)
	}
	if got := h.storedVerifier(t, id); got != nil {
		t.Fatalf("share stored a verifier: %x", got)
	}
}

// Strict parsing, stated case by case. Every one of these is a value that would
// either silently truncate a credential or make one object's verifier collide
// with another's, so each is a 400 rather than a best-effort decode.
func TestFinalizeRefusesMalformedCompletionVerifiers(t *testing.T) {
	full := base64.RawURLEncoding.EncodeToString(mustHex(t, completionVectorVerifier))
	std := base64.StdEncoding.EncodeToString(mustHex(t, completionVectorVerifier))
	for _, tc := range []struct{ name, body string }{
		{"31 bytes", verifierBody(base64.RawURLEncoding.EncodeToString(make([]byte, 31)))},
		{"33 bytes", verifierBody(base64.RawURLEncoding.EncodeToString(make([]byte, 33)))},
		{"empty", verifierBody("")},
		{"padded", verifierBody(base64.URLEncoding.EncodeToString(mustHex(t, completionVectorVerifier)))},
		{"standard alphabet", verifierBody(std)},
		{"trailing padding chars", verifierBody(full + "=")},
		{"whitespace", verifierBody(full[:20] + " " + full[21:])},
		{"not a string", `{"completionVerifier":123}`},
		{"null", `{"completionVerifier":null}`},
		{"invalid JSON", `{"completionVerifier":`},
		{"trailing JSON", verifierBody(full) + `{"completionVerifier":"x"}`},
		{"JSON array", `[{"completionVerifier":"` + full + `"}]`},
		{"not JSON at all", "completionVerifier=" + full},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h := newPairHarness(t)
			h.mintCode("310002", "")
			status, uploadID, _ := h.initPairUpload(t, "310002", 1024, "")
			if status != 200 {
				t.Fatalf("init: %d", status)
			}
			blob := bytes.Repeat([]byte("M"), 1024)
			if got := h.patch(t, uploadID, blob, 0, len(blob), len(blob)); got != 200 {
				t.Fatalf("patch: %d", got)
			}
			if got, _ := h.finalizeWith(t, uploadID, tc.body); got != 400 {
				t.Fatalf("finalize with %s: %d, want 400", tc.name, got)
			}
			// A malformed request must not consume the upload. The terminal claim
			// is what makes finalize once-only, so a 400 taken after it would turn
			// one typo into an unrecoverable upload — the sender's bytes are on the
			// node and no second finalize can ever land them.
			if got, id := h.finalizeWith(t, uploadID, ""); got != 200 || id == "" {
				t.Fatalf("retry after the refusal: %d", got)
			}
		})
	}
}

// bodyPaddedTo grows `body` to exactly n bytes with TRAILING WHITESPACE, which
// JSON permits after a value and every rule here otherwise ignores. So a padded
// body differs from the body it was made from in exactly one respect — its
// length — and a test built on it is testing the length bound and nothing else.
func bodyPaddedTo(t *testing.T, body string, n int) string {
	t.Helper()
	if len(body) > n {
		t.Fatalf("body is already %d bytes, past %d", len(body), n)
	}
	return body + strings.Repeat(" ", n-len(body))
}

// THE LIMIT BOUNDS THE BODY, not the prefix of it the server bothered to read.
//
// The distinction is the whole finding. Spelling the bound as an io.LimitReader
// makes the decoder see an EOF at the boundary — and an EOF is precisely what
// the trailing-content rule reads as "nothing followed". So the length rule
// would silently repeal the strictness rule: every body below has a valid,
// clean-parsing first kilobyte, and each was accepted under the truncating
// spelling however much followed it.
func TestFinalizeRefusesABodyPastTheLimit(t *testing.T) {
	full := base64.RawURLEncoding.EncodeToString(mustHex(t, completionVectorVerifier))
	valid := verifierBody(full)
	atLimit := bodyPaddedTo(t, valid, maxCompletionBodyBytes)
	for _, tc := range []struct{ name, body string }{
		{"one byte of whitespace past the limit", atLimit + " "},
		{"a kilobyte of whitespace past the limit", atLimit + strings.Repeat(" ", 1<<10)},
		{"a newline past the limit", atLimit + "\n"},
		{"trailing JSON past the limit", atLimit + verifierBody("x")},
		{"a second whole object past the limit", atLimit + valid},
		{"trailing garbage past the limit", atLimit + strings.Repeat("\x00", 64)},
		// Not a bypass, just the plain reading of the bound: a body oversize while
		// being valid JSON throughout is refused for its SIZE. Unknown fields are
		// allowed through (the body is extensible) — a kilobyte of them is not.
		{"one oversize but entirely valid object", `{"pad":"` + strings.Repeat("p", 1<<10) + `",` + valid[1:]},
		// And the absent-body path must not be reachable by padding: a kilobyte of
		// whitespace is a body, and is not a client that sent none. Under the
		// truncating spelling this stored NULL and answered 200.
		{"whitespace only, past the limit", strings.Repeat(" ", maxCompletionBodyBytes+1)},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h := newPairHarness(t)
			h.mintCode("310003", "")
			status, uploadID, _ := h.initPairUpload(t, "310003", 1024, "")
			if status != 200 {
				t.Fatalf("init: %d", status)
			}
			blob := bytes.Repeat([]byte("L"), 1024)
			if got := h.patch(t, uploadID, blob, 0, len(blob), len(blob)); got != 200 {
				t.Fatalf("patch: %d", got)
			}
			if got, id := h.finalizeWith(t, uploadID, tc.body); got != 400 {
				t.Fatalf("finalize with %s: %d (id %q), want 400", tc.name, got, id)
			}
			// The oversize body cost the sender a request and nothing else, exactly
			// as every other 400 on this route does.
			if got, id := h.finalizeWith(t, uploadID, ""); got != 200 || id == "" {
				t.Fatalf("retry after the refusal: %d", got)
			}
		})
	}
}

// Every storage-placement path writes the verifier in the SAME statement that
// creates the row. There is no window in which an object exists without the
// verifier its sender asked for — which would be an object that can never be
// completed, held forever by the very rule completion exists to end.
func TestCompletionVerifierIsWrittenByEveryInsertPath(t *testing.T) {
	ctx := context.Background()
	store := newTestStore(t)
	owner := testUser(t, store)
	want := mustHex(t, completionVectorVerifier)

	// 1. The plain path: no room, no caps (CreateStoredFile).
	plain := StoredFile{
		ID: "sf-plain", UserID: owner, BlobKey: "bk-plain", Size: 10,
		EncManifest: []byte("OPAQUE"),
		CreatedAt:   1000, ExpiresAt: 9000, Purpose: StoredPurposeShare,
		CompletionVerifier: want,
	}
	if err := store.CreateStoredFile(ctx, plain); err != nil {
		t.Fatalf("plain insert: %v", err)
	}
	// 2. The CAPPED path (userCap/globalCap > 0).
	capped := plain
	capped.ID, capped.BlobKey = "sf-capped", "bk-capped"
	if w, err := store.CreateStoredFileWithinStorageCaps(ctx, capped, 1000, 1<<30, 1<<30); err != nil || w.Reason != "" {
		t.Fatalf("capped insert: %v %q", err, w.Reason)
	}
	// 3. The UNCAPPED path through the same method (both caps disabled), which is
	//    the one every pair-room object takes.
	uncapped := plain
	uncapped.ID, uncapped.BlobKey = "sf-uncapped", "bk-uncapped"
	if w, err := store.CreateStoredFileWithinStorageCaps(ctx, uncapped, 1000, 0, 0); err != nil || w.Reason != "" {
		t.Fatalf("uncapped insert: %v %q", err, w.Reason)
	}
	for _, id := range []string{"sf-plain", "sf-capped", "sf-uncapped"} {
		sf, err := store.GetStoredFile(ctx, id)
		if err != nil {
			t.Fatalf("read %s: %v", id, err)
		}
		if !bytes.Equal(sf.CompletionVerifier, want) {
			t.Fatalf("%s verifier = %x, want %x", id, sf.CompletionVerifier, want)
		}
	}
	// And a REFUSED insert writes nothing at all — neither a row nor a verifier.
	refused := plain
	refused.ID, refused.BlobKey, refused.Size = "sf-refused", "bk-refused", 1<<20
	w, err := store.CreateStoredFileWithinStorageCaps(ctx, refused, 1000, 1, 0)
	if err != nil || w.Reason != "storage" {
		t.Fatalf("refused insert: %v %q", err, w.Reason)
	}
	if _, err := store.GetStoredFile(ctx, "sf-refused"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("a refused insert left a row: %v", err)
	}
}

// A row written before the column existed reads as NULL, not as an empty
// credential. Everything downstream keys off that distinction, so it is pinned
// where the migration happens rather than only where it is consumed.
func TestRowsPredatingTheColumnReadAsNoVerifier(t *testing.T) {
	ctx := context.Background()
	store := newTestStore(t)
	owner := testUser(t, store)
	old := StoredFile{
		ID: "sf-old", UserID: owner, BlobKey: "bk-old", Size: 10,
		EncManifest: []byte("OPAQUE"),
		CreatedAt:   1000, ExpiresAt: 9000, Purpose: StoredPurposeShare,
	}
	if err := store.CreateStoredFile(ctx, old); err != nil {
		t.Fatalf("insert: %v", err)
	}
	sf, err := store.GetStoredFile(ctx, "sf-old")
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if sf.CompletionVerifier != nil {
		t.Fatalf("verifier = %x, want nil", sf.CompletionVerifier)
	}
}

// testUser makes a real account row, so a store-level test can insert stored
// files without tripping the foreign key.
func testUser(t *testing.T, store *SQLiteStore) string {
	t.Helper()
	u, err := store.UpsertUserByEmail(context.Background(), "owner@example.com", "Owner")
	if err != nil {
		t.Fatalf("create user: %v", err)
	}
	return u.ID
}

// ---------------------------------------------------------------------------
// POST /api/files/{id}/complete — the receiver's half.
// ---------------------------------------------------------------------------

// completeAnon posts a completion with NO cookie, which is the receiver's real
// situation: it has six digits, an id and a key, and no account at all.
func (h *pairHarness) completeAnon(t *testing.T, id, body string) (*http.Response, []byte) {
	t.Helper()
	req, _ := http.NewRequest("POST", h.ts.URL+"/api/files/"+id+"/complete", strings.NewReader(body))
	resp, err := h.ts.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return resp, b
}

// proofBody renders a completion request body carrying `p`.
func proofBody(p string) string { return `{"proof":"` + p + `"}` }

// completeWithKey completes `id` with the proof derived from `fileKey`.
func (h *pairHarness) completeWithKey(t *testing.T, id string, fileKey []byte) (*http.Response, []byte) {
	t.Helper()
	proof, err := pairRoomCompletionProof(fileKey)
	if err != nil {
		t.Fatalf("derive proof: %v", err)
	}
	return h.completeAnon(t, id, proofBody(base64.RawURLEncoding.EncodeToString(proof)))
}

// preUploadCompletable runs a pre-upload whose sender asked for a completion
// capability, and returns (objectId, fileKey).
func (h *pairHarness) preUploadCompletable(t *testing.T, code string, blob []byte, fileKey []byte) string {
	t.Helper()
	proof, err := pairRoomCompletionProof(fileKey)
	if err != nil {
		t.Fatalf("derive proof: %v", err)
	}
	v := pairRoomCompletionVerifier(proof)
	status, id := h.preUploadWith(t, code, blob, verifierBody(base64.RawURLEncoding.EncodeToString(v)))
	if status != 200 {
		t.Fatalf("finalize: %d", status)
	}
	return id
}

// fileKeyN is a distinct 32-byte file key per test, so a cross-object replay is
// genuinely a different key rather than the same one twice.
func fileKeyN(n byte) []byte {
	k := make([]byte, 32)
	for i := range k {
		k[i] = n ^ byte(i*7+1)
	}
	return k
}

func (h *pairHarness) roomOf(t *testing.T, id string) PairRoom {
	t.Helper()
	sf, err := h.store.GetStoredFile(context.Background(), id)
	if err != nil {
		t.Fatalf("stored file: %v", err)
	}
	room, found, err := h.store.GetPairRoom(context.Background(), sf.PairRoomID)
	if err != nil || !found {
		t.Fatalf("room %s: %v found=%v", sf.PairRoomID, err, found)
	}
	return room
}

func (h *pairHarness) pendingDeletes(t *testing.T) []PendingNodeDelete {
	t.Helper()
	p, err := h.store.ListPendingNodeDeletes(context.Background())
	if err != nil {
		t.Fatalf("pending deletes: %v", err)
	}
	return p
}

func (h *pairHarness) currentStorage(t *testing.T) int64 {
	t.Helper()
	n, err := h.store.CurrentStorage(context.Background(), h.userID, h.now)
	if err != nil {
		t.Fatalf("current storage: %v", err)
	}
	return n
}

// THE HAPPY PATH, and every consequence it is supposed to have at once: the row
// is gone, the quota is back, the blob is gone, and the responsibility for the
// blob was written down before anything could fail.
func TestACorrectProofCompletesTheObject(t *testing.T) {
	h := newPairHarness(t)
	h.mintCode("320000", "")
	key := fileKeyN(1)
	blob := bytes.Repeat([]byte("C"), 4096)
	id := h.preUploadCompletable(t, "320000", blob, key)

	sf, err := h.store.GetStoredFile(context.Background(), id)
	if err != nil {
		t.Fatalf("stored file: %v", err)
	}
	if h.currentStorage(t) == 0 {
		t.Fatal("the object is not counted against storage before completion")
	}

	resp, body := h.completeWithKey(t, id, key)
	if resp.StatusCode != 204 {
		t.Fatalf("complete: %d %s", resp.StatusCode, body)
	}
	if len(body) != 0 {
		t.Fatalf("204 carried a body: %q", body)
	}
	if got := resp.Header.Get("Cache-Control"); !strings.Contains(got, "no-store") {
		t.Fatalf("Cache-Control = %q, want no-store", got)
	}
	// The authoritative row is gone, which is what releases the quota — not a
	// later sweep, and not the node answering.
	if _, err := h.store.GetStoredFile(context.Background(), id); !errors.Is(err, ErrNotFound) {
		t.Fatalf("row survived completion: %v", err)
	}
	if n := h.currentStorage(t); n != 0 {
		t.Fatalf("storage still charged after completion: %d", n)
	}
	// The blob's deletion responsibility was made durable INSIDE the transaction,
	// so it exists whether or not the node could be reached afterwards.
	pend := h.pendingDeletes(t)
	if len(pend) != 1 || pend[0].BlobKey != sf.BlobKey {
		t.Fatalf("pending deletes = %+v, want one row for %s", pend, sf.BlobKey)
	}
	if pend[0].NotBefore <= h.now {
		t.Fatalf("intent NotBefore = %d, want held past %d", pend[0].NotBefore, h.now)
	}
	if h.blobExists(t, sf.BlobKey) {
		t.Fatal("ciphertext survived a completion")
	}
	// And the object is no longer readable by anybody.
	if status, _ := h.getAnon(t, "/api/files/"+id+"/meta"); status != 404 {
		t.Fatalf("/meta after completion: %d, want 404", status)
	}
}

// A wrong proof changes NOTHING. Not the row, not the blob, not the quota — and
// the object stays downloadable, because a failed completion is a failed
// completion and not a half-performed one.
func TestAWrongProofCompletesNothing(t *testing.T) {
	h := newPairHarness(t)
	h.mintCode("320001", "")
	blob := bytes.Repeat([]byte("W"), 2048)
	id := h.preUploadCompletable(t, "320001", blob, fileKeyN(2))

	resp, _ := h.completeWithKey(t, id, fileKeyN(99))
	if resp.StatusCode != 403 {
		t.Fatalf("wrong proof: %d, want 403", resp.StatusCode)
	}
	if _, err := h.store.GetStoredFile(context.Background(), id); err != nil {
		t.Fatalf("row removed by a wrong proof: %v", err)
	}
	if len(h.pendingDeletes(t)) != 0 {
		t.Fatal("a wrong proof queued a blob deletion")
	}
	status, got := h.getAnon(t, "/api/files/"+id+"/blob")
	if status != 200 || !bytes.Equal(got, blob) {
		t.Fatalf("blob after a wrong proof: %d, %d bytes", status, len(got))
	}
}

// A proof is scoped to ONE object. Two files in the same batch, uploaded by the
// same sender into the same room, must not be completable with each other's
// proofs — otherwise the first key a receiver is handed ends the whole batch.
func TestAProofFromASiblingObjectIsRefused(t *testing.T) {
	h := newPairHarness(t)
	h.mintCode("320002", "")
	keyA, keyB := fileKeyN(3), fileKeyN(4)
	idA := h.preUploadCompletable(t, "320002", bytes.Repeat([]byte("A"), 1024), keyA)
	idB := h.preUploadCompletable(t, "320002", bytes.Repeat([]byte("B"), 1024), keyB)

	if resp, _ := h.completeWithKey(t, idB, keyA); resp.StatusCode != 403 {
		t.Fatalf("A's proof against B: %d, want 403", resp.StatusCode)
	}
	if resp, _ := h.completeWithKey(t, idA, keyB); resp.StatusCode != 403 {
		t.Fatalf("B's proof against A: %d, want 403", resp.StatusCode)
	}
	for _, id := range []string{idA, idB} {
		if _, err := h.store.GetStoredFile(context.Background(), id); err != nil {
			t.Fatalf("%s removed by a cross-object proof: %v", id, err)
		}
	}
	// ...and each still completes with its OWN proof, so the refusal above was
	// about the proof and not about some incidental breakage.
	if resp, _ := h.completeWithKey(t, idA, keyA); resp.StatusCode != 204 {
		t.Fatalf("A with A's proof: %d", resp.StatusCode)
	}
	if resp, _ := h.completeWithKey(t, idB, keyB); resp.StatusCode != 204 {
		t.Fatalf("B with B's proof: %d", resp.StatusCode)
	}
}

// A pair-room object whose sender never asked for a completion capability cannot
// be completed by anybody, and says so with its own status.
//
// 409 rather than 403, deliberately: 403 means "that proof is wrong", and a
// client that hears it will keep deriving proofs from the key it holds forever.
// This object's life simply is not endable this way — the sender predates the
// capability, or chose not to offer one — and the receiver has to be able to
// tell those apart to report anything true to its user.
func TestAnObjectWithNoVerifierCannotBeCompleted(t *testing.T) {
	h := newPairHarness(t)
	h.mintCode("320003", "")
	blob := bytes.Repeat([]byte("N"), 1024)
	status, id := h.preUploadWith(t, "320003", blob, "") // an old sender: no verifier
	if status != 200 {
		t.Fatalf("finalize: %d", status)
	}

	resp, body := h.completeWithKey(t, id, fileKeyN(5))
	if resp.StatusCode != 409 {
		t.Fatalf("completion of a verifier-less object: %d %s, want 409", resp.StatusCode, body)
	}
	if _, err := h.store.GetStoredFile(context.Background(), id); err != nil {
		t.Fatalf("row removed despite the 409: %v", err)
	}
	if len(h.pendingDeletes(t)) != 0 {
		t.Fatal("a 409 queued a blob deletion")
	}
	if s, got := h.getAnon(t, "/api/files/"+id+"/blob"); s != 200 || !bytes.Equal(got, blob) {
		t.Fatalf("blob after the 409: %d, %d bytes", s, len(got))
	}
}

// NO EXISTENCE ORACLE. An id that never existed, an id that was completed a
// moment ago, and an id belonging to a share or a Device Inbox object are all
// answered identically — the same status and the same empty body — because the
// endpoint is unauthenticated and the alternative is a free "does this id exist"
// probe over the whole stored-object space.
//
// And the two kinds it must never touch are checked for survival, not merely for
// the status: a share deleted by a stranger POSTing at it would be a catastrophe
// that a status-only test would miss.
func TestCompletionIsIndistinguishableForAbsentAndForeignObjects(t *testing.T) {
	h := newPairHarness(t)
	h.mintCode("320004", "")
	key := fileKeyN(6)
	done := h.preUploadCompletable(t, "320004", bytes.Repeat([]byte("D"), 1024), key)
	if resp, _ := h.completeWithKey(t, done, key); resp.StatusCode != 204 {
		t.Fatalf("first completion: %d", resp.StatusCode)
	}

	// A share, uploaded normally by the same account.
	shareBlob := bytes.Repeat([]byte("S"), 512)
	shareUpload := initUpload(t, h.ts, h.cookie, []byte("MANIFEST"), len(shareBlob), 3600)
	if code, _ := patchChunk(t, h.ts, h.cookie, shareUpload, shareBlob, 0, len(shareBlob), len(shareBlob)); code != 200 {
		t.Fatalf("share patch: %d", code)
	}
	shareStatus, shareID := h.finalizeWith(t, shareUpload, "")
	if shareStatus != 200 {
		t.Fatalf("share finalize: %d", shareStatus)
	}

	proof, _ := pairRoomCompletionProof(key)
	body := proofBody(base64.RawURLEncoding.EncodeToString(proof))
	for _, tc := range []struct{ name, id string }{
		{"never existed", "0123456789abcdef0123456789abcdef"},
		{"already completed", done},
		{"a share", shareID},
	} {
		resp, got := h.completeAnon(t, tc.id, body)
		if resp.StatusCode != 204 {
			t.Fatalf("%s: %d, want 204", tc.name, resp.StatusCode)
		}
		if len(got) != 0 {
			t.Fatalf("%s: body %q, want empty", tc.name, got)
		}
	}
	// The share is untouched: still readable, still the account's.
	if s, got := h.getAnon(t, "/api/files/"+shareID+"/blob"); s != 200 || !bytes.Equal(got, shareBlob) {
		t.Fatalf("the share was disturbed: %d, %d bytes", s, len(got))
	}
	if len(h.pendingDeletes(t)) != 1 {
		t.Fatalf("pending deletes = %d, want only the completed object's", len(h.pendingDeletes(t)))
	}
}

// Strict parsing on the receiver's side too, and for the same reason: every one
// of these is a value that could otherwise be read as a credential it is not.
func TestCompletionRefusesMalformedProofs(t *testing.T) {
	h := newPairHarness(t)
	h.mintCode("320005", "")
	key := fileKeyN(7)
	blob := bytes.Repeat([]byte("P"), 1024)
	id := h.preUploadCompletable(t, "320005", blob, key)
	proof, _ := pairRoomCompletionProof(key)
	full := base64.RawURLEncoding.EncodeToString(proof)

	for _, tc := range []struct{ name, body string }{
		{"31 bytes", proofBody(base64.RawURLEncoding.EncodeToString(make([]byte, 31)))},
		{"33 bytes", proofBody(base64.RawURLEncoding.EncodeToString(make([]byte, 33)))},
		{"empty", proofBody("")},
		{"padded", proofBody(base64.URLEncoding.EncodeToString(proof))},
		{"standard alphabet", proofBody(base64.StdEncoding.EncodeToString(proof))},
		{"trailing =", proofBody(full + "=")},
		{"whitespace", proofBody(full[:20] + " " + full[21:])},
		{"missing field", `{}`},
		{"not a string", `{"proof":123}`},
		{"null", `{"proof":null}`},
		{"invalid JSON", `{"proof":`},
		{"trailing JSON", proofBody(full) + `{"proof":"x"}`},
		{"empty body", ``},
		{"not JSON at all", "proof=" + full},
	} {
		t.Run(tc.name, func(t *testing.T) {
			resp, _ := h.completeAnon(t, id, tc.body)
			if resp.StatusCode != 400 {
				t.Fatalf("%s: %d, want 400", tc.name, resp.StatusCode)
			}
		})
	}
	// None of that disturbed the object: it still completes with a real proof.
	if resp, _ := h.completeWithKey(t, id, key); resp.StatusCode != 204 {
		t.Fatalf("completion after the malformed attempts: %d", resp.StatusCode)
	}
}

// The same bound on the receiver's side, where it is a capability rather than a
// record that is at stake: an oversize body must be refused BEFORE its proof is
// spent, so a padded request cannot delete anything.
func TestCompletionRefusesABodyPastTheLimit(t *testing.T) {
	h := newPairHarness(t)
	h.mintCode("320013", "")
	key := fileKeyN(21)
	id := h.preUploadCompletable(t, "320013", bytes.Repeat([]byte("L"), 1024), key)
	proof, err := pairRoomCompletionProof(key)
	if err != nil {
		t.Fatalf("derive proof: %v", err)
	}
	// Every body below carries the RIGHT proof. That is what makes them
	// adversarial rather than merely malformed: under the truncating spelling the
	// proof was read out of the first kilobyte and the object was deleted, so the
	// only thing standing between the padding and the file was the bound.
	valid := proofBody(base64.RawURLEncoding.EncodeToString(proof))
	atLimit := bodyPaddedTo(t, valid, maxCompletionBodyBytes)
	for _, tc := range []struct{ name, body string }{
		{"one byte of whitespace past the limit", atLimit + " "},
		{"a kilobyte of whitespace past the limit", atLimit + strings.Repeat(" ", 1<<10)},
		{"a newline past the limit", atLimit + "\n"},
		{"trailing JSON past the limit", atLimit + proofBody("x")},
		{"a second whole object past the limit", atLimit + valid},
		{"trailing garbage past the limit", atLimit + strings.Repeat("\x00", 64)},
		{"one oversize but entirely valid object", `{"pad":"` + strings.Repeat("p", 1<<10) + `",` + valid[1:]},
		{"whitespace only, past the limit", strings.Repeat(" ", maxCompletionBodyBytes+1)},
	} {
		t.Run(tc.name, func(t *testing.T) {
			resp, _ := h.completeAnon(t, id, tc.body)
			if resp.StatusCode != 400 {
				t.Fatalf("%s: %d, want 400", tc.name, resp.StatusCode)
			}
			// Refused BEFORE the proof was spent: the row, the blob and the quota
			// are all still there. A 400 that had deleted the object anyway would
			// be the finding rather than its fix.
			if _, err := h.store.GetStoredFile(context.Background(), id); err != nil {
				t.Fatalf("%s removed the object: %v", tc.name, err)
			}
		})
	}
	// And none of it disturbed the capability: the same proof, sent in a body
	// within the bound, still completes the object.
	if resp, _ := h.completeWithKey(t, id, key); resp.StatusCode != 204 {
		t.Fatalf("completion after the oversize attempts: %d", resp.StatusCode)
	}
}

// THE BOUNDARY ITSELF, stated in both directions on both routes, because
// "bounds" does not on its own say which side the equal case falls on.
// maxCompletionBodyBytes is INCLUSIVE: a body of exactly that many bytes is read
// and judged on its merits, and the first byte past it is a 400. Same body,
// one byte apart, so nothing but the length can account for the difference.
func TestCompletionBodyLimitIsInclusiveAtItsBoundary(t *testing.T) {
	h := newPairHarness(t)
	want := mustHex(t, completionVectorVerifier)
	valid := verifierBody(base64.RawURLEncoding.EncodeToString(want))

	// Sender's side: exactly the limit is parsed, and its verifier is stored.
	h.mintCode("310010", "")
	blob := bytes.Repeat([]byte("B"), 512)
	status, id := h.preUploadWith(t, "310010", blob, bodyPaddedTo(t, valid, maxCompletionBodyBytes))
	if status != 200 {
		t.Fatalf("finalize at the limit: %d, want 200", status)
	}
	if got := h.storedVerifier(t, id); !bytes.Equal(got, want) {
		t.Fatalf("verifier stored at the limit = %x, want %x", got, want)
	}
	// One byte more is a refusal.
	if status, _ := h.preUploadWith(t, "310010", blob, bodyPaddedTo(t, valid, maxCompletionBodyBytes+1)); status != 400 {
		t.Fatalf("finalize one byte past the limit: %d, want 400", status)
	}

	// Receiver's side: the same two lengths, the same verdicts. The over-limit
	// body goes first so the accepted one is what finally spends the proof.
	h.mintCode("310011", "")
	key := fileKeyN(22)
	cid := h.preUploadCompletable(t, "310011", blob, key)
	proof, err := pairRoomCompletionProof(key)
	if err != nil {
		t.Fatalf("derive proof: %v", err)
	}
	pvalid := proofBody(base64.RawURLEncoding.EncodeToString(proof))
	if resp, _ := h.completeAnon(t, cid, bodyPaddedTo(t, pvalid, maxCompletionBodyBytes+1)); resp.StatusCode != 400 {
		t.Fatalf("complete one byte past the limit: %d, want 400", resp.StatusCode)
	}
	if resp, _ := h.completeAnon(t, cid, bodyPaddedTo(t, pvalid, maxCompletionBodyBytes)); resp.StatusCode != 204 {
		t.Fatalf("complete at the limit: %d, want 204", resp.StatusCode)
	}
}

// Two receivers — or one receiver retrying an answer it never saw — must both
// come away safe, and the object must be removed exactly once. Anything else
// double-bills the blob's deletion or double-releases the room.
func TestConcurrentCompletionsRemoveTheObjectExactlyOnce(t *testing.T) {
	h := newPairHarness(t)
	h.mintCode("320006", "")
	key := fileKeyN(8)
	id := h.preUploadCompletable(t, "320006", bytes.Repeat([]byte("R"), 4096), key)
	sf, err := h.store.GetStoredFile(context.Background(), id)
	if err != nil {
		t.Fatalf("stored file: %v", err)
	}

	const racers = 6
	codes := make(chan int, racers)
	start := make(chan struct{})
	var wg sync.WaitGroup
	for range racers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			resp, _ := h.completeWithKey(t, id, key)
			codes <- resp.StatusCode
		}()
	}
	close(start)
	wg.Wait()
	close(codes)
	for c := range codes {
		if c != 204 {
			t.Fatalf("a racing completion answered %d; every one of them must be safe", c)
		}
	}
	if _, err := h.store.GetStoredFile(context.Background(), id); !errors.Is(err, ErrNotFound) {
		t.Fatalf("row survived: %v", err)
	}
	// Exactly one durable responsibility for the blob, not six.
	pend := h.pendingDeletes(t)
	if len(pend) != 1 || pend[0].BlobKey != sf.BlobKey {
		t.Fatalf("pending deletes = %+v, want exactly one for %s", pend, sf.BlobKey)
	}
}

// failingDeleteBlobs is a blob store whose Delete always fails — a node that is
// offline, wedged, or lying, at exactly the moment a completion needs it.
type failingDeleteBlobs struct {
	storage.BlobStore
	failed atomic.Int64
}

func (f *failingDeleteBlobs) Delete(ctx context.Context, key string) error {
	f.failed.Add(1)
	return errors.New("node unreachable")
}

// The physical delete is best-effort; the RESPONSIBILITY is not. A node that
// cannot be reached must not turn a completion into a lost blob — the intent was
// committed before the node was ever asked, so GC still owns it and still
// retries.
func TestCompletionSurvivesANodeThatCannotDeleteTheBlob(t *testing.T) {
	h := newPairHarness(t)
	h.mintCode("320007", "")
	key := fileKeyN(9)
	id := h.preUploadCompletable(t, "320007", bytes.Repeat([]byte("F"), 2048), key)
	sf, err := h.store.GetStoredFile(context.Background(), id)
	if err != nil {
		t.Fatalf("stored file: %v", err)
	}

	broken := &failingDeleteBlobs{BlobStore: h.disk}
	h.svc.SetBlobStore(broken)

	resp, body := h.completeWithKey(t, id, key)
	if resp.StatusCode != 204 {
		t.Fatalf("complete against a broken node: %d %s", resp.StatusCode, body)
	}
	if broken.failed.Load() == 0 {
		t.Fatal("the completion never even attempted the physical delete")
	}
	// The authoritative half still happened...
	if _, err := h.store.GetStoredFile(context.Background(), id); !errors.Is(err, ErrNotFound) {
		t.Fatalf("row survived: %v", err)
	}
	// ...and the blob has a durable owner that outlives this request.
	pend := h.pendingDeletes(t)
	if len(pend) != 1 || pend[0].BlobKey != sf.BlobKey || pend[0].DeletedAt != 0 {
		t.Fatalf("pending deletes = %+v, want one undischarged row for %s", pend, sf.BlobKey)
	}
	// The bytes really are still there, so the intent is not a formality: it is
	// the only thing that will ever remove them.
	h.svc.SetBlobStore(h.disk)
	if !h.blobExists(t, sf.BlobKey) {
		t.Fatal("the blob vanished even though the node refused to delete it")
	}
}

// join makes the server observe a second participant in this code's room, the
// same way the signaling layer does. Never a client claim — see
// Service.MarkPairRoomJoined.
func (h *pairHarness) join(t *testing.T, code string) {
	t.Helper()
	if err := h.svc.MarkPairRoomJoined(context.Background(), code); err != nil {
		t.Fatalf("mark joined: %v", err)
	}
}

// The last object of a JOINED room takes the room with it, in the same
// transaction. That is what closes the loop invariant 5 opened: a joined room's
// ciphertext has no clock, so the only thing that can ever end the room is the
// receiver saying it has everything.
func TestCompletingTheLastObjectClosesAJoinedRoom(t *testing.T) {
	h := newPairHarness(t)
	h.mintCode("330000", "")
	keyA, keyB := fileKeyN(10), fileKeyN(11)
	idA := h.preUploadCompletable(t, "330000", bytes.Repeat([]byte("A"), 1024), keyA)
	idB := h.preUploadCompletable(t, "330000", bytes.Repeat([]byte("B"), 1024), keyB)
	h.join(t, "330000")
	room := h.roomOf(t, idA)
	if room.JoinedAt == 0 {
		t.Fatal("the room was not joined")
	}

	// The first completion is not the last object, so the room stays open — the
	// other file is still there to be fetched.
	if resp, _ := h.completeWithKey(t, idA, keyA); resp.StatusCode != 204 {
		t.Fatalf("first completion: %d", resp.StatusCode)
	}
	if r, _, _ := h.store.GetPairRoom(context.Background(), room.ID); r.ClosedAt != 0 {
		t.Fatal("the room closed while it still held an object")
	}
	if s, _ := h.getAnon(t, "/api/files/"+idB+"/blob"); s != 200 {
		t.Fatalf("the sibling stopped being readable: %d", s)
	}

	// The last one does close it.
	if resp, _ := h.completeWithKey(t, idB, keyB); resp.StatusCode != 204 {
		t.Fatalf("last completion: %d", resp.StatusCode)
	}
	r, found, err := h.store.GetPairRoom(context.Background(), room.ID)
	if err != nil || !found {
		t.Fatalf("room: %v found=%v", err, found)
	}
	if r.ClosedAt == 0 {
		t.Fatal("the last completion left the joined room open forever")
	}
	// And the code it named is out of circulation rather than left to lapse.
	if h.codes.valid("330000") {
		t.Fatal("the completed room's code is still live")
	}
}

// An UNJOINED room is never closed by a completion, however empty it becomes.
//
// Nobody has arrived yet, so more pre-uploads may still be on their way into it;
// closing would refuse them and strand a sender mid-batch. The room's own
// deadline is what ends an unjoined room, and that rule is untouched.
func TestCompletingTheLastObjectDoesNotCloseAnUnjoinedRoom(t *testing.T) {
	h := newPairHarness(t)
	h.mintCode("330001", "")
	key := fileKeyN(12)
	id := h.preUploadCompletable(t, "330001", bytes.Repeat([]byte("U"), 1024), key)
	room := h.roomOf(t, id)

	if resp, _ := h.completeWithKey(t, id, key); resp.StatusCode != 204 {
		t.Fatalf("completion: %d", resp.StatusCode)
	}
	r, found, err := h.store.GetPairRoom(context.Background(), room.ID)
	if err != nil || !found {
		t.Fatalf("room: %v found=%v", err, found)
	}
	if r.ClosedAt != 0 {
		t.Fatal("an unjoined room was closed by a completion")
	}
	// And it is still usable: the sender can put the next file of the batch in.
	if next := h.preUploadCompletable(t, "330001", bytes.Repeat([]byte("V"), 512), fileKeyN(13)); next == "" {
		t.Fatal("the room stopped accepting uploads")
	}
}

// A room with an upload still IN FLIGHT is not empty, whatever its finalized
// objects say. Closing it would refuse the finalize that upload is entitled to
// (§3: an upload already in flight when the peer joins is allowed to finish) and
// throw away bytes the sender has already been billed for.
func TestCompletingTheLastObjectDoesNotCloseARoomWithAnUploadStillRunning(t *testing.T) {
	h := newPairHarness(t)
	h.mintCode("330002", "")
	key := fileKeyN(14)
	id := h.preUploadCompletable(t, "330002", bytes.Repeat([]byte("A"), 1024), key)

	// A second file, mid-upload when the peer arrives. Started BEFORE the join
	// because that is the only way this state is reachable: a new init is refused
	// with 409 once somebody has joined, and an upload already in flight is the
	// one the protocol lets finish anyway (§3).
	inflight := bytes.Repeat([]byte("B"), 2048)
	status, uploadID, _ := h.initPairUpload(t, "330002", len(inflight), "")
	if status != 200 {
		t.Fatalf("second init: %d", status)
	}
	if got := h.patch(t, uploadID, inflight, 0, 1024, len(inflight)); got != 200 {
		t.Fatalf("partial patch: %d", got)
	}
	h.join(t, "330002")
	room := h.roomOf(t, id)

	if resp, _ := h.completeWithKey(t, id, key); resp.StatusCode != 204 {
		t.Fatalf("completion: %d", resp.StatusCode)
	}
	r, _, _ := h.store.GetPairRoom(context.Background(), room.ID)
	if r.ClosedAt != 0 {
		t.Fatal("a room with a live upload session was closed")
	}
	// The in-flight upload finishes normally, which is the point.
	if got := h.patch(t, uploadID, inflight, 1024, len(inflight), len(inflight)); got != 200 {
		t.Fatalf("rest of the patch: %d", got)
	}
	if s, id2 := h.finalizeWith(t, uploadID, ""); s != 200 || id2 == "" {
		t.Fatalf("finalize of the in-flight upload: %d", s)
	}
}

// READING NEVER COMPLETES. Every download shape a receiver actually performs —
// the whole blob, a resumed Range, and an overlapping retry of the same Range —
// must leave the object exactly where it was. Completion is a thing a receiver
// SAYS, never a thing the server infers from bytes leaving the building: a
// resume that looked like a finish would delete ciphertext mid-transfer.
func TestDownloadsNeverCompleteOrDeleteAPairRoomObject(t *testing.T) {
	h := newPairHarness(t)
	h.mintCode("330003", "")
	key := fileKeyN(15)
	blob := bytes.Repeat([]byte("Z"), 8192)
	id := h.preUploadCompletable(t, "330003", blob, key)
	h.join(t, "330003")
	sf, err := h.store.GetStoredFile(context.Background(), id)
	if err != nil {
		t.Fatalf("stored file: %v", err)
	}

	rangeGet := func(spec string) (int, []byte) {
		t.Helper()
		req, _ := http.NewRequest("GET", h.ts.URL+"/api/files/"+id+"/blob", nil)
		if spec != "" {
			req.Header.Set("Range", spec)
		}
		resp, err := h.ts.Client().Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		got, _ := io.ReadAll(resp.Body)
		return resp.StatusCode, got
	}

	// A whole download, twice — the second is the "did the first one burn it"
	// question stated directly.
	for i := range 2 {
		if s, got := rangeGet(""); s != 200 || !bytes.Equal(got, blob) {
			t.Fatalf("full download %d: %d, %d bytes", i, s, len(got))
		}
	}
	// A resume, and then an OVERLAPPING retry of it: a client whose connection
	// dropped re-requests from before where it thinks it got to.
	if s, got := rangeGet("bytes=4096-"); s != 206 || !bytes.Equal(got, blob[4096:]) {
		t.Fatalf("resume: %d, %d bytes", s, len(got))
	}
	if s, got := rangeGet("bytes=2048-"); s != 206 || !bytes.Equal(got, blob[2048:]) {
		t.Fatalf("overlapping retry: %d, %d bytes", s, len(got))
	}
	if s, got := rangeGet("bytes=4096-"); s != 206 || !bytes.Equal(got, blob[4096:]) {
		t.Fatalf("second resume: %d, %d bytes", s, len(got))
	}

	// Nothing moved: the row, the blob, the room and the queue are as they were.
	if _, err := h.store.GetStoredFile(context.Background(), id); err != nil {
		t.Fatalf("a download removed the row: %v", err)
	}
	if !h.blobExists(t, sf.BlobKey) {
		t.Fatal("a download deleted the ciphertext")
	}
	if len(h.pendingDeletes(t)) != 0 {
		t.Fatal("a download queued a blob deletion")
	}
	if r, _, _ := h.store.GetPairRoom(context.Background(), sf.PairRoomID); r.ClosedAt != 0 {
		t.Fatal("a download closed the room")
	}
	// And /meta likewise, which is the other public read.
	if s, _ := h.getAnon(t, "/api/files/"+id+"/meta"); s != 200 {
		t.Fatalf("/meta: %d", s)
	}
	if _, err := h.store.GetStoredFile(context.Background(), id); err != nil {
		t.Fatalf("/meta removed the row: %v", err)
	}
	// Only the receiver's own word does it.
	if resp, _ := h.completeWithKey(t, id, key); resp.StatusCode != 204 {
		t.Fatalf("completion after all that reading: %d", resp.StatusCode)
	}
}

// A refused completion must not disturb a download in progress either: a
// receiver that gets a 403 or a 409 is expected to keep retrying its fetch, and
// the object has to still be there to fetch.
func TestARefusedCompletionLeavesResumeIntact(t *testing.T) {
	h := newPairHarness(t)
	h.mintCode("330004", "")
	key := fileKeyN(16)
	blob := bytes.Repeat([]byte("Q"), 4096)
	id := h.preUploadCompletable(t, "330004", blob, key)

	if resp, _ := h.completeWithKey(t, id, fileKeyN(200)); resp.StatusCode != 403 {
		t.Fatalf("wrong proof: %d", resp.StatusCode)
	}
	req, _ := http.NewRequest("GET", h.ts.URL+"/api/files/"+id+"/blob", nil)
	req.Header.Set("Range", "bytes=1024-")
	resp, err := h.ts.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	got, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != 206 || !bytes.Equal(got, blob[1024:]) {
		t.Fatalf("resume after a refused completion: %d, %d bytes", resp.StatusCode, len(got))
	}
}

// The completion endpoint shares the download-start limiter, because it is the
// other unauthenticated per-object endpoint and an unlimited one would be a free
// way to grind proofs — or simply to spend the server's request budget.
func TestCompletionIsRateLimited(t *testing.T) {
	h := newPairHarness(t)
	h.mintCode("330005", "")
	key := fileKeyN(17)
	id := h.preUploadCompletable(t, "330005", bytes.Repeat([]byte("L"), 1024), key)
	h.svc.SetDownloadLimiter(&countingLimiter{allow: false})

	resp, _ := h.completeWithKey(t, id, key)
	if resp.StatusCode != 429 {
		t.Fatalf("completion under a closed limiter: %d, want 429", resp.StatusCode)
	}
	// Refused before anything was decided about the object.
	if _, err := h.store.GetStoredFile(context.Background(), id); err != nil {
		t.Fatalf("a rate-limited completion still removed the row: %v", err)
	}
}

// countingLimiter answers every Allow with a fixed verdict.
type countingLimiter struct{ allow bool }

func (c *countingLimiter) Allow(string) bool { return c.allow }

// A JOINED room that ends up holding nothing — no objects, no upload sessions —
// must not stay open forever.
//
// This is the timing the completion path itself creates and cannot close from
// inside its own transaction: the last object is completed while an upload is
// still in flight (so the room is correctly left open), and that upload is then
// abandoned and reaped rather than finalized. Nothing else can ever close the
// room — a joined room's deadline is "never", so the deadline sweep does not see
// it — and the row would be immortal. GC's pass is what collects it.
func TestSweepClosesAJoinedRoomThatHasNothingLeftInIt(t *testing.T) {
	h := newPairHarness(t)
	h.mintCode("330006", "")
	key := fileKeyN(18)
	id := h.preUploadCompletable(t, "330006", bytes.Repeat([]byte("E"), 1024), key)

	// An upload in flight when the peer arrives, so the completion below correctly
	// leaves the room open. Started before the join, which is the only way to
	// reach this state — a new init after a join is 409.
	inflight := bytes.Repeat([]byte("I"), 2048)
	status, uploadID, _ := h.initPairUpload(t, "330006", len(inflight), "")
	if status != 200 {
		t.Fatalf("init: %d", status)
	}
	if got := h.patch(t, uploadID, inflight, 0, 1024, len(inflight)); got != 200 {
		t.Fatalf("patch: %d", got)
	}
	h.join(t, "330006")
	room := h.roomOf(t, id)
	if resp, _ := h.completeWithKey(t, id, key); resp.StatusCode != 204 {
		t.Fatalf("completion: %d", resp.StatusCode)
	}
	if r, _, _ := h.store.GetPairRoom(context.Background(), room.ID); r.ClosedAt != 0 {
		t.Fatal("the room closed while an upload was still running")
	}

	// The sender goes away. The generic reaper collects the abandoned session, so
	// the room now holds nothing at all — and no deadline will ever fire on it.
	if err := h.store.DeleteUploadSession(context.Background(), uploadID); err != nil {
		t.Fatalf("delete session: %v", err)
	}
	h.advance(pairRoomJoinWindow + 1)
	h.svc.SweepPairRooms(context.Background(), h.now)

	r, found, err := h.store.GetPairRoom(context.Background(), room.ID)
	if err != nil {
		t.Fatalf("room: %v", err)
	}
	if found && r.ClosedAt == 0 {
		t.Fatal("a joined room with nothing in it stayed open forever")
	}
}

// The other side of that sweep: it must never collect a joined room that still
// holds something. An object still waiting to be fetched, or an upload still
// arriving, is exactly what the room is for.
func TestSweepLeavesAJoinedRoomThatStillHoldsSomething(t *testing.T) {
	h := newPairHarness(t)
	h.mintCode("330007", "")
	key := fileKeyN(19)
	blob := bytes.Repeat([]byte("K"), 1024)
	id := h.preUploadCompletable(t, "330007", blob, key)
	h.join(t, "330007")
	room := h.roomOf(t, id)

	h.advance(12 * 3600)
	h.svc.SweepPairRooms(context.Background(), h.now)

	r, found, err := h.store.GetPairRoom(context.Background(), room.ID)
	if err != nil || !found {
		t.Fatalf("room: %v found=%v", err, found)
	}
	if r.ClosedAt != 0 {
		t.Fatal("the sweep closed a joined room that still held an object")
	}
	// The whole point: the ciphertext is still there half a day later, twice over
	// every JOIN ceiling the room has and well inside the account's retention
	// window. What ends a joined room is a completion, a release, or that window
	// running out — never this sweep while the room still holds something.
	if s, got := h.getAnon(t, "/api/files/"+id+"/blob"); s != 200 || !bytes.Equal(got, blob) {
		t.Fatalf("the object stopped being readable: %d, %d bytes", s, len(got))
	}
	if resp, _ := h.completeWithKey(t, id, key); resp.StatusCode != 204 {
		t.Fatalf("completion a day later: %d", resp.StatusCode)
	}
}

// Closing the room is only half of a void: A ROOM THAT IS VOID TAKES ITS CODE
// WITH IT (invariant 6). This sweep is the one path that ends a room without a
// request behind it, and a close that left the code validating would leave six
// digits naming a rendezvous whose room is over — and hold them out of a 10^6
// space until the registry's own reap.
//
// The room here is deliberately OLD BY created_at WITH A LIVE CODE, which is the
// case the age grace cannot rule out: the grace is measured from creation, while
// the code follows the last accepted byte. A room whose upload trickled across
// the grace window is past `before` and still has minutes of credential left.
func TestSweepingAnEmptyJoinedRoomTakesItsCodeWithIt(t *testing.T) {
	h := newPairHarness(t)
	h.mintCode("330008", "")
	key := fileKeyN(20)
	id := h.preUploadCompletable(t, "330008", bytes.Repeat([]byte("E"), 1024), key)

	// A second upload, started before the join (the only way to reach a joined room
	// that a completion leaves open) and trickled in chunks that each push the
	// room's deadline — and its code — further out than the sweep's grace.
	inflight := bytes.Repeat([]byte("I"), 4096)
	status, uploadID, _ := h.initPairUpload(t, "330008", len(inflight), "")
	if status != 200 {
		t.Fatalf("init: %d", status)
	}
	for _, at := range []int{0, 1024, 2048} {
		if at > 0 {
			h.advance(pairRoomJoinWindow - 60) // short of the deadline, so the room lives
		}
		if got := h.patch(t, uploadID, inflight, at, at+1024, len(inflight)); got != 200 {
			t.Fatalf("patch at %d: %d", at, got)
		}
	}
	h.join(t, "330008")
	room := h.roomOf(t, id)
	if resp, _ := h.completeWithKey(t, id, key); resp.StatusCode != 204 {
		t.Fatalf("completion: %d", resp.StatusCode)
	}
	// The sender goes away and the generic reaper takes the abandoned session, so
	// the room holds nothing at all.
	if err := h.store.DeleteUploadSession(context.Background(), uploadID); err != nil {
		t.Fatalf("delete session: %v", err)
	}

	// Both halves of the premise, asserted rather than assumed: the sweep can see
	// this room, and its code has NOT expired on its own — so a code that is gone
	// afterwards was taken by the sweep and by nothing else.
	if room.CreatedAt > h.now-pairRoomEmptyGrace {
		t.Fatalf("room created at %d is younger than the sweep's grace at %d; the test proves nothing",
			room.CreatedAt, h.now-pairRoomEmptyGrace)
	}
	if !h.codes.valid("330008") {
		t.Fatal("the code expired by itself before the sweep ran; the test proves nothing")
	}

	h.svc.SweepPairRooms(context.Background(), h.now)

	if r, found, _ := h.store.GetPairRoom(context.Background(), room.ID); found && r.ClosedAt == 0 {
		t.Fatal("a joined room with nothing in it stayed open forever")
	}
	if h.codes.valid("330008") {
		t.Fatal("the sweep closed the room and left its code live: a rendezvous nobody can be given, still admitting a receiver")
	}
}

// The other side of that revoke, and the reason it is bounded by the room's own
// identity rather than by its digits: six digits are recycled minutes after they
// expire, so by the time a sweep collects an old room the same code can already
// name somebody else's transfer. Taking it would end a live pairing that has
// nothing to do with this room.
//
// The guard is RevokeFor's — owner AND an entry no later than this room's own
// join deadline — which is why the store has to hand back the row it closed
// rather than a count: the deadline is derived from that row.
func TestSweepingAnEmptyJoinedRoomLeavesAReissuedCodeAlone(t *testing.T) {
	h := newPairHarness(t)
	h.mintCode("330009", "")
	key := fileKeyN(21)
	id := h.preUploadCompletable(t, "330009", bytes.Repeat([]byte("R"), 1024), key)

	inflight := bytes.Repeat([]byte("I"), 2048)
	status, uploadID, _ := h.initPairUpload(t, "330009", len(inflight), "")
	if status != 200 {
		t.Fatalf("init: %d", status)
	}
	if got := h.patch(t, uploadID, inflight, 0, 1024, len(inflight)); got != 200 {
		t.Fatalf("patch: %d", got)
	}
	h.join(t, "330009")
	room := h.roomOf(t, id)
	if resp, _ := h.completeWithKey(t, id, key); resp.StatusCode != 204 {
		t.Fatalf("completion: %d", resp.StatusCode)
	}
	if err := h.store.DeleteUploadSession(context.Background(), uploadID); err != nil {
		t.Fatalf("delete session: %v", err)
	}

	// Long enough that the old room's code has expired and the digits are back in
	// circulation, then handed out again — to the SAME account, which is the hard
	// case: owner-matching alone would happily take them.
	h.advance(pairRoomJoinWindow + 1)
	h.mintCode("330009", "")
	if want := pairRoomJoinDeadline(room); h.codes.codes["330009"].exp <= want {
		t.Fatalf("the reissued code expires at %d, not past the old room's deadline (%d); the test is not exercising a reissue",
			h.codes.codes["330009"].exp, want)
	}

	h.svc.SweepPairRooms(context.Background(), h.now)

	if r, found, _ := h.store.GetPairRoom(context.Background(), room.ID); found && r.ClosedAt == 0 {
		t.Fatal("the sweep skipped an empty joined room because its digits had been reissued")
	}
	if !h.codes.valid("330009") {
		t.Fatal("the sweep of an old room revoked a code that had since been minted again: a live pairing killed by somebody else's GC")
	}
}

// The store's own contract for that sweep: it reports THE ROOMS IT CHANGED, each
// exactly once, with the identity a revoke needs.
//
// "Exactly once" is the property the count could not express and the one a
// revoke depends on. Two sweeps overlapping — or a sweep overlapping any other
// path that closes a room — must not both report the same room, because the
// second report is a revoke against a room somebody else already ended, and by
// then the digits may belong to a different transfer.
func TestConcurrentEmptyRoomSweepsClaimEachRoomOnce(t *testing.T) {
	ctx := context.Background()
	st := newTestStore(t)
	owner := testUser(t, st)
	const rooms = 12
	for i := range rooms {
		r := PairRoom{
			ID:     fmt.Sprintf("r-empty-%02d", i),
			Code:   fmt.Sprintf("34%04d", i),
			UserID: owner, CreatedAt: 1000,
		}
		r.ExpiresAt = pairRoomExpiry(r)
		if _, created, err := st.CreatePairRoomIfAbsent(ctx, r); err != nil || !created {
			t.Fatalf("open %s: %v created=%v", r.ID, err, created)
		}
		joined := r
		joined.JoinedAt = 1050
		if err := st.JoinPairRoom(ctx, r.ID, joined.JoinedAt, pairRoomExpiry(joined)); err != nil {
			t.Fatalf("join %s: %v", r.ID, err)
		}
	}

	const sweepers = 4
	got := make([][]PairRoom, sweepers)
	var wg sync.WaitGroup
	for i := range sweepers {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			closed, err := st.CloseEmptyJoinedPairRooms(ctx, 2000, 3000, pairRoomSweepBatch)
			if err != nil {
				t.Errorf("sweep %d: %v", i, err)
				return
			}
			got[i] = closed
		}(i)
	}
	wg.Wait()

	seen := map[string]int{}
	for _, batch := range got {
		for _, r := range batch {
			seen[r.ID]++
			// The identity the revoke is defined over has to survive the round trip:
			// without the owner and the timestamps behind pairRoomJoinDeadline, the
			// caller cannot make RevokeFor's guarded call at all.
			if r.UserID != owner || r.Code == "" || r.CreatedAt != 1000 {
				t.Fatalf("%s came back as %+v, not the row that was closed", r.ID, r)
			}
			if r.ClosedAt != 3000 {
				t.Fatalf("%s came back with closed_at %d, want the sweep's own stamp", r.ID, r.ClosedAt)
			}
		}
	}
	if len(seen) != rooms {
		t.Fatalf("%d distinct rooms reported closed, want %d", len(seen), rooms)
	}
	for id, n := range seen {
		if n != 1 {
			t.Fatalf("room %s was reported by %d sweeps; its code would be revoked once per report, and the later ones against a room somebody else closed", id, n)
		}
	}
	for i := range rooms {
		id := fmt.Sprintf("r-empty-%02d", i)
		r, found, err := st.GetPairRoom(ctx, id)
		if err != nil || !found || r.ClosedAt != 3000 {
			t.Fatalf("%s: found=%v closed_at=%d err=%v", id, found, r.ClosedAt, err)
		}
	}

	// Idempotent: there is nothing left to close, so a later sweep reports nothing
	// and revokes nothing.
	again, err := st.CloseEmptyJoinedPairRooms(ctx, 2000, 4000, pairRoomSweepBatch)
	if err != nil {
		t.Fatalf("second sweep: %v", err)
	}
	if len(again) != 0 {
		t.Fatalf("a second sweep reported %d already-closed room(s) as newly closed", len(again))
	}
}

// The purpose gate is part of the SELECT that finds the row, so no completion —
// however well-formed, and whatever verifier a row happens to carry — can reach
// an object of another kind. Asserted at the STORE rather than over HTTP because
// this is the level the guarantee lives at: a share and a Device Inbox object are
// answered "there is nothing here" and are still there afterwards.
func TestCompletionCannotReachAnyOtherKindOfObject(t *testing.T) {
	ctx := context.Background()
	store := newTestStore(t)
	owner := testUser(t, store)
	verifier := mustHex(t, completionVectorVerifier)

	for _, purpose := range []string{StoredPurposeShare, StoredPurposeDeviceTask} {
		// Deliberately given a verifier that WOULD match, so the refusal can only
		// be the purpose gate and not an incidental mismatch.
		sf := StoredFile{
			ID: "sf-" + purpose, UserID: owner, BlobKey: "bk-" + purpose, Size: 10,
			EncManifest: []byte("OPAQUE"), CreatedAt: 1000, ExpiresAt: 9000,
			Purpose: purpose, CompletionVerifier: verifier,
		}
		if err := store.CreateStoredFile(ctx, sf); err != nil {
			t.Fatalf("insert %s: %v", purpose, err)
		}
		res, err := store.CompletePairRoomObject(ctx, sf.ID, verifier, 2000, 2000+pairRoomBlobHold)
		if err != nil {
			t.Fatalf("complete %s: %v", purpose, err)
		}
		if res.Outcome != PairRoomCompletionGone {
			t.Fatalf("%s outcome = %v, want Gone", purpose, res.Outcome)
		}
		if _, err := store.GetStoredFile(ctx, sf.ID); err != nil {
			t.Fatalf("%s was removed by a completion: %v", purpose, err)
		}
	}
	pend, err := store.ListPendingNodeDeletes(ctx)
	if err != nil {
		t.Fatalf("pending: %v", err)
	}
	if len(pend) != 0 {
		t.Fatalf("a completion queued deletions for other object kinds: %+v", pend)
	}
}

// Finalize is once-only, and the verifier rides it. Racing finalizes of one
// upload must therefore produce exactly ONE object, and that object must carry
// the verifier — never an object with the capability missing, which would be
// ciphertext nothing can ever release.
func TestRacingFinalizesLandOneObjectAndItCarriesTheVerifier(t *testing.T) {
	h := newPairHarness(t)
	h.mintCode("340000", "")
	key := fileKeyN(20)
	proof, err := pairRoomCompletionProof(key)
	if err != nil {
		t.Fatalf("derive: %v", err)
	}
	want := pairRoomCompletionVerifier(proof)
	body := verifierBody(base64.RawURLEncoding.EncodeToString(want))

	blob := bytes.Repeat([]byte("T"), 2048)
	status, uploadID, _ := h.initPairUpload(t, "340000", len(blob), "")
	if status != 200 {
		t.Fatalf("init: %d", status)
	}
	if got := h.patch(t, uploadID, blob, 0, len(blob), len(blob)); got != 200 {
		t.Fatalf("patch: %d", got)
	}

	const racers = 5
	type result struct {
		status int
		id     string
	}
	out := make(chan result, racers)
	start := make(chan struct{})
	var wg sync.WaitGroup
	for range racers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			s, id := h.finalizeWith(t, uploadID, body)
			out <- result{s, id}
		}()
	}
	close(start)
	wg.Wait()
	close(out)

	var ids []string
	for r := range out {
		switch r.status {
		case 200:
			ids = append(ids, r.id)
		case 409: // "already finalized" — the losers of the terminal claim
		default:
			t.Fatalf("racing finalize answered %d", r.status)
		}
	}
	if len(ids) != 1 {
		t.Fatalf("racing finalizes produced %d objects, want exactly 1", len(ids))
	}
	if got := h.storedVerifier(t, ids[0]); !bytes.Equal(got, want) {
		t.Fatalf("the surviving object's verifier = %x, want %x", got, want)
	}
	// And it is genuinely usable: the capability that landed is the one the
	// receiver's key derives.
	if resp, _ := h.completeWithKey(t, ids[0], key); resp.StatusCode != 204 {
		t.Fatalf("completing the object that survived the race: %d", resp.StatusCode)
	}
}

package account

import (
	"context"
	"crypto/hkdf"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
)

// The pair-room COMPLETION capability: how a receiver proves it got the file,
// without the server ever learning the key that would open it.
//
// THE PROBLEM IT EXISTS FOR. Invariant 5 in pairroom.go is literal — once a peer
// joins, nothing about the transfer is on a clock — so a joined room's ciphertext
// has no deadline that removes it. That is an unbounded storage commitment, and
// it is the whole reason pre-upload is off unless a deployment opts in. The
// missing piece was never a timer (a timer is the rule reinterpreted); it is a
// receiver saying "I have it, you can let go".
//
// WHY A DERIVED PROOF RATHER THAN THE OBJECT ID. The id is not a secret worth
// anything on its own — it travels in the same sealed frame as the key, but it is
// also the URL path segment of every /meta and /blob request, so anything that
// ever sees a request line sees it. A completion authorized by the id alone would
// let a passive observer of one download delete somebody else's transfer. The
// file KEY is the one thing that never leaves the peers' end-to-end channel, so
// the capability to end an object's life is derived from it.
//
// WHY TWO VALUES RATHER THAN THE KEY ITSELF. The server must be able to CHECK a
// completion without being able to PERFORM one, and without holding anything that
// helps it decrypt. So the chain is one-way twice over:
//
//	proof    = HKDF-SHA256(ikm = fileKey, salt = empty, info = <domain>, 32 bytes)
//	verifier = SHA-256(proof)
//
// The sender hands the server the VERIFIER at finalize. The receiver, which has
// the key, derives the PROOF and sends that. The server hashes what it was sent
// and compares. Knowing the verifier — which is all the server, its database and
// its backups ever hold — does not yield the proof, so a stolen database cannot
// complete anybody's transfer; and neither value yields the file key, so the
// zero-knowledge property is exactly what it was.
//
// The HKDF step is what keeps the proof from being a bare hash of the file key.
// A bare hash is replayable into any other context that ever hashes the same key,
// and the info string is the promise that this one is not: it is a domain
// separator, it is checked byte for byte by a frozen vector on both sides, and
// changing it is a wire break.
//
// NEITHER VALUE MAY APPEAR IN A URL OR A LOG. The proof is a bearer capability to
// delete an object, so it travels in a request BODY (never a path or query, which
// proxies and access logs record) and nothing here ever prints one. The verifier
// is less dangerous but is still a per-object secret, and is treated the same.

// pairRoomCompletionInfo is the HKDF info string — the domain separator that
// makes a completion proof mean "completion of a pre-upload" and nothing else.
//
// Exact ASCII, no trailing NUL. It is part of the wire: the Web receiver, this
// server and every future port must agree on it byte for byte or every
// completion 403s. Frozen by TestCompletionInfoStringIsExactlyTheProtocolConstant
// and by the vector its Web twin shares.
const pairRoomCompletionInfo = "relayium-preupload-complete-v1"

// pairRoomCompletionBytes is the length of a proof and of a verifier alike. Both
// are 32 bytes, and both are checked for it strictly — a shorter value is not a
// weaker credential, it is a malformed one.
const pairRoomCompletionBytes = 32

// pairRoomCompletionProof derives the proof a receiver holding `fileKey` sends to
// complete that file's object.
//
// The SERVER never calls this in production and cannot: it has no file key, which
// is the point of the whole design. It lives here anyway, next to the check it is
// the other half of, because this is the normative definition of the contract —
// the thing the Web receiver, the Swift port and the CLI each implement — and a
// contract with no executable statement on the server side is a contract that
// drifts. The frozen vector is what makes it load-bearing rather than decorative.
//
// Empty salt, deliberately and by the protocol: HKDF's salt is optional, RFC 5869
// specifies the extract step over a zero-filled salt when none is given, and
// WebCrypto's HKDF with a zero-length salt produces the identical PRK (HMAC pads
// any key shorter than its block size with zeros). There is nothing for a salt to
// buy here — the IKM is already 32 uniformly random bytes.
func pairRoomCompletionProof(fileKey []byte) ([]byte, error) {
	return hkdf.Key(sha256.New, fileKey, nil, pairRoomCompletionInfo, pairRoomCompletionBytes)
}

// pairRoomCompletionVerifier is what the server stores and compares against: the
// SHA-256 of the proof.
//
// This is the direction that matters for the server. A completion request carries
// a proof, this turns it into a verifier, and the result is compared against the
// column in constant time. One plain hash is enough — the proof is 32 bytes of
// HKDF output, so there is no low-entropy input for a slow KDF to defend and
// nothing to be gained by pretending this is a password.
func pairRoomCompletionVerifier(proof []byte) []byte {
	sum := sha256.Sum256(proof)
	return sum[:]
}

// maxCompletionBodyBytes bounds both bodies this feature reads. Each carries one
// 43-character token inside a small JSON object, so anything past a kilobyte is
// not a client that has misunderstood the shape — it is a body being used to
// spend memory on an endpoint one of which is unauthenticated.
//
// INCLUSIVE, as "bounds" says: a body of exactly this many bytes is read and
// parsed on its merits; the first byte past it is a refusal. The boundary is
// pinned by TestCompletionBodyLimitIsInclusiveAtItsBoundary — one byte apart,
// same shape, 200 and 400 — because a bound nobody has stated in both directions
// is one that drifts the next time this reader is touched.
const maxCompletionBodyBytes = 1 << 10

// completionBody applies that bound to a request body, so that a body EXCEEDING
// it is refused rather than silently truncated.
//
// TRUNCATION IS NOT A WEAKER BOUND HERE, IT IS A HOLE. The parsers below prove
// there is no trailing content by requiring the decoder to reach EOF — and an
// io.LimitReader MANUFACTURES an EOF at its boundary. Wrapping the body in one
// therefore switches the trailing-content rule off at exactly the point it
// starts to matter: a body whose valid object sits in the first kilobyte and
// whose remainder is whitespace, a second JSON value, or plain garbage reads as
// clean, because the reader lied about where the body ended. That is also why
// the length rule cannot be spelled as a limit at all — the two rules are read
// off the same EOF, so one of them silently forging it defeats the other.
//
// So the reader is allowed to see exactly ONE byte past the limit, and the
// existence of that byte is the refusal: cappedReader trips as soon as more than
// max has been read, and its errTooLarge is not io.EOF, so it can be mistaken
// neither for a clean end nor for an absent body. The io.LimitReader underneath
// is what keeps the read itself bounded — the overflow is noticed only after a
// Read has returned, and how much a Read asks for is the decoder's buffer's
// business rather than ours.
//
// Content-Length is deliberately not consulted: it is a claim by the sender, it
// is absent under chunked transfer encoding, and the thing that must be bounded
// is the bytes actually read.
func completionBody(body io.Reader) io.Reader {
	return &cappedReader{
		r:   io.LimitReader(body, maxCompletionBodyBytes+1),
		max: maxCompletionBodyBytes,
	}
}

// errCompletionFieldMalformed is the single refusal every strict-parse failure
// produces. One error for all of them on purpose: a caller that learns WHICH way
// its token was wrong learns something about what the server holds, and there is
// nothing an honest client could do differently with the distinction.
var errCompletionFieldMalformed = errors.New("account: malformed completion value")

// parseCompletionValue decodes one 32-byte completion token from the wire.
//
// STRICT, in every dimension at once, because each looseness is a way for two
// different strings to name the same credential — or for a truncated one to be
// accepted as a whole one:
//
//   - base64url ONLY. `+` and `/` are not in the alphabet, so a value encoded
//     with standard base64 is refused rather than silently re-read.
//   - NO padding. `=` is not in the alphabet either, so the padded spelling of
//     the same 32 bytes is a different string and is refused.
//   - exactly 32 bytes decoded. 31 and 33 are refused, not truncated or
//     zero-extended: a shorter credential is malformed, never weaker.
//
// Whitespace, newlines and any other stray byte fall out of the alphabet rule.
func parseCompletionValue(s string) ([]byte, error) {
	b, err := base64.RawURLEncoding.DecodeString(s)
	if err != nil || len(b) != pairRoomCompletionBytes {
		return nil, errCompletionFieldMalformed
	}
	return b, nil
}

// finalizeCompletionVerifier reads the OPTIONAL completion verifier out of a
// finalize request.
//
// Three outcomes, and the difference between the first two is the whole
// backward-compatibility story:
//
//   - no body at all, or a JSON object without the field: (nil, nil). This is
//     every client that exists today, and it must keep landing exactly the object
//     it always landed. The column ends up NULL.
//   - the field, well formed: (32 bytes, nil).
//   - anything else: an error the caller turns into 400. Malformed JSON, trailing
//     JSON after the object, a non-string field, a body past
//     maxCompletionBodyBytes, and every strict-encoding failure are one refusal.
//
// UNKNOWN FIELDS ARE ALLOWED THROUGH, deliberately and unlike the encoding rules.
// This body is additive to an endpoint that had none, and the next thing to be
// added to it must not have to break every client that predates it — the same
// reason the response fields this feature's siblings added are optional. What is
// strict is the value, because that is the part a lenient reading could get
// WRONG rather than merely ignore.
func finalizeCompletionVerifier(r *http.Request) ([]byte, error) {
	var body struct {
		// RawMessage rather than *string so an explicit `null` is distinguishable
		// from an absent field: a pointer would be set to nil by both, and `null`
		// is a caller stating something rather than omitting it.
		CompletionVerifier json.RawMessage `json:"completionVerifier"`
	}
	dec := json.NewDecoder(completionBody(r.Body))
	if err := dec.Decode(&body); err != nil {
		// io.EOF and ONLY io.EOF is the absent body. An oversize one arrives here
		// as errTooLarge, which is the refusal it should be: a body of a kilobyte
		// of whitespace is not a client that sent nothing.
		if errors.Is(err, io.EOF) {
			return nil, nil // no body: the pre-completion client, unchanged
		}
		return nil, errCompletionFieldMalformed
	}
	// Nothing may follow the object. A body that parses as a valid request and
	// then carries a second one is not a request this server can answer honestly:
	// it is ambiguous about which value was meant, and ambiguity about a
	// credential is the thing to refuse rather than resolve.
	if _, err := dec.Token(); !errors.Is(err, io.EOF) {
		return nil, errCompletionFieldMalformed
	}
	if body.CompletionVerifier == nil {
		return nil, nil // a body, but no opinion about completion
	}
	var s string
	if err := json.Unmarshal(body.CompletionVerifier, &s); err != nil {
		return nil, errCompletionFieldMalformed
	}
	// `null` lands here as the empty string (encoding/json treats a null as a
	// no-op for a string), and the empty string is not a 32-byte token, so it is
	// refused by the same rule as every other wrong length.
	return parseCompletionValue(s)
}

// completionProofFromRequest reads the REQUIRED proof out of a completion
// request.
//
// Required, unlike the verifier at finalize: a completion with no proof is not a
// client being conservative, it is a request with no capability in it at all.
// There is nothing backward-compatible to preserve here either — this endpoint
// is new, so no client predates its body. An absent body is therefore just one
// more malformed one, and the same bound and strictness apply to what is there.
func completionProofFromRequest(r *http.Request) ([]byte, error) {
	var body struct {
		Proof json.RawMessage `json:"proof"`
	}
	dec := json.NewDecoder(completionBody(r.Body))
	if err := dec.Decode(&body); err != nil {
		return nil, errCompletionFieldMalformed
	}
	if _, err := dec.Token(); !errors.Is(err, io.EOF) {
		return nil, errCompletionFieldMalformed
	}
	if body.Proof == nil {
		return nil, errCompletionFieldMalformed
	}
	var s string
	if err := json.Unmarshal(body.Proof, &s); err != nil {
		return nil, errCompletionFieldMalformed
	}
	return parseCompletionValue(s)
}

// handleFileComplete (POST /api/files/{id}/complete) is the receiver saying it
// has the file, and is what finally gives a joined pair room a way to end.
//
// ANONYMOUS, like the two reads beside it, and for the same reason: the receiver
// of a code-first transfer has no account and never will. The proof IS the
// authorization — a capability derived from the file key, which only the peers
// ever hold — so there is nothing for a session cookie to add.
//
// STATUS CONTRACT, and every line of it is a decision rather than a convention:
//
//	204  the proof was right and the object is gone; and, identically,
//	     there was nothing here to complete — already done, never existed, or
//	     not a pair-room object. One answer, so an unauthenticated caller cannot
//	     use this as an existence probe over the stored-object space.
//	409  a live pair-room object with no completion capability at all. Its own
//	     status because a receiver has to tell "keep trying" from "no proof you
//	     can ever derive will work here".
//	403  the proof is wrong. Nothing was deleted.
//	400  the body or the proof is malformed.
//	429  the shared download-start budget for this IP is spent.
//
// It is a POST rather than a DELETE because it is not the holder of a resource
// removing their own thing: it is one party reporting an outcome, and the server
// deciding what that means for the room. And because a DELETE with a required
// body is a shape half the intermediaries on the internet mishandle.
func (s *Service) handleFileComplete(w http.ResponseWriter, r *http.Request) {
	// Before anything can fail or return: every answer on this route, including
	// the refusals, must be uncacheable. A cached 204 would tell a later reader
	// that an object it has never asked about is gone, and a cached 403 would
	// pin a failure past the retry that would have succeeded.
	w.Header().Set("Cache-Control", "private, no-store")
	// The same per-IP budget the blob route spends, deliberately shared rather
	// than given its own: this is the other unauthenticated per-object endpoint,
	// and an unmetered one is a free way to grind proofs against ids — and to
	// spend the server's request budget while doing it. nil = unlimited
	// (tests / self-host), exactly as on the download path.
	if s.downloadLimiter != nil && !s.downloadLimiter.Allow(s.clientIP(r)) {
		http.Error(w, "too many requests, slow down", http.StatusTooManyRequests)
		return
	}
	proof, err := completionProofFromRequest(r)
	if err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	now := s.now().Unix()
	// The verdict is the STORE's, reached under the writer lock, so two receivers
	// racing on one object cannot both act on it. What is handed down is the
	// hashed proof and never the proof: the store compares verifiers, and the
	// bearer value stops here.
	res, cerr := s.store.CompletePairRoomObject(r.Context(), r.PathValue("id"),
		pairRoomCompletionVerifier(proof), now, now+pairRoomBlobHold)
	if cerr != nil {
		// Fail CLOSED. Answering 204 on a database error would tell a receiver its
		// file had been released when nothing of the sort happened, and a receiver
		// that believes that has no reason to ever ask again.
		log.Printf("pair-room completion: %v", cerr)
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	switch res.Outcome {
	case PairRoomCompletionNoVerifier:
		http.Error(w, "this transfer was not uploaded with a completion capability", http.StatusConflict)
		return
	case PairRoomCompletionMismatch:
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	case PairRoomCompletionDone:
		s.reclaimCompletedObject(r.Context(), res)
	}
	w.WriteHeader(http.StatusNoContent)
}

// reclaimCompletedObject is the physical, best-effort half of a completion: drop
// the blob, and give the code back if the room ended.
//
// Everything authoritative already happened — the row is gone, the storage is
// released, and the blob's delete intent is committed — so nothing here can fail
// in a way that matters. A node that is unreachable costs only the promptness of
// the deletion, not its certainty: GC keeps asking, from the intent row, for the
// whole of its hold.
//
// DETACHED and BOUNDED, like every other reclaim on a request goroutine. Detached
// because a receiver typically hangs up the instant it reads the 204, and its
// cancelled context must not cancel the deletion that status is claiming.
// Bounded because the node holding the blob may be unreachable and an unbounded
// wait here is a way to run out of goroutines.
func (s *Service) reclaimCompletedObject(ctx context.Context, res PairRoomCompletion) {
	rctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), pairRoomReclaimBudget)
	defer cancel()
	s.dropReclaimedBlob(rctx, res.Object.BlobKey, res.Object.NodeID)
	if res.RoomClosed {
		// The room is over, so its digits go back into circulation now rather than
		// at the next reap — the same thing a void does, and bounded by the same
		// owner-and-deadline check, so it can never take away digits that have been
		// minted again since.
		s.revokePairCode(res.Room)
	}
}

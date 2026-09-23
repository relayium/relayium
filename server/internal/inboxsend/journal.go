package inboxsend

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"regexp"
	"strings"

	"github.com/relayium/relayium/internal/inbox"
)

// The local send journal: the durable, NON-SECRET record that lets `inbox
// retry` finish a send whose command was interrupted, without encrypting and
// without uploading (invariant N3) — or, for a `--resumable` send (v2), by
// continuing its upload from the local encrypted copy it names (spool.go).
//
//	<config-dir>/inbox-send/<local-send-id>.json   0600, dir 0700
//
// It never contains the content key (N2). It does contain the wrapped key —
// the content key sealed to the target device, which only that device's
// private key can open and which central stores anyway — and the ids needed to
// complete or report the send. It lives beside the credential, not in the
// receiver's state directory, so `inbox disable` never touches it and a machine
// that never receives never creates receiver state.
//
// A journal is remote-controlled input only in the sense that anything on disk
// is: it is read through a bound, decoded strictly, and every field is
// validated before it is used — above all the server origin, which must equal
// the logged-in credential's server before the bearer is sent anywhere.

// Journal phases, in order.
const (
	PhasePlanned    = "planned"    // wrapped key sealed; no upload started (as far as we know)
	PhaseUploading  = "uploading"  // upload session opened; bytes may be committed
	PhaseFinalizing = "finalizing" // every byte acknowledged; finalize sent or about to be
	PhaseFinalized  = "finalized"  // stored object id known; the task may not exist yet
)

const (
	journalVersion = 1
	// journalVersionSpooled is a record made by `inbox send --resumable`: it
	// names a local encrypted copy (spool.go) and may resume its upload. A
	// binary that predates it refuses the record (unknown fields) and leaves it
	// untouched instead of treating it as an ordinary send.
	journalVersionSpooled = 2
	journalDirName        = "inbox-send"
	maxJournalBytes       = 16 << 10
)

var (
	localSendIDRe    = regexp.MustCompile(`^[0-9a-f]{32}$`)
	idempotencyKeyRe = regexp.MustCompile(`^cli-[0-9a-f]{32}$`)
	journalFileRe    = regexp.MustCompile(`^([0-9a-f]{32})\.json$`)
)

// Journal is one unfinished local send.
type Journal struct {
	V                   int    `json:"v"`
	ID                  string `json:"id"`
	Phase               string `json:"phase"`
	Server              string `json:"server"`
	AccountEmail        string `json:"accountEmail"`
	SourceDeviceID      string `json:"sourceDeviceId"`
	TargetDeviceID      string `json:"targetDeviceId"`
	TargetKeyID         string `json:"targetKeyId"`
	TargetKeyGeneration int64  `json:"targetKeyGeneration"`
	WrappedKey          string `json:"wrappedKey"`
	IdempotencyKey      string `json:"idempotencyKey"`
	TTL                 int64  `json:"ttl"`
	CiphertextBytes     int64  `json:"ciphertextBytes"`
	ManifestSHA256      string `json:"manifestSha256"`
	UploadID            string `json:"uploadId,omitempty"`
	StoredFileID        string `json:"storedFileId,omitempty"`
	ExpiresAt           int64  `json:"expiresAt,omitempty"`
	CreatedAt           int64  `json:"createdAt"`
	// Spooled records only (v2). The local encrypted copy is exactly
	// SpoolBytes long: HeaderBytes of init body (uint32BE(len)||sealed
	// manifest) followed by CiphertextBytes of upload body, with this SHA-256.
	// ChunkSize is the server's append size, known once the upload is open.
	SpoolBytes  int64  `json:"spoolBytes,omitempty"`
	SpoolSHA256 string `json:"spoolSha256,omitempty"`
	HeaderBytes int64  `json:"headerBytes,omitempty"`
	ChunkSize   int64  `json:"chunkSize,omitempty"`
}

// Spooled reports whether the record owns a local encrypted copy.
func (j *Journal) Spooled() bool { return j.V == journalVersionSpooled }

// ValidLocalSendID reports whether id has the only spelling a local send id may
// have. Checked before the id is ever joined into a path.
func ValidLocalSendID(id string) bool { return localSendIDRe.MatchString(id) }

func newRandomHex() (string, error) {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	return hex.EncodeToString(b[:]), nil
}

func (j *Journal) validate() error {
	bad := func(what string) error { return fmt.Errorf("journal field %s is invalid", what) }
	switch {
	case j.V != journalVersion && j.V != journalVersionSpooled:
		return bad("v")
	case !ValidLocalSendID(j.ID):
		return bad("id")
	case j.Phase != PhasePlanned && j.Phase != PhaseUploading && j.Phase != PhaseFinalizing && j.Phase != PhaseFinalized:
		return bad("phase")
	case !isInertID(j.SourceDeviceID):
		return bad("sourceDeviceId")
	case !isInertID(j.TargetDeviceID):
		return bad("targetDeviceId")
	case !isInertID(j.TargetKeyID) || j.TargetKeyGeneration <= 0:
		return bad("target key")
	case !validWrappedKey(j.WrappedKey):
		return bad("wrappedKey")
	case !idempotencyKeyRe.MatchString(j.IdempotencyKey):
		return bad("idempotencyKey")
	case j.TTL < 0 || j.CiphertextBytes < 0 || j.CreatedAt <= 0 || j.ExpiresAt < 0:
		return bad("numbers")
	case len(j.ManifestSHA256) != 64 || strings.Trim(j.ManifestSHA256, "0123456789abcdef") != "":
		return bad("manifestSha256")
	case len(j.AccountEmail) > 320:
		return bad("accountEmail")
	}
	if s, err := ValidateServer(j.Server); err != nil || s != j.Server {
		return bad("server")
	}
	needUpload := j.Phase != PhasePlanned
	if needUpload != (j.UploadID != "") || (j.UploadID != "" && !isInertID(j.UploadID)) {
		return bad("uploadId")
	}
	needObject := j.Phase == PhaseFinalized
	if needObject != (j.StoredFileID != "") || (j.StoredFileID != "" && !isInertID(j.StoredFileID)) {
		return bad("storedFileId")
	}
	if !j.Spooled() {
		if j.SpoolBytes != 0 || j.SpoolSHA256 != "" || j.HeaderBytes != 0 || j.ChunkSize != 0 {
			return bad("spool")
		}
		return nil
	}
	switch {
	case j.HeaderBytes <= 4 || j.HeaderBytes > maxSpoolHeader || j.CiphertextBytes <= 0 ||
		j.SpoolBytes != j.HeaderBytes+j.CiphertextBytes:
		return bad("spool size")
	case len(j.SpoolSHA256) != 64 || strings.Trim(j.SpoolSHA256, "0123456789abcdef") != "":
		return bad("spoolSha256")
	case needUpload != (j.ChunkSize != 0) || j.ChunkSize < 0 || j.ChunkSize > maxChunkSize:
		return bad("chunkSize")
	}
	return nil
}

func validWrappedKey(s string) bool {
	if len(s) > inbox.MaxWrappedKeyLen {
		return false
	}
	raw, err := base64.RawURLEncoding.Strict().DecodeString(s)
	return err == nil && len(raw) == inbox.SealedBoxBytes
}

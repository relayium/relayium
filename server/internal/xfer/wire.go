package xfer

import (
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
)

// WireVersion is the protocol version carried in Hello; bump on breaking changes.
const WireVersion = 1

// MsgType tags a control frame. File bytes are streamed raw after MsgFileStart.
type MsgType uint8

const (
	MsgHello     MsgType = 1
	MsgManifest  MsgType = 2
	MsgResume    MsgType = 3
	MsgFileStart MsgType = 4
	MsgFileHash  MsgType = 5
	MsgResult    MsgType = 6
	MsgError     MsgType = 7
	// MsgResumeVerdict is the receiver's answer to the prefix proof carried in
	// MsgFileStart. It is exchanged ONLY when both ends announced support
	// (Hello.ResumeProof and ResumeState.ResumeProof), so a peer that predates
	// it never sends one and is never waited for. See ResumeVerdict.
	MsgResumeVerdict MsgType = 8
)

const maxFramePayload = 8 << 20 // 8 MiB guard for control frames

type Hello struct {
	Version int
	Mode    string // "push" or "pull"
	// Sync REQUESTS sync mode: skip unchanged files, resume into an existing
	// file, replace what is already there, preserve the source mtime. It is a
	// request only — whether any of it happens is the receiving side's decision
	// (RecvOpts.AllowSync), never this flag's.
	Sync   bool
	Delete bool // mirror: receiver may delete files not in the manifest (if permitted)
	// ResumeProof announces that this sender will prove, in MsgFileStart, that
	// its own first Offset bytes hash to what the receiver has on disk, and will
	// restart the file from 0 if the receiver's MsgResumeVerdict says they do
	// not. A receiver only hands out a resume offset to a sender that can do
	// both; absent (an older sender) it gets the whole file instead.
	ResumeProof bool
}

type FileEntry struct {
	Path    string // relative, forward-slash separated
	Size    int64
	Mode    uint32
	ModTime int64 // unix seconds
}

type Manifest struct{ Files []FileEntry }

type ResumeEntry struct {
	Index int
	Have  int64 // bytes already on the receiver's disk for this file
}

type ResumeState struct {
	Entries []ResumeEntry
	Skip    []int // sync mode: manifest indices already present & identical (not sent)
	// ResumeProof echoes Hello.ResumeProof: this receiver will verify the
	// sender's prefix proof and answer every non-zero offset with a
	// MsgResumeVerdict. A sender waits for that verdict only when this is set,
	// so an older receiver (which never sends one) cannot deadlock a new sender.
	ResumeProof bool
}

type FileStart struct {
	Index  int
	Offset int64
	// PrefixSHA256 is the hex SHA-256 of the sender's own [0,Offset) bytes: the
	// proof that the receiver's shorter copy really is a prefix of this file.
	// Set only when both ends announced ResumeProof and Offset > 0; an older
	// receiver ignores the field, which leaves its behaviour exactly as it was.
	PrefixSHA256 string
}

// ResumeVerdict is the receiver's answer to a prefix proof: Resume=false means
// "those are not my bytes, send the file from 0", and the sender does exactly
// that. It is the receiver, not the sender, that may redefine a negotiated
// offset — an older receiver rejects any unannounced offset change, so a sender
// must never make that decision on its own.
type ResumeVerdict struct {
	Index  int
	Resume bool
}

type FileHash struct {
	Index  int
	SHA256 string
}

type Result struct {
	OK           bool
	Failed       []string
	DeleteDenied bool // sync mode: Hello.Delete was set but the receiver isn't --allow-delete
}

// Stable MsgError codes. New codes may be added; existing ones never change
// meaning, so a sender can branch on them without pinning a wire version.
const (
	ErrCodeManifestTooLarge  = "manifest_too_large"
	ErrCodeDestinationExists = "destination_exists"
	ErrCodeSyncNotAllowed    = "sync_not_allowed"
)

// WireError is the payload of a MsgError frame: why the receiver refused a
// transfer it had already authorized at the transport layer. It replaces a bare
// connection close, which told the sender only "something went wrong".
//
// MsgError has existed since WireVersion 1, so sending one needs no version
// bump: a receiver that never sends one is still conformant, and a sender that
// ignores the type still fails (it just fails less informatively).
//
// Msg is written to the sender's console. It may name a relative manifest path
// — the sender's own words for its own file — but must never carry an absolute
// receive/config path, identity material, or allow-list contents.
type WireError struct {
	Code string
	Msg  string
}

// RemoteError is a WireError as seen by the sender.
type RemoteError struct {
	Code string
	Msg  string
}

func (e *RemoteError) Error() string {
	if e.Msg == "" {
		return "receiver refused the transfer: " + e.Code
	}
	return "receiver refused the transfer: " + e.Msg
}

// readExpect reads one frame into v, translating a MsgError frame into a
// *RemoteError instead of silently decoding a refusal as the awaited message.
//
// It stays deliberately lenient about every OTHER type, exactly as ReadJSON is,
// so nothing that interoperated before is rejected now.
func readExpect(r io.Reader, v any) error {
	t, payload, err := ReadFrame(r)
	if err != nil {
		return err
	}
	if t == MsgError {
		var we WireError
		if err := json.Unmarshal(payload, &we); err != nil {
			return errors.New("receiver refused the transfer (unreadable error frame)")
		}
		return &RemoteError{Code: we.Code, Msg: we.Msg}
	}
	return json.Unmarshal(payload, v)
}

// WriteFrame writes [type:1][len:uint32-BE][payload].
func WriteFrame(w io.Writer, t MsgType, payload []byte) error {
	if len(payload) > maxFramePayload {
		return fmt.Errorf("frame payload too large: %d", len(payload))
	}
	var hdr [5]byte
	hdr[0] = byte(t)
	binary.BigEndian.PutUint32(hdr[1:], uint32(len(payload)))
	if _, err := w.Write(hdr[:]); err != nil {
		return err
	}
	_, err := w.Write(payload)
	return err
}

// ReadFrame reads a single control frame.
func ReadFrame(r io.Reader) (MsgType, []byte, error) {
	var hdr [5]byte
	if _, err := io.ReadFull(r, hdr[:]); err != nil {
		return 0, nil, err
	}
	n := binary.BigEndian.Uint32(hdr[1:])
	if n > maxFramePayload {
		return 0, nil, fmt.Errorf("frame payload too large: %d", n)
	}
	payload := make([]byte, n)
	if _, err := io.ReadFull(r, payload); err != nil {
		return 0, nil, err
	}
	return MsgType(hdr[0]), payload, nil
}

// WriteJSON marshals v and writes it as a typed frame.
func WriteJSON(w io.Writer, t MsgType, v any) error {
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	return WriteFrame(w, t, b)
}

// ReadJSON reads one frame and unmarshals its payload into v.
func ReadJSON(r io.Reader, v any) (MsgType, error) {
	t, payload, err := ReadFrame(r)
	if err != nil {
		return 0, err
	}
	if err := json.Unmarshal(payload, v); err != nil {
		return t, err
	}
	return t, nil
}

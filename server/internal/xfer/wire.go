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
)

const maxFramePayload = 8 << 20 // 8 MiB guard for control frames

type Hello struct {
	Version int
	Mode    string // "push" or "pull"
	Sync    bool   // sync mode: receiver may skip unchanged files and preserve mtime
	Delete  bool   // mirror: receiver may delete files not in the manifest (if permitted)
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
}

type FileStart struct {
	Index  int
	Offset int64
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

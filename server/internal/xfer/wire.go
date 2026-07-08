package xfer

import (
	"encoding/binary"
	"encoding/json"
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

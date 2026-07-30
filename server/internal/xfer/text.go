package xfer

import (
	"encoding/binary"
	"fmt"
	"io"
	"unicode/utf8"
)

// MsgText carries one ephemeral message over the pinned-TLS stream.
//
// It is used only by `relayium text`, whose peer is always another `relayium
// text`: the rzvous handshake refuses a mode mismatch before a TLS connection
// exists (see rzvous.ModeCompatible), so this frame never reaches a file
// receiver. That ordering is what makes the type tag safe here at all -- xfer's
// protocol is positional and no other call site validates the type it reads.
const MsgText MsgType = 8

// TextMaxBytes matches the web client's TEXT_MAX_BYTES. One message, one frame,
// no chunking: 64 KiB of UTF-8 covers any realistic paste of code or logs, and
// anything larger is a file.
const TextMaxBytes = 64 * 1024

// WriteText frames one message.
//
// Nothing is trimmed, normalised, or parsed: the bytes are the content. A body
// that is empty, all whitespace, multiline, or carries an embedded NUL is a valid
// body and goes out unchanged.
func WriteText(w io.Writer, body string) error {
	if len(body) > TextMaxBytes {
		// The length, never the content: this reaches logs and terminals.
		return fmt.Errorf("message too large: %d bytes (max %d)", len(body), TextMaxBytes)
	}
	return WriteFrame(w, MsgText, []byte(body))
}

// ReadText reads one message frame.
//
// It deliberately does not use ReadFrame. That guards only against the
// package-wide maxFramePayload of 8 MiB, and the length prefix is
// peer-controlled: a message is at most TextMaxBytes, so the cap is checked on
// the prefix, BEFORE anything is allocated. Same rule the stored wire states for
// MAX_FRAME_CT.
//
// io.EOF is returned unwrapped on a cleanly closed stream, so a caller can tell
// "the peer hung up" from "the peer sent something malformed".
func ReadText(r io.Reader) (string, error) {
	var hdr [5]byte
	if _, err := io.ReadFull(r, hdr[:]); err != nil {
		if err == io.ErrUnexpectedEOF {
			return "", fmt.Errorf("truncated message header: %w", err)
		}
		return "", err
	}
	if MsgType(hdr[0]) != MsgText {
		return "", fmt.Errorf("expected a message frame, got type %d", hdr[0])
	}
	n := binary.BigEndian.Uint32(hdr[1:])
	if n > TextMaxBytes {
		return "", fmt.Errorf("message frame too large: %d bytes (max %d)", n, TextMaxBytes)
	}
	body := make([]byte, n)
	if _, err := io.ReadFull(r, body); err != nil {
		if err == io.EOF || err == io.ErrUnexpectedEOF {
			return "", fmt.Errorf("truncated message body: want %d bytes: %w", n, err)
		}
		return "", err
	}
	// Invalid UTF-8 is an error, never a replacement character. Go's []byte→string
	// conversion is happy to carry arbitrary bytes, so nothing else would catch it,
	// and silent corruption reported as success is worse than a refusal.
	if !utf8.Valid(body) {
		return "", fmt.Errorf("message is not valid UTF-8: %d bytes", len(body))
	}
	return string(body), nil
}

package xfer

import (
	"bytes"
	"encoding/binary"
	"io"
	"strings"
	"testing"
)

// Exactly the content the invariants promise to preserve: leading and trailing
// whitespace, a tab-indented block, blank lines, CJK, an astral emoji, a
// combining mark, and a bare CR that no normalising layer may turn into a newline.
const gnarly = "  \tif x:\n\n\t\tprintf %s '你好 مرحبا 🌍 e\u0301'\n   \r\n  trailing   "

func TestTextRoundtripPreservesContentExactly(t *testing.T) {
	var buf bytes.Buffer
	if err := WriteText(&buf, gnarly); err != nil {
		t.Fatal(err)
	}
	got, err := ReadText(&buf)
	if err != nil {
		t.Fatal(err)
	}
	if got != gnarly {
		t.Fatalf("got %q, want %q", got, gnarly)
	}
	// Not merely equal as a string: the same bytes, in the same order.
	if !bytes.Equal([]byte(got), []byte(gnarly)) {
		t.Fatalf("bytes differ:\n got %v\nwant %v", []byte(got), []byte(gnarly))
	}
	if buf.Len() != 0 {
		t.Fatalf("%d bytes left unread after one frame", buf.Len())
	}
}

func TestTextRoundtripEmptyAndWhitespaceOnly(t *testing.T) {
	for _, want := range []string{"", " ", "   ", "\n", "\n\n", "\t ", "\r", "\r\n"} {
		var buf bytes.Buffer
		if err := WriteText(&buf, want); err != nil {
			t.Fatalf("%q: %v", want, err)
		}
		got, err := ReadText(&buf)
		if err != nil {
			t.Fatalf("%q: %v", want, err)
		}
		if got != want {
			t.Fatalf("got %q, want %q", got, want)
		}
	}
}

// Several messages down one stream, in order, with no separator between them.
func TestTextRoundtripSequenceInOrder(t *testing.T) {
	bodies := []string{"первый\n\n", "\t\t二番目\t", "🌍🌎🌏", "  \n  ", "", "last"}
	var buf bytes.Buffer
	for _, b := range bodies {
		if err := WriteText(&buf, b); err != nil {
			t.Fatal(err)
		}
	}
	for i, want := range bodies {
		got, err := ReadText(&buf)
		if err != nil {
			t.Fatalf("message %d: %v", i, err)
		}
		if got != want {
			t.Fatalf("message %d: got %q, want %q", i, got, want)
		}
	}
	if buf.Len() != 0 {
		t.Fatalf("%d bytes left over", buf.Len())
	}
}

// The limit is bytes, and the boundary is reachable.
func TestWriteTextAcceptsExactlyTheCap(t *testing.T) {
	var buf bytes.Buffer
	body := strings.Repeat("a", TextMaxBytes)
	if err := WriteText(&buf, body); err != nil {
		t.Fatalf("a message of exactly TextMaxBytes must be accepted: %v", err)
	}
	got, err := ReadText(&buf)
	if err != nil {
		t.Fatal(err)
	}
	if got != body {
		t.Fatal("round trip at the cap changed the body")
	}
}

func TestWriteTextRefusesOneByteOverTheCap(t *testing.T) {
	var buf bytes.Buffer
	if err := WriteText(&buf, strings.Repeat("a", TextMaxBytes+1)); err == nil {
		t.Fatal("expected a refusal one byte over the cap")
	}
	if buf.Len() != 0 {
		t.Fatalf("nothing should have been written, got %d bytes", buf.Len())
	}
}

// Bytes, not runes. A rune-based limit would let this through.
func TestWriteTextRefusesOverTheCapInBytesNotRunes(t *testing.T) {
	var buf bytes.Buffer
	// 22000 runes * 3 bytes = 66000 > 65536, but only 22000 characters.
	if err := WriteText(&buf, strings.Repeat("你", 22000)); err == nil {
		t.Fatal("expected a refusal measured in bytes")
	}
	if buf.Len() != 0 {
		t.Fatalf("nothing should have been written, got %d bytes", buf.Len())
	}
}

// The length prefix is peer-controlled, so it must be checked BEFORE any
// allocation -- the same rule the stored wire states for MAX_FRAME_CT. The
// package-wide maxFramePayload of 8 MiB is far too permissive for a message, so
// reusing ReadFrame here would be wrong.
func TestReadTextRejectsAnOversizePrefixWithoutAllocating(t *testing.T) {
	for _, n := range []uint32{TextMaxBytes + 1, 1 << 20, maxFramePayload, 0xffffffff} {
		var hdr [5]byte
		hdr[0] = byte(MsgText)
		binary.BigEndian.PutUint32(hdr[1:], n)
		_, err := ReadText(bytes.NewReader(hdr[:]))
		if err == nil {
			t.Fatalf("prefix %d: expected a refusal on the prefix alone", n)
		}
		// It must fail on the CAP, not by running out of bytes to read: an
		// implementation that allocated first and then hit EOF would pass a
		// bare "expected an error" assertion while still allocating 4 GiB.
		if !strings.Contains(err.Error(), "too large") {
			t.Fatalf("prefix %d: err = %v, want a size refusal", n, err)
		}
	}
}

func TestReadTextRejectsInvalidUTF8(t *testing.T) {
	for _, bad := range [][]byte{
		{0x80},                   // a lone continuation byte
		{0xc3},                   // a truncated 2-byte sequence
		{0xed, 0xa0, 0x80},       // a UTF-16 surrogate half, illegal in UTF-8
		{0xf4, 0x90, 0x80, 0x80}, // beyond U+10FFFF
		append([]byte("ok "), 0xff),
	} {
		var buf bytes.Buffer
		if err := WriteFrame(&buf, MsgText, bad); err != nil {
			t.Fatal(err)
		}
		got, err := ReadText(&buf)
		if err == nil {
			t.Fatalf("%v: expected invalid UTF-8 to be an error, got %q", bad, got)
		}
		if !strings.Contains(err.Error(), "UTF-8") {
			t.Fatalf("%v: err = %v, want it to name the encoding", bad, err)
		}
	}
}

// A NUL is valid UTF-8 and is content, not a terminator.
func TestReadTextKeepsAnEmbeddedNUL(t *testing.T) {
	body := "before\x00after"
	var buf bytes.Buffer
	if err := WriteText(&buf, body); err != nil {
		t.Fatal(err)
	}
	got, err := ReadText(&buf)
	if err != nil {
		t.Fatal(err)
	}
	if got != body {
		t.Fatalf("got %q, want %q", got, body)
	}
}

func TestReadTextRejectsTheWrongFrameType(t *testing.T) {
	for _, wrong := range []MsgType{MsgHello, MsgManifest, MsgResume, MsgFileStart, MsgFileHash, MsgResult, MsgError} {
		var buf bytes.Buffer
		if err := WriteFrame(&buf, wrong, []byte("hello")); err != nil {
			t.Fatal(err)
		}
		if _, err := ReadText(&buf); err == nil {
			t.Fatalf("type %d: expected a non-text frame to be rejected", wrong)
		}
	}
}

// Truncation must be an error, never a short read reported as success.
func TestReadTextRejectsATruncatedFrame(t *testing.T) {
	var full bytes.Buffer
	if err := WriteText(&full, "0123456789"); err != nil {
		t.Fatal(err)
	}
	whole := full.Bytes()
	for _, cut := range []int{0, 1, 4, 5, 6, len(whole) - 1} {
		if _, err := ReadText(bytes.NewReader(whole[:cut])); err == nil {
			t.Fatalf("cut at %d: expected an error", cut)
		}
	}
	// The complete frame still reads, so the loop above is not vacuous.
	got, err := ReadText(bytes.NewReader(whole))
	if err != nil || got != "0123456789" {
		t.Fatalf("whole frame: got %q, %v", got, err)
	}
}

func TestReadTextSurfacesEOFOnAnEmptyStream(t *testing.T) {
	if _, err := ReadText(bytes.NewReader(nil)); err != io.EOF {
		t.Fatalf("err = %v, want io.EOF so a caller can tell a closed stream from a bad frame", err)
	}
}

// MsgText must not collide with anything the file protocol uses, or a text frame
// and a control frame become indistinguishable on a shared stream.
func TestMsgTextIsDistinct(t *testing.T) {
	for _, used := range []MsgType{MsgHello, MsgManifest, MsgResume, MsgFileStart, MsgFileHash, MsgResult, MsgError} {
		if MsgText == used {
			t.Fatalf("MsgText collides with %d", used)
		}
	}
	if MsgText != 8 {
		t.Fatalf("MsgText = %d, want 8", MsgText)
	}
	if TextMaxBytes != 64*1024 {
		t.Fatalf("TextMaxBytes = %d, want 65536", TextMaxBytes)
	}
}

// Errors reach logs and terminals, so they carry a length and never the content.
func TestTextErrorsCarryNoContent(t *testing.T) {
	var buf bytes.Buffer
	err := WriteText(&buf, strings.Repeat("CANARY", 20000))
	if err == nil {
		t.Fatal("expected a refusal")
	}
	if strings.Contains(err.Error(), "CANARY") {
		t.Fatalf("write error leaks content: %v", err)
	}

	var bad bytes.Buffer
	if err := WriteFrame(&bad, MsgText, append([]byte("CANARY"), 0xff)); err != nil {
		t.Fatal(err)
	}
	_, err = ReadText(&bad)
	if err == nil {
		t.Fatal("expected invalid UTF-8 to fail")
	}
	if strings.Contains(err.Error(), "CANARY") {
		t.Fatalf("read error leaks content: %v", err)
	}
}

// The file protocol's own framing must be untouched by this addition.
func TestExistingFrameRoundtripStillWorks(t *testing.T) {
	var buf bytes.Buffer
	if err := WriteJSON(&buf, MsgHello, Hello{Version: WireVersion, Mode: "push"}); err != nil {
		t.Fatal(err)
	}
	var h Hello
	tp, err := ReadJSON(&buf, &h)
	if err != nil {
		t.Fatal(err)
	}
	if tp != MsgHello || h.Version != WireVersion || h.Mode != "push" {
		t.Fatalf("hello round trip changed: %v %+v", tp, h)
	}
}

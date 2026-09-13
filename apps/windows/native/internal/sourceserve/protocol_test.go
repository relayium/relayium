// What the validator refuses, and what it must not quietly accept.
//
// These run on any platform: the grammar is where hostile input is stopped, and
// stopping it must not depend on being on Windows to find out.
package sourceserve

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/relayium/relayium/apps/windows/native/internal/wire"
)

func codeOf(t *testing.T, err error) wire.Code {
	t.Helper()
	if err == nil {
		t.Fatalf("expected an error, got none")
	}
	return wire.CodeOf(err)
}

func TestAcceptsTheThreeOperations(t *testing.T) {
	open, err := DecodeRequest([]byte(`{"id":1,"op":"open-source","path":"C:\\a\\b.txt"}`))
	if err != nil {
		t.Fatalf("open refused: %v", err)
	}
	if open.Path != `C:\a\b.txt` {
		t.Fatalf("path mangled: %q", open.Path)
	}
	read, err := DecodeRequest([]byte(`{"id":2,"op":"read-source","source":7,"offset":0,"length":10}`))
	if err != nil {
		t.Fatalf("read refused: %v", err)
	}
	if read.Source != 7 || *read.Offset != 0 || *read.Length != 10 {
		t.Fatalf("read fields wrong: %+v", read)
	}
	if _, err := DecodeRequest([]byte(`{"id":3,"op":"close-source","source":7}`)); err != nil {
		t.Fatalf("close refused: %v", err)
	}
}

// Offset zero is a legitimate read and an omitted offset is malformed. A
// non-pointer field could not tell them apart, and the failure mode would be
// silently reading from the start of a file the host meant to seek into.
func TestOmittedOffsetIsNotZero(t *testing.T) {
	if _, err := DecodeRequest([]byte(`{"id":1,"op":"read-source","source":1,"length":10}`)); err == nil {
		t.Fatalf("a read with no offset was accepted")
	}
	req, err := DecodeRequest([]byte(`{"id":1,"op":"read-source","source":1,"offset":0,"length":10}`))
	if err != nil {
		t.Fatalf("offset zero refused: %v", err)
	}
	if req.Offset == nil || *req.Offset != 0 {
		t.Fatalf("offset zero not preserved: %+v", req)
	}
}

func TestHostileShapesAreRefused(t *testing.T) {
	cases := []struct {
		name    string
		payload string
		want    wire.Code
	}{
		{"zero id", `{"id":0,"op":"open-source","path":"C:\\a"}`, wire.CodeProtocol},
		{"missing id", `{"op":"open-source","path":"C:\\a"}`, wire.CodeProtocol},
		{"unknown op", `{"id":1,"op":"delete-source","path":"C:\\a"}`, wire.CodeProtocol},
		{"receive op", `{"id":1,"op":"publish"}`, wire.CodeProtocol},
		{"unknown field", `{"id":1,"op":"open-source","path":"C:\\a","root":"C:\\"}`, wire.CodeProtocol},
		{"not json", `{"id":1,`, wire.CodeProtocol},
		{"not an object", `[1,2,3]`, wire.CodeProtocol},
		{"trailing object", `{"id":1,"op":"close-source","source":1}{"id":2,"op":"close-source","source":1}`, wire.CodeProtocol},
		{"open without path", `{"id":1,"op":"open-source"}`, wire.CodeProtocol},
		{"open with source", `{"id":1,"op":"open-source","path":"C:\\a","source":2}`, wire.CodeProtocol},
		{"open with offset", `{"id":1,"op":"open-source","path":"C:\\a","offset":0}`, wire.CodeProtocol},
		{"open with length", `{"id":1,"op":"open-source","path":"C:\\a","length":1}`, wire.CodeProtocol},
		{"read with path", `{"id":1,"op":"read-source","source":1,"offset":0,"length":1,"path":"C:\\a"}`, wire.CodeProtocol},
		{"read zero source", `{"id":1,"op":"read-source","source":0,"offset":0,"length":1}`, wire.CodeProtocol},
		{"close with offset", `{"id":1,"op":"close-source","source":1,"offset":0}`, wire.CodeProtocol},
		{"close zero source", `{"id":1,"op":"close-source","source":0}`, wire.CodeProtocol},
		{"negative offset", `{"id":1,"op":"read-source","source":1,"offset":-1,"length":1}`, CodeRange},
		{"zero length", `{"id":1,"op":"read-source","source":1,"offset":0,"length":0}`, CodeRange},
		{"negative length", `{"id":1,"op":"read-source","source":1,"offset":0,"length":-5}`, CodeRange},
		{"length over maximum", `{"id":1,"op":"read-source","source":1,"offset":0,"length":196609}`, CodeRange},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			_, err := DecodeRequest([]byte(c.payload))
			if got := codeOf(t, err); got != c.want {
				t.Fatalf("code = %s, want %s", got, c.want)
			}
		})
	}
}

// An oversize length is refused, never clamped. Clamping would serve a different
// read than the host asked for while reporting success.
func TestLengthAtTheBoundary(t *testing.T) {
	atMax := `{"id":1,"op":"read-source","source":1,"offset":0,"length":196608}`
	req, err := DecodeRequest([]byte(atMax))
	if err != nil {
		t.Fatalf("length at maximum refused: %v", err)
	}
	if *req.Length != MaxReadBytes {
		t.Fatalf("length = %d, want %d", *req.Length, MaxReadBytes)
	}
}

// Pinned against MAX_SELECTION_CHUNK in src/shared/os-entry.ts and the transfer
// chunk size. Divergence is a stall, not an error anyone can act on.
func TestReadBoundMatchesTheSharedChunkSize(t *testing.T) {
	if MaxReadBytes != 192*1024 {
		t.Fatalf("MaxReadBytes = %d, want 192 KiB", MaxReadBytes)
	}
	if MaxReadBytes > wire.MaxChunkBytes {
		t.Fatalf("a served read cannot fit in a chunk frame: %d > %d", MaxReadBytes, wire.MaxChunkBytes)
	}
}

func TestInvalidUTF8IsRefusedBeforeDecoding(t *testing.T) {
	payload := append([]byte(`{"id":1,"op":"open-source","path":"C:\\`), 0xff, 0xfe)
	payload = append(payload, []byte(`"}`)...)
	if got := codeOf(t, secondOf(DecodeRequest(payload))); got != wire.CodeProtocol {
		t.Fatalf("code = %s", got)
	}
}

func TestOversizeRequestIsRefusedOnLength(t *testing.T) {
	huge := `{"id":1,"op":"open-source","path":"` + strings.Repeat("a", MaxRequestBytes) + `"}`
	if got := codeOf(t, secondOf(DecodeRequest([]byte(huge)))); got != wire.CodeProtocol {
		t.Fatalf("code = %s", got)
	}
}

// The whole point of the identity encoding. A volume serial and a file id are 64
// and 128 bits; the host is JavaScript, where a JSON number above 2^53 is
// silently rounded and two different files then compare equal.
func TestIdentityCrossesAsStringsNotNumbers(t *testing.T) {
	raw, err := json.Marshal(OpenResult{
		Source:       1,
		Size:         5,
		VolumeSerial: "ffffffffffffffff",
		FileID:       "0123456789abcdef0123456789abcdef",
	})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	text := string(raw)
	if !strings.Contains(text, `"volumeSerial":"ffffffffffffffff"`) {
		t.Fatalf("volume serial is not a quoted string: %s", text)
	}
	if !strings.Contains(text, `"fileId":"0123456789abcdef0123456789abcdef"`) {
		t.Fatalf("file id is not a quoted string: %s", text)
	}
	// The negative control: the same values as JSON numbers do not survive a
	// float64 round trip, which is what the host would do with them.
	var asNumber struct {
		V float64 `json:"v"`
	}
	if err := json.Unmarshal([]byte(`{"v":9007199254740993}`), &asNumber); err != nil {
		t.Fatalf("control unmarshal: %v", err)
	}
	if uint64(asNumber.V) == 9007199254740993 {
		t.Fatalf("control failed: float64 preserved 2^53+1, so this test proves nothing")
	}
}

func TestEncodeErrCarriesCodeAndBoundedDetail(t *testing.T) {
	frame, err := EncodeErr(9, wire.Errf(CodeUnknownSource, "detail"))
	if err != nil {
		t.Fatalf("encode: %v", err)
	}
	resp := decodeResponse(t, frame)
	if resp.ID != 9 || resp.OK {
		t.Fatalf("response = %+v", resp)
	}
	if resp.Code != CodeUnknownSource {
		t.Fatalf("code = %s", resp.Code)
	}
}

// An error the walker raises but this package never names still reaches the host
// with its own code. Each package declares the codes it raises; a new refusal in
// the walker must not need an edit here to be reported truthfully.
func TestUnknownCodesPassThrough(t *testing.T) {
	frame, err := EncodeErr(4, wire.Errf(wire.Code("E_SOMETHING_NEW"), ""))
	if err != nil {
		t.Fatalf("encode: %v", err)
	}
	if got := decodeResponse(t, frame).Code; got != "E_SOMETHING_NEW" {
		t.Fatalf("code = %s", got)
	}
}

func secondOf(_ Request, err error) error { return err }

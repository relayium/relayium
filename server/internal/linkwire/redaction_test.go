package linkwire

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"testing"
)

// The four codecs hold a raw session key in a plain byte array, and the file
// receiver also buffers authenticated plaintext pieces, so without a Format
// method any %v, %x or %#v of one — in a log line, an error or a debug dump —
// prints them. These tests put each codec in a state where every secret field
// is populated, then format it every common way.

var redactionVerbs = []string{"%v", "%+v", "%#v", "%s", "%q", "%x", "%X", "%d", "%10v", "%-8s"}

// dummyKey is a 32-byte test key derived from a label, so no key's bytes occur
// inside another's and a hit is not a coincidence.
func dummyKey(label string) []byte {
	k := sha256.Sum256([]byte(label))
	return k[:]
}

// quoted matches a Go-quoted string, which is how %q spells a byte array.
var quoted = regexp.MustCompile(`"(?:[^"\\]|\\.)*"`)

// leaks reports which secrets out spells: raw, inside a %q-quoted string, as
// hex in either case (plain or %#v's 0x-list), or as decimal bytes. A 4-byte
// window is enough to catch each.
func leaks(out string, secrets map[string][]byte) []string {
	raw := out
	for _, q := range quoted.FindAllString(out, -1) {
		if s, err := strconv.Unquote(q); err == nil {
			raw += "\n" + s
		}
	}
	lower := strings.ToLower(out)
	var found []string
	for name, sec := range secrets {
		w := sec[:4]
		if strings.Contains(raw, string(w)) ||
			strings.Contains(lower, hex.EncodeToString(w)) ||
			strings.Contains(lower, fmt.Sprintf("%#x, %#x", w[0], w[1])) ||
			strings.Contains(out, strings.Trim(fmt.Sprint(w), "[]")) {
			found = append(found, name)
		}
	}
	return found
}

type redactionSubjects struct {
	fs *FileSender
	fr *FileReceiver
	ts *TextSender
	tr *TextReceiver
	// secrets is every value that must not appear in any formatting.
	secrets map[string][]byte
}

func populatedCodecs(t *testing.T) redactionSubjects {
	t.Helper()
	fileKey := dummyKey("file")
	textSendKey := dummyKey("text send")
	textRecvKey := dummyKey("text recv")

	fs, err := NewFileSender(fileKey)
	if err != nil {
		t.Fatal(err)
	}
	fr, err := NewFileReceiver(fileKey)
	if err != nil {
		t.Fatal(err)
	}
	// One whole chunk, so both chains are content-derived, then the first
	// piece of a second chunk, so the receiver is holding plaintext.
	first := bytes.Repeat([]byte("FIRST-CHUNK-PLAINTEXT"), ChunkSize/21+1)[:ChunkSize]
	second := bytes.Repeat([]byte("FRAGMENT-PLAINTEXT-SECRET"), 1000)
	frames, err := fs.ChunkFrames(first, 64*1024)
	if err != nil {
		t.Fatal(err)
	}
	more, err := fs.ChunkFrames(second, 8*1024)
	if err != nil {
		t.Fatal(err)
	}
	for _, f := range append(frames, more[0]) {
		if _, err := fr.Feed(f); err != nil {
			t.Fatal(err)
		}
	}
	if len(fr.parts) == 0 || fr.chain == ([ChainSize]byte{}) || fs.chain == ([ChainSize]byte{}) {
		t.Fatal("fixture did not populate the receiver's buffer and both chains")
	}

	ts, err := NewTextSender(textSendKey)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := ts.Seal([]byte("hello")); err != nil {
		t.Fatal(err)
	}
	tr, err := NewTextReceiver(textRecvKey)
	if err != nil {
		t.Fatal(err)
	}

	return redactionSubjects{fs: fs, fr: fr, ts: ts, tr: tr, secrets: map[string][]byte{
		"file key":            fileKey,
		"text send key":       textSendKey,
		"text recv key":       textRecvKey,
		"buffered plaintext":  fr.parts[0],
		"sender chain":        fs.chain[:],
		"receiver chain":      fr.chain[:],
		"completed plaintext": first,
	}}
}

// Every verb, on the pointer and on the value, prints exactly the redacted
// form: the type, its non-secret sequence position, and nothing else.
func TestCodecFormattingIsRedactedForEveryVerb(t *testing.T) {
	c := populatedCodecs(t)
	cases := []struct {
		ptr, val any
		want     string
	}{
		{c.fs, *c.fs, fmt.Sprintf("linkwire.FileSender{next:%d redacted}", c.fs.NextSeq())},
		{c.fr, *c.fr, fmt.Sprintf("linkwire.FileReceiver{expected:%d redacted}", c.fr.ExpectedSeq())},
		{c.ts, *c.ts, "linkwire.TextSender{next:1 redacted}"},
		{c.tr, *c.tr, "linkwire.TextReceiver{expected:0 redacted}"},
	}
	for _, tc := range cases {
		for _, subject := range []any{tc.ptr, tc.val} {
			for _, verb := range redactionVerbs {
				out := fmt.Sprintf(verb, subject)
				if out != tc.want {
					t.Errorf("%s of %T = %.120q, want %q", verb, subject, out, tc.want)
				}
				if found := leaks(out, c.secrets); len(found) > 0 {
					t.Errorf("%s of %T prints %v", verb, subject, found)
				}
			}
			for name, out := range map[string]string{
				"Sprint":   fmt.Sprint(subject),
				"Sprintln": strings.TrimSuffix(fmt.Sprintln(subject), "\n"),
			} {
				if out != tc.want {
					t.Errorf("%s of %T = %.120q, want %q", name, subject, out, tc.want)
				}
			}
		}
	}
}

// Reached through an exported field, a slice or a map, fmt still calls Format,
// so a caller dumping a struct that carries a codec does not leak it either.
func TestCodecFormattingIsRedactedWhenNested(t *testing.T) {
	c := populatedCodecs(t)
	type lane struct {
		Send   *FileSender
		Recv   FileReceiver
		Text   []*TextSender
		ByName map[string]TextReceiver
	}
	holder := lane{Send: c.fs, Recv: *c.fr, Text: []*TextSender{c.ts}, ByName: map[string]TextReceiver{"peer": *c.tr}}
	for _, subject := range []any{holder, &holder, []any{c.fs, *c.fr, c.ts, *c.tr}} {
		for _, verb := range redactionVerbs {
			out := fmt.Sprintf(verb, subject)
			if found := leaks(out, c.secrets); len(found) > 0 {
				t.Errorf("%s of %T prints %v", verb, subject, found)
			}
			if !strings.Contains(out, "redacted") {
				t.Errorf("%s of %T did not reach the codec's Format: %.120q", verb, subject, out)
			}
		}
	}
}

// A nil codec formats as fmt's usual <nil> rather than panicking in Format.
func TestNilCodecFormatting(t *testing.T) {
	for _, subject := range []any{(*FileSender)(nil), (*FileReceiver)(nil), (*TextSender)(nil), (*TextReceiver)(nil)} {
		if got := fmt.Sprintf("%v", subject); got != "<nil>" {
			t.Errorf("%T nil = %q, want <nil>", subject, got)
		}
	}
}

// The leak scan itself must see each secret in its unredacted spellings;
// otherwise a green run above would prove nothing.
func TestRedactionLeakScanDetectsEachSpelling(t *testing.T) {
	sec := dummyKey("scan")
	secrets := map[string][]byte{"k": sec}
	for _, verb := range []string{"%v", "%+v", "%#v", "%s", "%q", "%x", "%X", "%d"} {
		if out := fmt.Sprintf(verb, struct{ key [32]byte }{[32]byte(sec)}); len(leaks(out, secrets)) == 0 {
			t.Errorf("leak scan missed %s spelling %.80q", verb, out)
		}
	}
}

// Portable name-validation tests.
//
// SCOPE: these prove the naming decision only. They prove NOTHING about Windows
// filesystem semantics — a name accepted here is still subject to the NT layer's
// own refusals at publication. See internal/winio.
package nameguard

import (
	"encoding/json"
	"os"
	"strings"
	"testing"
)

// sharedFixture is the SAME file src/main/io/winpath.ts is tested against.
//
// Loaded rather than copied, and a missing file is a hard failure rather than a
// skip. Two boundaries deciding the same question from two copies of the vectors
// is how they silently drift apart; this way divergence is a loud test failure.
const sharedFixture = "../../../test/fixtures/root-path-adversarial.json"

type fixture struct {
	Reject         []string   `json:"reject"`
	Positive       []string   `json:"positive"`
	CollisionPairs [][]string `json:"collisionPairs"`
}

func loadFixture(t *testing.T) fixture {
	t.Helper()
	raw, err := os.ReadFile(sharedFixture)
	if err != nil {
		t.Fatalf("shared fixture %s is unreadable: %v\nThis file is the single source of truth shared with the TypeScript boundary; it must not be skipped.", sharedFixture, err)
	}
	var f fixture
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatalf("shared fixture is not parseable: %v", err)
	}
	if len(f.Reject) == 0 || len(f.Positive) == 0 {
		t.Fatal("shared fixture is empty; a vacuous pass here would look like coverage")
	}
	return f
}

func TestSharedFixtureRejections(t *testing.T) {
	f := loadFixture(t)
	for _, name := range f.Reject {
		if v := ValidateRelativePath(name); v.OK {
			t.Errorf("accepted %q, which the shared fixture requires be refused", name)
		}
	}
}

func TestSharedFixturePositives(t *testing.T) {
	f := loadFixture(t)
	for _, name := range f.Positive {
		if v := ValidateRelativePath(name); !v.OK {
			t.Errorf("refused %q with %q; the shared fixture requires it be accepted", name, v.Reason)
		}
	}
}

func TestSharedFixtureCollisionPairs(t *testing.T) {
	f := loadFixture(t)
	for _, pair := range f.CollisionPairs {
		if len(pair) != 2 {
			t.Fatalf("malformed collision pair %v", pair)
		}
		plan, failure := BuildPlan([]Entry{{Name: pair[0], Size: 1}, {Name: pair[1], Size: 1}})
		if failure == nil {
			t.Errorf("planned %q and %q together; the fixture requires a conflict, got %d files", pair[0], pair[1], len(plan.Files))
		}
	}
}

// The reasons are protocol: the renderer maps them to user-facing copy, so a
// rename is a breaking change and each must fire for its own cause.
func TestRejectionReasonsAreSpecific(t *testing.T) {
	cases := []struct {
		name string
		want Rejection
	}{
		{"../escape", RejectTraversal},
		{"/absolute", RejectAbsolute},
		{`\absolute`, RejectAbsolute},
		{"C:/escape", RejectAbsolute},
		{"C:relative", RejectDriveRelative},
		{`\\server\share`, RejectUNCOrDevice},
		{`\\?\C:\file`, RejectUNCOrDevice},
		{"//unc/share", RejectUNCOrDevice},
		{"name:stream", RejectAlternateDataStream},
		{"CON", RejectReservedDeviceName},
		{"nul.txt", RejectReservedDeviceName},
		{"COM\u00B9.txt", RejectReservedDeviceName},
		{"trailing.", RejectTrailingDotOrSpace},
		{"trailing ", RejectTrailingDotOrSpace},
		{`a\b`, RejectBackslashInSegment},
		{"a\x00b", RejectInvalidCharacter},
		{"a\nb", RejectInvalidCharacter},
		{"a?b", RejectInvalidCharacter},
		{"", RejectEmpty},
		{"a//b", RejectEmpty},
	}
	for _, c := range cases {
		v := ValidateRelativePath(c.name)
		if v.OK {
			t.Errorf("%q was accepted; want %q", c.name, c.want)
			continue
		}
		if v.Reason != c.want {
			t.Errorf("%q refused as %q; want %q", c.name, v.Reason, c.want)
		}
	}
}

// Both segment limits apply and neither implies the other: 256 ASCII characters
// pass the byte limit and fail the UTF-16 unit limit, which is the one NTFS
// enforces.
func TestSegmentLengthLimitsAreIndependent(t *testing.T) {
	if v := ValidateSegment(strings.Repeat("a", MaxSegmentUTF16)); !v.OK {
		t.Errorf("255 ASCII units refused: %q", v.Reason)
	}
	if v := ValidateSegment(strings.Repeat("a", MaxSegmentUTF16+1)); v.Reason != RejectSegmentTooLong {
		t.Errorf("256 ASCII units: got %q, want segment-too-long", v.Reason)
	}
	// 400 CJK characters are 400 UTF-16 units and 1200 UTF-8 bytes: over both.
	if v := ValidateSegment(strings.Repeat("\u4e2d", 400)); v.Reason != RejectSegmentTooLong {
		t.Errorf("400 CJK characters: got %q, want segment-too-long", v.Reason)
	}
	// Astral characters cost two UTF-16 units each, matching what NTFS counts.
	if v := ValidateSegment(strings.Repeat("\U0001F600", 128)); v.Reason != RejectSegmentTooLong {
		t.Errorf("128 astral characters are 256 UTF-16 units: got %q, want segment-too-long", v.Reason)
	}
	if v := ValidateSegment(strings.Repeat("\U0001F600", 127)); !v.OK {
		t.Errorf("127 astral characters are 254 units and should pass: %q", v.Reason)
	}
}

func TestDepthLimit(t *testing.T) {
	deep := strings.Repeat("a/", MaxDepth-1) + "f.txt"
	if v := ValidateRelativePath(deep); !v.OK {
		t.Errorf("depth %d refused: %q", MaxDepth, v.Reason)
	}
	deeper := strings.Repeat("a/", MaxDepth) + "f.txt"
	if v := ValidateRelativePath(deeper); v.Reason != RejectTooDeep {
		t.Errorf("depth %d: got %q, want too-deep", MaxDepth+1, v.Reason)
	}
}

func TestCollisionKeyFoldsCase(t *testing.T) {
	if CollisionKey([]string{"Folder", "A.txt"}) != CollisionKey([]string{"folder", "a.TXT"}) {
		t.Fatal("case-insensitive collision key does not fold; NTFS would treat these as one file")
	}
	if CollisionKey([]string{"a"}) == CollisionKey([]string{"b"}) {
		t.Fatal("distinct names collapsed to one key")
	}
}

// A name that reads as something it is not.
//
// U+202E reverses everything after it, so `photo‮gnp.exe` renders in
// Explorer as `photoexe.png`. The reader double-clicks an executable believing
// it is an image, and on Windows the extension is what decides that. This guard
// sees names chosen by a remote peer, which is the whole reason it exists.
//
// Refused rather than stripped, and reported as its own reason: `<` cannot be
// written at all, while U+202E can be written perfectly and is still refused.
func TestDeceptiveCharactersAreRefused(t *testing.T) {
	deceptive := []rune{
		0x007F, 0x061C, 0x200E, 0x200F,
		0x202A, 0x202B, 0x202C, 0x202D, 0x202E,
		0x2066, 0x2067, 0x2068, 0x2069,
	}
	for _, r := range deceptive {
		for _, name := range []string{
			string(r) + "lead.txt",
			"mid" + string(r) + "dle.txt",
			"trail.txt" + string(r),
		} {
			v := ValidateSegment(name)
			if v.OK {
				t.Fatalf("U+%04X in %q was accepted", r, name)
			}
			if v.Reason != RejectDeceptiveCharacter {
				t.Fatalf("U+%04X in %q: reason = %q, want %q", r, name, v.Reason, RejectDeceptiveCharacter)
			}
		}
	}
}

// The attack in one case, spelled out, so a reader of this file sees it.
func TestTheRightToLeftOverrideCannotSwapAVisibleExtension(t *testing.T) {
	v := ValidateRelativePath("docs/photo" + string(rune(0x202E)) + "gnp.exe")
	if v.OK || v.Reason != RejectDeceptiveCharacter {
		t.Fatalf("ok=%v reason=%q, want a deceptive-character refusal", v.OK, v.Reason)
	}
}

// The rule is about characters that lie, not about scripts. Refusing these
// would be a different bug wearing the same fix.
func TestOrdinaryNonASCIINamesAreStillAccepted(t *testing.T) {
	for _, name := range []string{"文件.txt", "café.txt", "Ünïcode ✅.txt"} {
		if v := ValidateSegment(name); !v.OK {
			t.Fatalf("%q was refused as %q", name, v.Reason)
		}
	}
}

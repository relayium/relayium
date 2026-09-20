package signal

import (
	"strings"
	"testing"
)

// fixedDraw returns a tag drawer handing out the given tags in order, then
// failing — so a test can force both a collision and entropy exhaustion.
func fixedDraw(tags ...string) func() (string, bool) {
	i := 0
	return func() (string, bool) {
		if i >= len(tags) {
			return "", false
		}
		t := tags[i]
		i++
		return t, true
	}
}

func TestRelayAttribTagShapeIsNeverACode(t *testing.T) {
	tag, ok := drawRelayAttribTag()
	if !ok {
		t.Fatal("drawRelayAttribTag failed")
	}
	if len(tag) != relayAttribTagLen {
		t.Fatalf("tag %q length %d, want %d", tag, len(tag), relayAttribTagLen)
	}
	if !strings.HasPrefix(tag, relayAttribTagPrefix) {
		t.Fatalf("tag %q lacks prefix %q", tag, relayAttribTagPrefix)
	}
	if !validRelayAttribTag(tag) {
		t.Fatalf("freshly drawn tag %q fails its own shape check", tag)
	}
	// The whole recycling hazard is that the attribution token can be resolved
	// as a pairing code. It must not be possible for a tag.
	if ValidCodeFormat(tag) {
		t.Fatalf("tag %q is shaped like a pairing code", tag)
	}
	// It must also survive the username token split unchanged: the wire format
	// is "<expiry>:<owner>.<tag>" and nothing may need to change to parse it.
	if strings.ContainsAny(tag, ".:") {
		t.Fatalf("tag %q contains a token separator", tag)
	}
}

func TestRelayAttribTagRejectsForeignShapes(t *testing.T) {
	good, _ := drawRelayAttribTag()
	for _, bad := range []string{
		"", "123456", good[1:], good + "0", "h" + good[1:],
		strings.ToUpper(good), "g" + strings.Repeat("z", relayAttribTagLen-1),
	} {
		if validRelayAttribTag(bad) {
			t.Errorf("validRelayAttribTag(%q) = true, want false", bad)
		}
	}
}

func TestMintDrawsADistinctTagPerGeneration(t *testing.T) {
	now := int64(1000)
	p := NewPairRegistry(300, func() int64 { return now })
	seen := map[string]bool{}
	for i := 0; i < 50; i++ {
		code, _ := p.MintFor("owner-a")
		if code == "" {
			t.Fatal("mint failed")
		}
		_, tag, ok := p.AttribFor(code)
		if !ok {
			t.Fatalf("AttribFor(%q) not ok right after mint", code)
		}
		if seen[tag] {
			t.Fatalf("tag %q reused across generations", tag)
		}
		seen[tag] = true
	}
}

// The exact B1 precondition, at the layer that owns it: the same six digits,
// minted again for a DIFFERENT account, while the first generation's
// credentials are still out there.
func TestRecycledDigitsGetANewTagAndTheOldOneKeepsItsOwner(t *testing.T) {
	now := int64(1000)
	p := NewPairRegistry(300, func() int64 { return now })
	p.draw = func() string { return "424242" } // force the reuse

	code, exp := p.MintFor("owner-a")
	if code != "424242" {
		t.Fatalf("mint gave %q", code)
	}
	ownerA, tagA, ok := p.AttribFor(code)
	if !ok || ownerA != "owner-a" {
		t.Fatalf("AttribFor = (%q, %q, %v)", ownerA, tagA, ok)
	}
	// A real credential was issued against it, valid an hour.
	credExpiry := now + 3600
	p.NoteIssuedCredential(tagA, credExpiry)

	// The code dies and the digits go back into circulation.
	now = exp + 1
	p.reap()
	if _, _, ok := p.AttribFor(code); ok {
		t.Fatal("expired code still resolves for issuance")
	}

	// Somebody else mints the same digits.
	if reissued, _ := p.MintFor("owner-b"); reissued != code {
		t.Fatalf("reissue gave %q, want the same digits", reissued)
	}
	ownerB, tagB, ok := p.AttribFor(code)
	if !ok || ownerB != "owner-b" {
		t.Fatalf("reissued code resolves to (%q, %v)", ownerB, ok)
	}
	if tagB == tagA {
		t.Fatal("reissued digits reused the previous generation's attribution tag")
	}

	// THE POINT: owner A's still-live credential is still billed to owner A,
	// even though these digits now name owner B's transfer.
	if got, known := p.OwnerForTag(tagA); !known || got != "owner-a" {
		t.Fatalf("original tag resolves to (%q, %v), want owner-a", got, known)
	}
	// ...and the new generation bills owner B, from a different tag.
	if got, known := p.OwnerForTag(tagB); !known || got != "owner-b" {
		t.Fatalf("new tag resolves to (%q, %v), want owner-b", got, known)
	}
	// The recyclable lookup is the one that now disagrees with the credential
	// A is still using. That disagreement is exactly what used to drop A's
	// bytes, and nothing on the tag path consults it.
	if codeOwner, _ := p.OwnerOf(code); codeOwner != "owner-b" {
		t.Fatalf("precondition lost: code owner is %q", codeOwner)
	}
}

func TestAttribForIsOneAtomicSnapshot(t *testing.T) {
	now := int64(1000)
	p := NewPairRegistry(300, func() int64 { return now })
	code, exp := p.MintFor("owner-a")

	owner, tag, ok := p.AttribFor(code)
	if !ok || owner != "owner-a" || !validRelayAttribTag(tag) {
		t.Fatalf("AttribFor = (%q, %q, %v)", owner, tag, ok)
	}
	// Repeated reads of one live generation are stable: issuance before the
	// peers have paired can happen any number of times.
	for i := 0; i < 5; i++ {
		o2, t2, ok2 := p.AttribFor(code)
		if !ok2 || o2 != owner || t2 != tag {
			t.Fatalf("repeat %d: (%q,%q,%v) != (%q,%q,true)", i, o2, t2, ok2, owner, tag)
		}
	}
	// Expiry closes issuance, and reports it as not-ok rather than as an owner
	// with no tag.
	now = exp
	if o, tg, ok := p.AttribFor(code); ok || o != "" || tg != "" {
		t.Fatalf("expired code issued (%q,%q,%v)", o, tg, ok)
	}
	// A code entry without a tag is never issuable: a registry built some other
	// way cannot quietly fall back to code-shaped attribution.
	p.mu.Lock()
	p.codes["999999"] = codeEntry{exp: now + 300, owner: "owner-c"}
	p.mu.Unlock()
	if o, tg, ok := p.AttribFor("999999"); ok {
		t.Fatalf("tagless entry issued (%q,%q,%v)", o, tg, ok)
	}
}

func TestOwnerForTagRefusesJunkAndUnknowns(t *testing.T) {
	now := int64(1000)
	p := NewPairRegistry(300, func() int64 { return now })
	code, _ := p.MintFor("owner-a")
	_, tag, _ := p.AttribFor(code)

	if got, known := p.OwnerForTag(tag); !known || got != "owner-a" {
		t.Fatalf("live tag = (%q,%v)", got, known)
	}
	// Unknown-but-well-shaped, malformed, and an actual pairing code all answer
	// "not known" — which the caller must read as "cannot contradict", never
	// as "forged".
	other, _ := drawRelayAttribTag()
	for _, in := range []string{other, "", code, "not-a-tag", strings.ToUpper(tag)} {
		if _, known := p.OwnerForTag(in); known {
			t.Errorf("OwnerForTag(%q) claimed knowledge", in)
		}
	}
}

// Retention is the other half of the fix: the tag has to outlive the code, the
// room and the revocation, or the final bytes land unattributed.
func TestTagOutlivesItsCodeUntilTheCredentialGraceRunsOut(t *testing.T) {
	now := int64(1000)
	p := NewPairRegistry(300, func() int64 { return now })
	code, exp := p.MintFor("owner-a")
	_, tag, _ := p.AttribFor(code)

	credExpiry := now + 3600
	p.NoteIssuedCredential(tag, credExpiry)

	// The code is long gone and reaped.
	now = exp + 1
	p.reap()
	if p.Validate(code) {
		t.Fatal("code outlived its TTL")
	}
	if got, known := p.OwnerForTag(tag); !known || got != "owner-a" {
		t.Fatalf("tag died with its code: (%q,%v)", got, known)
	}

	// Still resolvable right up to the last instant of the grace...
	now = credExpiry + relayAttribGraceSeconds - 1
	p.reap()
	if _, known := p.OwnerForTag(tag); !known {
		t.Fatal("tag retired before its credential's reporting grace ran out")
	}
	// ...and gone after it, which is an ACCEPT-as-reported downstream, not a drop.
	now = credExpiry + relayAttribGraceSeconds
	p.reap()
	if _, known := p.OwnerForTag(tag); known {
		t.Fatal("tag never retires")
	}
	p.mu.Lock()
	n := len(p.attrib.tags)
	p.mu.Unlock()
	if n != 0 {
		t.Fatalf("retired tag left %d entries behind", n)
	}
}

func TestExtendAndIssueMoveRetentionForwardOnly(t *testing.T) {
	now := int64(1000)
	p := NewPairRegistry(300, func() int64 { return now })
	code, exp := p.MintFor("owner-a")
	_, tag, _ := p.AttribFor(code)

	read := func() int64 {
		p.mu.Lock()
		defer p.mu.Unlock()
		return p.attrib.tags[tag].retireAfter
	}
	// A tag that has never been put in a credential is kept only to its code's
	// own expiry. It cannot appear in a report, so a grace would protect
	// nothing and would only make the index cheaper to fill.
	if got, want := read(), exp; got != want {
		t.Fatalf("un-issued mint retention %d, want the bare code expiry %d", got, want)
	}

	// A pre-upload extension carries the tag with it: a code that keeps living
	// keeps issuing hour-long credentials. Still no grace — an extension issues
	// nothing by itself.
	until := now + 6*3600
	if !p.ExtendFor(code, "owner-a", until) {
		t.Fatal("ExtendFor refused")
	}
	if got, want := read(), until; got != want {
		t.Fatalf("extended retention %d, want %d", got, want)
	}

	// Issuance pushes it further, and nothing pulls it back in.
	p.NoteIssuedCredential(tag, until+3600)
	after := read()
	if want := until + 3600 + relayAttribGraceSeconds; after != want {
		t.Fatalf("issued retention %d, want %d", after, want)
	}
	p.NoteIssuedCredential(tag, now) // a stale/late report
	if read() != after {
		t.Fatal("a stale issuance pulled retention in")
	}
	// Nor can a late report resurrect a tag that has already retired.
	unknown, _ := drawRelayAttribTag()
	p.NoteIssuedCredential(unknown, now+99999)
	if _, known := p.OwnerForTag(unknown); known {
		t.Fatal("NoteIssuedCredential resurrected an unregistered tag")
	}
}

func TestRevokeTakesTheDigitsAndKeepsTheBillingIdentity(t *testing.T) {
	now := int64(1000)
	p := NewPairRegistry(300, func() int64 { return now })
	code, exp := p.MintFor("owner-a")
	_, tag, _ := p.AttribFor(code)
	p.NoteIssuedCredential(tag, now+3600)

	if !p.RevokeFor(code, "owner-a", exp) {
		t.Fatal("RevokeFor refused")
	}
	if p.Validate(code) {
		t.Fatal("revoked code still validates")
	}
	// A relay holding the credential issued a moment ago is still moving bytes
	// and will report them. Revocation ends a rendezvous, not an allocation.
	if got, known := p.OwnerForTag(tag); !known || got != "owner-a" {
		t.Fatalf("revocation dropped the billing identity: (%q,%v)", got, known)
	}
}

func TestExhaustedAttributionIndexFailsTheMintInsteadOfDegrading(t *testing.T) {
	now := int64(1000)
	p := NewPairRegistry(300, func() int64 { return now })
	p.mu.Lock()
	p.attrib.max = 2
	p.mu.Unlock()

	first, _ := p.MintFor("owner-a")
	second, _ := p.MintFor("owner-a")
	if first == "" || second == "" {
		t.Fatal("mints below the cap failed")
	}
	third, exp := p.MintFor("owner-a")
	if third != "" || exp != 0 {
		t.Fatalf("mint past the cap returned (%q,%d), want a refusal", third, exp)
	}
	// A refused mint must leave NOTHING behind: no code that could later be
	// issued credentials under code-shaped attribution, and no partial tag.
	p.mu.Lock()
	codes, tags := len(p.codes), len(p.attrib.tags)
	p.mu.Unlock()
	if codes != 2 || tags != 2 {
		t.Fatalf("refused mint left codes=%d tags=%d, want 2/2", codes, tags)
	}

	// Capacity comes back on its own once the retained tags retire — the
	// refusal is a full index, not a wedged one.
	now += 300 + relayAttribGraceSeconds + 1
	if again, _ := p.MintFor("owner-a"); again == "" {
		t.Fatal("mint still refused after retention freed the index")
	}
}

// A tag earns its reporting grace by being put into a credential, and not
// before. The split is what keeps an un-issued tag from holding an index slot
// for twenty minutes when it can never appear in a report at all.
func TestOnlyAnIssuedTagEarnsTheReportingGrace(t *testing.T) {
	now := int64(1000)
	p := NewPairRegistry(300, func() int64 { return now })
	retention := func(tag string) int64 {
		p.mu.Lock()
		defer p.mu.Unlock()
		return p.attrib.tags[tag].retireAfter
	}

	quiet, quietExp := p.MintFor("owner-quiet")
	_, quietTag, _ := p.AttribFor(quiet)
	if got := retention(quietTag); got != quietExp {
		t.Fatalf("un-issued retention %d, want %d", got, quietExp)
	}

	used, _ := p.MintFor("owner-used")
	_, usedTag, _ := p.AttribFor(used)
	credExpiry := now + 3600
	p.NoteIssuedCredential(usedTag, credExpiry)
	if got, want := retention(usedTag), credExpiry+relayAttribGraceSeconds; got != want {
		t.Fatalf("issued retention %d, want %d", got, want)
	}

	// Past the code's expiry the un-issued one is gone and the issued one is
	// still answerable — which is the whole asymmetry.
	now = quietExp + 1
	p.reap()
	if _, known := p.OwnerForTag(quietTag); known {
		t.Fatal("an un-issued tag outlived its code")
	}
	if _, known := p.OwnerForTag(usedTag); !known {
		t.Fatal("an issued tag lost its grace")
	}
}

// A full index must not rescan itself on every refused mint: it runs under the
// registry lock that /ws admission, /api/ice issuance and every heartbeat entry
// also take, so a mint flood would stall all three.
func TestFullIndexScansAtMostOncePerSecond(t *testing.T) {
	now := int64(1000)
	p := NewPairRegistry(300, func() int64 { return now })
	scans := func() int {
		p.mu.Lock()
		defer p.mu.Unlock()
		return p.attrib.sweeps
	}

	p.mu.Lock()
	p.attrib.max = 2
	p.mu.Unlock()
	if c, _ := p.MintFor("owner-a"); c == "" {
		t.Fatal("first mint failed")
	}
	if c, _ := p.MintFor("owner-a"); c == "" {
		t.Fatal("second mint failed")
	}

	// First refusal in this second scans once, finds nothing expired, refuses.
	base := scans()
	if c, _ := p.MintFor("owner-a"); c != "" {
		t.Fatal("mint past the cap succeeded")
	}
	if got := scans() - base; got != 1 {
		t.Fatalf("first refusal scanned %d times, want 1", got)
	}
	// Twenty more in the SAME second must not touch the map again: nothing can
	// have expired, because expiry has whole-second granularity.
	for i := 0; i < 20; i++ {
		if c, _ := p.MintFor("owner-a"); c != "" {
			t.Fatalf("mint %d past the cap succeeded", i)
		}
	}
	if got := scans() - base; got != 1 {
		t.Fatalf("same-second refusals scanned %d times, want 1", got)
	}

	// A later second is allowed exactly one more scan...
	now++
	if c, _ := p.MintFor("owner-a"); c != "" {
		t.Fatal("mint past the cap succeeded in the next second")
	}
	if got := scans() - base; got != 2 {
		t.Fatalf("next-second refusal scanned %d times total, want 2", got)
	}

	// ...and the rate bound must not cost slot recovery: once the retained
	// entries really have expired, the next scan frees them and minting works.
	now += 300
	if c, _ := p.MintFor("owner-a"); c == "" {
		t.Fatal("expired slots were never recovered")
	}

	// The scheduled reap also counts as this second's scan, so a refusal
	// immediately after one does not rescan.
	p.mu.Lock()
	p.attrib.max = len(p.attrib.tags)
	p.mu.Unlock()
	p.reap()
	afterReap := scans()
	if c, _ := p.MintFor("owner-a"); c != "" {
		t.Fatal("mint succeeded at the cap")
	}
	if got := scans(); got != afterReap {
		t.Fatalf("refusal rescanned after a reap in the same second (%d -> %d)", afterReap, got)
	}
}

func TestMintRefusesWhenATagCannotBeDrawn(t *testing.T) {
	now := int64(1000)
	p := NewPairRegistry(300, func() int64 { return now })

	// Entropy failure: refuse, never issue an untagged code.
	p.mu.Lock()
	p.attrib.draw = func() (string, bool) { return "", false }
	p.mu.Unlock()
	if code, exp := p.MintFor("owner-a"); code != "" || exp != 0 {
		t.Fatalf("mint with no entropy returned (%q,%d)", code, exp)
	}

	// Collision with a live tag: refuse rather than silently reassign another
	// account's billing identity.
	taken, _ := drawRelayAttribTag()
	p.mu.Lock()
	p.attrib.draw = fixedDraw(taken, taken)
	p.mu.Unlock()
	if code, _ := p.MintFor("owner-a"); code == "" {
		t.Fatal("first mint should have taken the tag")
	}
	if code, exp := p.MintFor("owner-b"); code != "" || exp != 0 {
		t.Fatalf("colliding mint returned (%q,%d)", code, exp)
	}
	if got, _ := p.OwnerForTag(taken); got != "owner-a" {
		t.Fatalf("collision reassigned the tag to %q", got)
	}
	p.mu.Lock()
	n := len(p.codes)
	p.mu.Unlock()
	if n != 1 {
		t.Fatalf("refused mint left %d codes", n)
	}
}

// Nothing above should have needed this, but a compile-time reminder that the
// registry is what the account layer's RelayAttribution seam expects.
var _ interface {
	AttribFor(string) (string, string, bool)
	OwnerForTag(string) (string, bool)
	NoteIssuedCredential(string, int64)
} = (*PairRegistry)(nil)

// The continuous-segment anchor, at the index that owns it.
//
// The grant registry keeps its own copy of this rule, but the index is what
// production actually reads through IssuedSegmentForTag, and only here can two
// issuances be placed at genuinely different instants — an account service
// stamping expiries from its own clock makes two fetches seconds apart look
// simultaneous.
func TestIssuedSegmentAnchorsOnTheFirstIssuanceOfALiveRun(t *testing.T) {
	now := int64(1_000_000)
	p := NewPairRegistry(300, func() int64 { return now })
	code, _ := p.MintFor("owner-a")
	_, tag, _ := p.AttribFor(code)

	if first, latest := p.IssuedSegmentForTag(tag); first != 0 || latest != 0 {
		t.Fatalf("an un-issued tag reported a segment (%d, %d)", first, latest)
	}

	// Peer A fetches: the segment starts here.
	aExpiry := now + 3600
	p.NoteIssuedCredential(tag, aExpiry)
	if first, latest := p.IssuedSegmentForTag(tag); first != aExpiry || latest != aExpiry {
		t.Fatalf("first issuance gave (%d, %d), want (%d, %d)", first, latest, aExpiry, aExpiry)
	}

	// Peer B fetches 25 minutes later, joining the SAME live run. The latest
	// moves; the anchor must not — that is the whole liveness rule.
	now += 1500
	bExpiry := now + 3600
	p.NoteIssuedCredential(tag, bExpiry)
	first, latest := p.IssuedSegmentForTag(tag)
	if first != aExpiry {
		t.Fatalf("a later fetch moved the segment anchor to %d, want %d", first, aExpiry)
	}
	if latest != bExpiry {
		t.Fatalf("latest is %d, want %d", latest, bExpiry)
	}

	// A stale/lower issuance moves neither.
	p.NoteIssuedCredential(tag, aExpiry)
	if f2, l2 := p.IssuedSegmentForTag(tag); f2 != first || l2 != latest {
		t.Fatalf("a stale issuance moved the segment: (%d,%d) -> (%d,%d)", first, latest, f2, l2)
	}

	// Once EVERYTHING issued has expired, the next issuance starts a fresh
	// segment — anchored to itself, never to the run that ended.
	now = bExpiry + 1
	cExpiry := now + 3600
	p.NoteIssuedCredential(tag, cExpiry)
	if f3, l3 := p.IssuedSegmentForTag(tag); f3 != cExpiry || l3 != cExpiry {
		t.Fatalf("a post-lapse issuance gave (%d,%d), want a fresh (%d,%d)", f3, l3, cExpiry, cExpiry)
	}
}

// RetainTag feeds the same segment rule, so an accepted renewal extends the run
// rather than restarting it.
func TestRetainTagJoinsTheLiveSegment(t *testing.T) {
	now := int64(1_000_000)
	p := NewPairRegistry(300, func() int64 { return now })
	code, _ := p.MintFor("owner-a")
	_, tag, _ := p.AttribFor(code)

	first := now + 3600
	p.NoteIssuedCredential(tag, first)
	now += 3000
	p.RetainTag(tag, now+3600)

	if f, l := p.IssuedSegmentForTag(tag); f != first || l != now+3600 {
		t.Fatalf("an accepted renewal gave (%d,%d), want anchor %d and latest %d", f, l, first, now+3600)
	}
}

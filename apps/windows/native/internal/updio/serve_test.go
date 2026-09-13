// The protocol, adversarially, with a fake platform.
//
// Everything here is about what a COMPROMISED HOST can make the helper do. The
// answers must be: it cannot name a path, it cannot delete without a receipt, it
// cannot install without a pin and consent, it cannot replace the captured
// scope, and it cannot make the helper allocate on its say-so.
package updio

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"errors"
	"io"
	"strings"
	"testing"
)

type call struct {
	op       string
	name     string
	to       string
	receipt  string
	consent  string
	chunkLen int
}

type fakeCustody struct {
	calls    []call
	opened   int
	next     uint32
	live     int
	peak     int
	closed   bool
	absent   bool
	readSize int
	failOp   string
	failErr  string
}

func (f *fakeCustody) note(c call) { f.calls = append(f.calls, c) }

func (f *fakeCustody) maybeFail(op string) error {
	if f.failOp != op {
		return nil
	}
	if f.failErr == "" {
		// An error the platform did not classify, carrying text that must not
		// reach the host.
		return errors.New(`CreateFileW: \\?\C:\Users\someone\AppData\Local\Relayium`)
	}
	return Errf(f.failErr)
}

func (f *fakeCustody) Open(root, component string) error {
	f.opened++
	f.note(call{op: "open", name: component})
	return f.maybeFail("open")
}
func (f *fakeCustody) CreateExclusive(name string) (uint32, string, error) {
	f.note(call{op: "create", name: name})
	if err := f.maybeFail("create"); err != nil {
		return 0, "", err
	}
	f.next++
	f.live++
	if f.live > f.peak {
		f.peak = f.live
	}
	return f.next, "win:1:2", nil
}
func (f *fakeCustody) Write(handle uint32, chunk []byte) error {
	f.note(call{op: "write", chunkLen: len(chunk)})
	return f.maybeFail("write")
}
func (f *fakeCustody) Sync(handle uint32) error { f.note(call{op: "sync"}); return nil }
func (f *fakeCustody) Release(handle uint32) error {
	f.note(call{op: "release"})
	f.live--
	return f.maybeFail("release")
}
func (f *fakeCustody) Commit(handle uint32, to string) error {
	f.note(call{op: "commit", to: to})
	return f.maybeFail("commit")
}
func (f *fakeCustody) Discard(handle uint32) (bool, error) {
	f.note(call{op: "discard"})
	f.live--
	return true, nil
}
func (f *fakeCustody) Identity(name string) (string, bool, error) {
	f.note(call{op: "identity", name: name})
	return "win:1:2", true, nil
}
func (f *fakeCustody) Remove(name, receipt string) (bool, error) {
	f.note(call{op: "remove", name: name, receipt: receipt})
	return true, nil
}
func (f *fakeCustody) ReadBounded(name string, max int) ([]byte, bool, error) {
	f.note(call{op: "read", name: name})
	if f.readSize > max {
		// The real custody refuses on SIZE before reading. Absence is a
		// different answer and must not be substituted for it.
		return nil, false, Errf(CodeTooLarge)
	}
	if f.absent {
		return nil, false, nil
	}
	if f.readSize == 0 {
		return []byte("{}"), true, nil
	}
	return bytes.Repeat([]byte("j"), f.readSize), true, nil
}
func (f *fakeCustody) HashOwned(name, receipt string, size int64) (string, bool, error) {
	f.note(call{op: "hash", name: name, receipt: receipt})
	return strings.Repeat("a", 64), true, nil
}
func (f *fakeCustody) VerifyInstaller(name, receipt, sha, pub string, size int64) (string, error) {
	f.note(call{op: "verify", name: name, receipt: receipt})
	return "signed-by-expected-publisher", f.maybeFail("verify")
}
func (f *fakeCustody) RunInstaller(name, receipt, sha, pub string, size int64) (string, error) {
	f.note(call{op: "run", name: name, receipt: receipt})
	return "signed-by-expected-publisher", nil
}
func (f *fakeCustody) Close() error {
	f.note(call{op: "close"})
	f.closed = true
	// The session's own teardown releases whatever is left.
	f.live = 0
	return nil
}

func frame(kind byte, payload []byte) []byte {
	var header [5]byte
	binary.BigEndian.PutUint32(header[:4], uint32(len(payload)))
	header[4] = kind
	return append(header[:], payload...)
}

func request(t *testing.T, req Request) []byte {
	t.Helper()
	encoded, err := json.Marshal(req)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	return frame(KindJSON, encoded)
}

// bodies collects payload frames the last `run` produced, in order.
var bodies [][]byte

func run(t *testing.T, custody Custody, frames ...[]byte) ([]Reply, error) {
	t.Helper()
	bodies = nil
	var in bytes.Buffer
	for _, f := range frames {
		in.Write(f)
	}
	var out bytes.Buffer
	err := Serve(&in, &out, custody)
	var replies []Reply
	for out.Len() > 0 {
		kind, payload, readErr := ReadFrame(&out, MaxJournalBytes)
		if readErr != nil {
			t.Fatalf("reply frame: %v", readErr)
		}
		if kind != KindJSON {
			t.Fatalf("reply kind %#x", kind)
		}
		var reply Reply
		if err := json.Unmarshal(payload, &reply); err != nil {
			t.Fatalf("reply json: %v", err)
		}
		// A reply announcing bytes is followed by exactly that many.
		if reply.Bytes > 0 {
			bodyKind, body, bodyErr := ReadFrame(&out, MaxJournalBytes)
			if bodyErr != nil {
				t.Fatalf("payload frame: %v", bodyErr)
			}
			if bodyKind != KindBytes || len(body) != reply.Bytes {
				t.Fatalf("payload frame kind %#x len %d, announced %d", bodyKind, len(body), reply.Bytes)
			}
			bodies = append(bodies, body)
		}
		replies = append(replies, reply)
	}
	return replies, err
}

func TestHelloAndCleanClose(t *testing.T) {
	fake := &fakeCustody{}
	replies, err := run(t, fake, request(t, Request{Op: OpHello}))
	if err != nil {
		t.Fatalf("clean close must not be an error: %v", err)
	}
	if len(replies) != 1 || !replies[0].OK || replies[0].Version != ProtocolVersion {
		t.Fatalf("hello: %+v", replies)
	}
	// The session always releases its handles, including on a clean close.
	if fake.calls[len(fake.calls)-1].op != "close" {
		t.Fatalf("scope was not closed: %+v", fake.calls)
	}
}

func TestEveryOperationRequiresTheCapturedScope(t *testing.T) {
	for _, op := range []string{
		OpCustodyCreate, OpCustodySync, OpCustodyCommit, OpCustodyDiscard,
		OpScopeIdentity, OpScopeRemove, OpScopeRead, OpScopeHash,
		OpInstallVerify, OpInstallRun,
	} {
		fake := &fakeCustody{}
		replies, err := run(t, fake, request(t, Request{Op: op, Name: "a.exe", To: "b.exe"}))
		if err != nil {
			t.Fatalf("%s: %v", op, err)
		}
		if replies[0].OK || replies[0].Code != CodeNoScope {
			t.Fatalf("%s reached the platform without a scope: %+v", op, replies[0])
		}
		if len(fake.calls) != 1 || fake.calls[0].op != "close" {
			t.Fatalf("%s touched the platform: %+v", op, fake.calls)
		}
	}
}

func TestScopeIsCapturedOnce(t *testing.T) {
	fake := &fakeCustody{}
	open := Request{Op: OpScopeOpen, Root: `C:\data`, Component: "updates"}
	replies, err := run(t, fake, request(t, open), request(t, open))
	if err != nil {
		t.Fatalf("serve: %v", err)
	}
	if !replies[0].OK {
		t.Fatalf("first open refused: %+v", replies[0])
	}
	// Replacing the held scope would leave later requests acting through
	// handles their authority was never established against.
	if replies[1].OK || replies[1].Code != CodeProtocol {
		t.Fatalf("second open was accepted: %+v", replies[1])
	}
	if fake.opened != 1 {
		t.Fatalf("platform opened %d times", fake.opened)
	}
}

func TestNamesThatAreNotOneInertComponent(t *testing.T) {
	fake := &fakeCustody{}
	frames := [][]byte{request(t, Request{Op: OpScopeOpen, Root: `C:\d`, Component: "updates"})}
	bad := []string{`..\escape.exe`, "sub/dir.exe", "..", "", `C:\absolute.exe`, strings.Repeat("x", 121)}
	for _, name := range bad {
		frames = append(frames, request(t, Request{Op: OpScopeIdentity, Name: name}))
	}
	replies, err := run(t, fake, frames...)
	if err != nil {
		t.Fatalf("serve: %v", err)
	}
	for i, name := range bad {
		reply := replies[i+1]
		if reply.OK || reply.Code != CodeBadName {
			t.Fatalf("%q was not refused: %+v", name, reply)
		}
	}
	for _, c := range fake.calls {
		if c.op == "identity" {
			t.Fatalf("a refused name reached the platform: %q", c.name)
		}
	}
}

func TestRemoveWithoutAReceiptRemovesNothing(t *testing.T) {
	fake := &fakeCustody{}
	replies, err := run(t, fake,
		request(t, Request{Op: OpScopeOpen, Root: `C:\d`, Component: "updates"}),
		request(t, Request{Op: OpScopeRemove, Name: "relayium-1.0.0-1-00112233445566aa.exe"}),
	)
	if err != nil {
		t.Fatalf("serve: %v", err)
	}
	// A name is not authority, and the helper says so rather than deleting.
	if replies[1].OK || replies[1].Code != CodeIdentity {
		t.Fatalf("remove without a receipt: %+v", replies[1])
	}
	for _, c := range fake.calls {
		if c.op == "remove" {
			t.Fatal("a receiptless remove reached the platform")
		}
	}
}

func TestInstallRunRequiresAPinEvenWhenVerifyDoesNot(t *testing.T) {
	fake := &fakeCustody{}
	base := Request{
		Op: OpInstallRun, Name: "s.exe", Receipt: "win:1:2",
		SHA256: strings.Repeat("a", 64), Size: 10, Consent: "granted",
	}
	replies, err := run(t, fake,
		request(t, Request{Op: OpScopeOpen, Root: `C:\d`, Component: "updates"}),
		request(t, base),
	)
	if err != nil {
		t.Fatalf("serve: %v", err)
	}
	// Launching without an expectation to compare against is the one thing that
	// stays refused: classification is not permission.
	if replies[1].OK || replies[1].Code != CodeNoPin {
		t.Fatalf("install.run without a pin: %+v", replies[1])
	}
	for _, c := range fake.calls {
		if c.op == "run" {
			t.Fatal("install.run reached the platform without a pin")
		}
	}
}

func TestInstallRequiresAPinAndConsent(t *testing.T) {
	base := Request{
		Op: OpInstallVerify, Name: "s.exe", Receipt: "win:1:2",
		SHA256: strings.Repeat("a", 64), Size: 10,
	}
	fake := &fakeCustody{}
	noPin := base
	withPin := base
	withPin.Publisher = "CN=Relayium"
	runNoConsent := withPin
	runNoConsent.Op = OpInstallRun
	runWrongConsent := runNoConsent
	runWrongConsent.Consent = "GRANTED"
	replies, err := run(t, fake,
		request(t, Request{Op: OpScopeOpen, Root: `C:\d`, Component: "updates"}),
		request(t, noPin),
		request(t, runNoConsent),
		request(t, runWrongConsent),
		request(t, withPin),
	)
	if err != nil {
		t.Fatalf("serve: %v", err)
	}
	// `install.verify` without a pin is allowed: it CLASSIFIES and never
	// launches, which is how a host with no certificate provisioned can still
	// tell an unsigned artifact from a signed one. The platform decides the
	// verdict; the dispatcher's job is only to let the question through.
	if !replies[1].OK {
		t.Fatalf("pinless verify was refused at the protocol layer: %+v", replies[1])
	}
	if replies[2].Code != CodeCancelled || replies[3].Code != CodeCancelled {
		t.Fatalf("install ran without consent: %+v %+v", replies[2], replies[3])
	}
	// Only the verify — which never creates a process — reached the platform.
	for _, c := range fake.calls {
		if c.op == "run" {
			t.Fatal("install.run reached the platform without consent")
		}
	}
	if !replies[4].OK || replies[4].Verdict != "signed-by-expected-publisher" {
		t.Fatalf("pinned verify: %+v", replies[4])
	}
}

func TestWriteCarriesExactlyOnePayloadFrame(t *testing.T) {
	fake := &fakeCustody{}
	replies, err := run(t, fake,
		request(t, Request{Op: OpScopeOpen, Root: `C:\d`, Component: "updates"}),
		request(t, Request{Op: OpCustodyWrite, Handle: 7, Bytes: 4}),
		frame(KindBytes, []byte("abcd")),
		request(t, Request{Op: OpCustodyWrite, Handle: 7, Bytes: 4}),
		frame(KindBytes, []byte("ab")),
	)
	if err == nil {
		t.Fatal("a payload frame that disagrees with its header must end the session")
	}
	if !replies[1].OK || fake.calls[1].chunkLen != 4 {
		t.Fatalf("first write: %+v %+v", replies[1], fake.calls)
	}
	if replies[2].Code != CodeProtocol {
		t.Fatalf("mismatched payload: %+v", replies[2])
	}
}

func TestOversizedRequestIsRefusedBeforeAllocation(t *testing.T) {
	var in bytes.Buffer
	var header [5]byte
	binary.BigEndian.PutUint32(header[:4], 1<<30)
	header[4] = KindJSON
	in.Write(header[:])
	// No payload follows: if the bound were checked after allocating, this would
	// have asked for a gigabyte first.
	var out bytes.Buffer
	if err := Serve(&in, &out, &fakeCustody{}); err == nil {
		t.Fatal("an oversized frame must end the session")
	}
}

func TestTruncationIsNotACleanClose(t *testing.T) {
	var in bytes.Buffer
	in.Write(request(t, Request{Op: OpHello})[:6])
	var out bytes.Buffer
	if err := Serve(&in, &out, &fakeCustody{}); err == nil {
		t.Fatal("a truncated frame must be an error, not EOF")
	}
}

func TestUnknownFieldsAndOpsAreRefused(t *testing.T) {
	fake := &fakeCustody{}
	var in bytes.Buffer
	in.Write(frame(KindJSON, []byte(`{"op":"hello","surprise":1}`)))
	var out bytes.Buffer
	if err := Serve(&in, &out, fake); err == nil {
		t.Fatal("an unknown field must end the session rather than be ignored")
	}

	replies, err := run(t, &fakeCustody{},
		request(t, Request{Op: OpScopeOpen, Root: `C:\d`, Component: "updates"}),
		request(t, Request{Op: "custody.launch"}),
	)
	if err != nil {
		t.Fatalf("serve: %v", err)
	}
	if replies[1].OK || replies[1].Code != CodeProtocol {
		t.Fatalf("unknown op: %+v", replies[1])
	}
}

func TestRepliesArriveInOrderForPipelinedRequests(t *testing.T) {
	fake := &fakeCustody{}
	replies, err := run(t, fake,
		request(t, Request{Op: OpHello}),
		request(t, Request{Op: OpScopeOpen, Root: `C:\d`, Component: "updates"}),
		request(t, Request{Op: OpScopeIdentity, Name: "a.exe"}),
		request(t, Request{Op: OpScopeRead, Name: "candidate.json", Max: 1024}),
	)
	if err != nil {
		t.Fatalf("serve: %v", err)
	}
	if len(replies) != 4 || replies[0].Version != ProtocolVersion || replies[2].Receipt != "win:1:2" ||
		!replies[3].Present || replies[3].Bytes != 2 {
		t.Fatalf("pipelined replies out of step: %+v", replies)
	}
}

func TestPlatformFailuresBecomeClosedSetCodes(t *testing.T) {
	fake := &fakeCustody{failOp: "create", failErr: CodeExists}
	replies, err := run(t, fake,
		request(t, Request{Op: OpScopeOpen, Root: `C:\d`, Component: "updates"}),
		request(t, Request{Op: OpCustodyCreate, Name: "a.exe"}),
	)
	if err != nil {
		t.Fatalf("serve: %v", err)
	}
	if replies[1].OK || replies[1].Code != CodeExists {
		t.Fatalf("platform code not surfaced: %+v", replies[1])
	}

	// An error the platform did not classify must not leak its text.
	opaque := &fakeCustody{}
	opaque.failOp = "create"
	opaque.failErr = ""
	replies, err = run(t, opaque,
		request(t, Request{Op: OpScopeOpen, Root: `C:\d`, Component: "updates"}),
		request(t, Request{Op: OpCustodyCreate, Name: "a.exe"}),
	)
	if err != nil {
		t.Fatalf("serve: %v", err)
	}
	if replies[1].Code != CodeIO {
		t.Fatalf("an unclassified failure was not mapped to %q: %+v", CodeIO, replies[1])
	}
	// And nothing of the underlying error reached the wire.
	encoded, _ := json.Marshal(replies[1])
	if strings.Contains(string(encoded), "AppData") || strings.Contains(string(encoded), "CreateFileW") {
		t.Fatalf("the platform error text leaked to the host: %s", encoded)
	}
}

func TestHandlesAreReleasedWithoutDeletingAndDoNotAccumulate(t *testing.T) {
	fake := &fakeCustody{}
	frames := [][]byte{request(t, Request{Op: OpScopeOpen, Root: `C:\d`, Component: "updates"})}
	// Twenty write-and-publish cycles, which is what repeated journal commits
	// and repeated downloads look like. Each releases before the next creates.
	for i := 0; i < 20; i++ {
		frames = append(frames,
			request(t, Request{Op: OpCustodyCreate, Name: "candidate.json.aabbccddeeff.tmp"}),
			request(t, Request{Op: OpCustodyCommit, Handle: uint32(i + 1), To: "candidate.json"}),
			request(t, Request{Op: OpCustodyClose, Handle: uint32(i + 1)}),
		)
	}
	replies, err := run(t, fake, frames...)
	if err != nil {
		t.Fatalf("serve: %v", err)
	}
	for i, reply := range replies {
		if !reply.OK {
			t.Fatalf("cycle reply %d refused: %+v", i, reply)
		}
	}
	if fake.peak > 1 {
		t.Fatalf("handles accumulated across cycles: peak %d", fake.peak)
	}
	// Release is NOT a delete: nothing was discarded in any of those cycles.
	for _, c := range fake.calls {
		if c.op == "discard" {
			t.Fatal("closing a handle deleted its object")
		}
	}
}

func TestOpenHandlesAreBounded(t *testing.T) {
	fake := &fakeCustody{}
	frames := [][]byte{request(t, Request{Op: OpScopeOpen, Root: `C:\d`, Component: "updates"})}
	for i := 0; i < MaxOpenHandles+2; i++ {
		frames = append(frames, request(t, Request{Op: OpCustodyCreate, Name: "a.exe"}))
	}
	replies, err := run(t, fake, frames...)
	if err != nil {
		t.Fatalf("serve: %v", err)
	}
	for i := 1; i <= MaxOpenHandles; i++ {
		if !replies[i].OK {
			t.Fatalf("handle %d refused early: %+v", i, replies[i])
		}
	}
	for i := MaxOpenHandles + 1; i < len(replies); i++ {
		if replies[i].OK || replies[i].Code != CodeHandles {
			t.Fatalf("handle %d was not bounded: %+v", i, replies[i])
		}
	}
	// Refused, never evicted: no live handle was closed to make room.
	for _, c := range fake.calls {
		if c.op == "release" || c.op == "discard" {
			t.Fatal("the bound evicted a live handle instead of refusing")
		}
	}
}

func TestAnUnknownHandleIsRefused(t *testing.T) {
	fake := &fakeCustody{}
	replies, err := run(t, fake,
		request(t, Request{Op: OpScopeOpen, Root: `C:\d`, Component: "updates"}),
		request(t, Request{Op: OpCustodyClose, Handle: 99}),
		request(t, Request{Op: OpCustodyDiscard, Handle: 99}),
	)
	if err != nil {
		t.Fatalf("serve: %v", err)
	}
	for _, reply := range replies[1:] {
		if reply.OK || reply.Code != CodeNoHandle {
			t.Fatalf("an unissued handle was accepted: %+v", reply)
		}
	}
}

func TestEveryExitReleasesTheSession(t *testing.T) {
	// Clean close.
	clean := &fakeCustody{}
	if _, err := run(t, clean, request(t, Request{Op: OpHello})); err != nil {
		t.Fatalf("clean: %v", err)
	}
	if !clean.closed {
		t.Fatal("a clean close did not release the session")
	}
	// Protocol error mid-stream, with a handle outstanding.
	broken := &fakeCustody{}
	var in bytes.Buffer
	in.Write(request(t, Request{Op: OpScopeOpen, Root: `C:\d`, Component: "updates"}))
	in.Write(request(t, Request{Op: OpCustodyCreate, Name: "a.exe"}))
	in.Write(request(t, Request{Op: OpHello})[:4])
	var out bytes.Buffer
	if err := Serve(&in, &out, broken); err == nil {
		t.Fatal("a truncated frame must end the session")
	}
	if !broken.closed || broken.live != 0 {
		t.Fatalf("an aborted session leaked handles: closed=%v live=%d", broken.closed, broken.live)
	}
}

var _ io.Reader = (*bytes.Buffer)(nil)

func TestTheRecordChannelFitsTheCoreJournal(t *testing.T) {
	// The composition that was broken: the core reads with
	// `MAX_JOURNAL_BYTES = 512 KiB`, and the helper refused anything over the
	// 16 KiB control-frame limit — before even looking for the file. Every
	// startup on a default configuration failed, whatever the record's size.
	if MaxJournalBytes != 512*1024 {
		t.Fatalf("MaxJournalBytes is %d; the core's MAX_JOURNAL_BYTES is 512 KiB", MaxJournalBytes)
	}

	// A tiny record requested with the core's real budget.
	fake := &fakeCustody{}
	replies, err := run(t, fake,
		request(t, Request{Op: OpScopeOpen, Root: `C:\d`, Component: "updates"}),
		request(t, Request{Op: OpScopeRead, Name: "candidate.json", Max: MaxJournalBytes}),
	)
	if err != nil {
		t.Fatalf("serve: %v", err)
	}
	if !replies[1].OK || !replies[1].Present {
		t.Fatalf("a small record refused under the core's budget: %+v", replies[1])
	}
	if len(bodies) != 1 || string(bodies[0]) != "{}" {
		t.Fatalf("record body %q", bodies)
	}

	// And a record far larger than any control frame round-trips whole.
	big := &fakeCustody{readSize: 32 * 1024}
	replies, err = run(t, big,
		request(t, Request{Op: OpScopeOpen, Root: `C:\d`, Component: "updates"}),
		request(t, Request{Op: OpScopeRead, Name: "candidate.json", Max: MaxJournalBytes}),
	)
	if err != nil {
		t.Fatalf("serve: %v", err)
	}
	if !replies[1].Present || replies[1].Bytes != 32*1024 {
		t.Fatalf("32 KiB record: %+v", replies[1])
	}
	if len(bodies) != 1 || len(bodies[0]) != 32*1024 {
		t.Fatalf("body length %d", len(bodies[0]))
	}
}

func TestOversizedAndAbsentRecordsAreDifferentAnswers(t *testing.T) {
	// A record bigger than the caller's budget is an ERROR. Reporting it as
	// absent would let the core treat an unreadable record as "nothing staged"
	// and overwrite a real candidate.
	oversized := &fakeCustody{readSize: MaxJournalBytes + 1}
	replies, err := run(t, oversized,
		request(t, Request{Op: OpScopeOpen, Root: `C:\d`, Component: "updates"}),
		request(t, Request{Op: OpScopeRead, Name: "candidate.json", Max: MaxJournalBytes}),
	)
	if err != nil {
		t.Fatalf("serve: %v", err)
	}
	if replies[1].OK || replies[1].Code != CodeTooLarge {
		t.Fatalf("oversized record: %+v", replies[1])
	}
	if replies[1].Present {
		t.Fatal("an oversized record was reported as present-and-fine")
	}

	absent := &fakeCustody{absent: true}
	replies, err = run(t, absent,
		request(t, Request{Op: OpScopeOpen, Root: `C:\d`, Component: "updates"}),
		request(t, Request{Op: OpScopeRead, Name: "candidate.json", Max: MaxJournalBytes}),
	)
	if err != nil {
		t.Fatalf("serve: %v", err)
	}
	if !replies[1].OK || replies[1].Present || replies[1].Bytes != 0 {
		t.Fatalf("absent record: %+v", replies[1])
	}
	if len(bodies) != 0 {
		t.Fatal("an absent record produced a payload frame")
	}
}

func TestAReadBudgetBeyondTheRecordLimitIsRefusedNotClamped(t *testing.T) {
	fake := &fakeCustody{}
	replies, err := run(t, fake,
		request(t, Request{Op: OpScopeOpen, Root: `C:\d`, Component: "updates"}),
		request(t, Request{Op: OpScopeRead, Name: "candidate.json", Max: MaxJournalBytes + 1}),
		request(t, Request{Op: OpScopeRead, Name: "candidate.json", Max: 0}),
	)
	if err != nil {
		t.Fatalf("serve: %v", err)
	}
	for _, reply := range replies[1:] {
		if reply.OK || reply.Code != CodeTooLarge {
			t.Fatalf("budget was not refused: %+v", reply)
		}
	}
	// Refused before the platform was asked, and never silently reduced.
	for _, c := range fake.calls {
		if c.op == "read" {
			t.Fatal("an out-of-range budget reached the platform")
		}
	}
}

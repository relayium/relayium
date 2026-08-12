package account

import (
	"os"
	"strings"
	"testing"
)

// What ends a joined pair room, asserted against the SOURCE that describes it.
//
// WHY A TEXT GUARD AT ALL. Everything else in this package is checked by
// behaviour, and behaviour is the better check. This one cannot be: the claim at
// stake is not "the code does X" but "the code SAYS it does X", and the two came
// apart three times in three consecutive checkpoints without a single test
// failing.
//
//	before completion existed   the help said "no completion lifecycle"
//	after it existed            the comments said "no receiver spends it"
//	after the receiver spent it the comments said "an operator or account
//	                            deletion", naming a route that has never existed
//
// Each sentence was true when it was written and false one commit later, and
// nothing failed, because a comment is not compiled against the thing it
// describes. The cost is not tidiness: pairroom.go's invariants are what the next
// reader reasons from when deciding whether this feature can be turned on, and
// two of those three stale sentences would have made them decide NO for a reason
// that had stopped being true.
//
// THE RULE THIS PINS (docs/protocol/relayium-pair-room-v1.md §2). A joined room's
// ciphertext leaves in exactly three ways, none of which is a clock:
//
//  1. the RECEIVER completes it              (pairroom_complete.go)
//  2. the OWNING ACCOUNT releases the room   (pairroom_owner.go)
//  3. the account is deleted                 (purge)
//
// There is no fourth. In particular there is no admin or operator route that
// removes one — grep the mux: the only two pair-room routes are the account's own
// (handlers.go) — and no sweep ages one out. Text claiming otherwise sends a
// reader looking for a control nobody built.
//
// WHAT THIS DELIBERATELY DOES NOT DO. It does not require a phrasing. Banning the
// sentences that were actually wrong, and requiring that each of the three causes
// is named SOMEWHERE in the file that owns the rule, leaves every writer free to
// say it their own way — which matters, because a guard that dictates prose gets
// worked around rather than read.
func TestPairRoomLifecycleCommentsNameEveryCauseAndInventNone(t *testing.T) {
	for _, file := range lifecycleClaimFiles {
		src := readClaimSource(t, file)
		for _, stale := range staleLifecycleClaims {
			if idx := strings.Index(src, stale.text); idx >= 0 {
				t.Errorf("%s:%d says %q.\n%s\n"+
					"A joined room's ciphertext ends when its receiver completes it\n"+
					"(pairroom_complete.go), when the owner releases the room\n"+
					"(pairroom_owner.go), or when the account is deleted — and never on a\n"+
					"clock.", file, lineOf(src, idx), stale.text, stale.why)
			}
		}
	}
}

// The positive half, on the one file that owns the rule. Banning stale sentences
// keeps a comment from being wrong; it cannot keep one from going quiet, and a
// silent invariant list is how the owner's release becomes undiscoverable again.
func TestPairRoomInvariantsNameAllThreeExits(t *testing.T) {
	src := readClaimSource(t, "pairroom.go")
	for _, exit := range []struct{ token, why string }{
		{"pairroom_complete.go", "the receiver's completion — the exit that is not always reachable (protocol §7.6)"},
		{"pairroom_owner.go", "the owner's release — the exit that always exists"},
		{"deleted", "account deletion — the last exit"},
	} {
		if !strings.Contains(src, exit.token) {
			t.Errorf("pairroom.go no longer mentions %s (%s).\n"+
				"Invariant 5 is the whole storage argument for this feature; a reader who\n"+
				"cannot find one of its three exits from the file that states it will\n"+
				"conclude the exit does not exist.", exit.token, exit.why)
		}
	}
	// No clock, said out loud. Invariant 5 IS this sentence; a version of the file
	// that stopped claiming it would most likely be one where somebody added a
	// backstop deadline, which is the exact change this project has already
	// reverted once (see pairRoomNoDeadline).
	if !strings.Contains(src, "no clock") && !strings.Contains(src, "NO deadline") {
		t.Error("pairroom.go no longer states that a joined room is on no clock.\n" +
			"That is invariant 5. If a deadline was genuinely introduced, the protocol\n" +
			"(docs/protocol/relayium-pair-room-v1.md §2, §7.5) moves first and this\n" +
			"guard is rewritten deliberately rather than deleted.")
	}
}

// The files that describe the lifecycle to a reader. Not every file that touches
// a pair room — only the ones somebody opens to find out what the rule IS, which
// is where a stale sentence does its damage.
var lifecycleClaimFiles = []string{
	"pairroom.go",
	"pairroom_complete.go",
	"pairroom_owner.go",
	"service.go",
	"handlers.go",
}

// Every entry here was real text in this repository, not a hypothetical. That is
// the bar for adding one: a sentence that was true, shipped, and became false.
var staleLifecycleClaims = []struct{ text, why string }{
	{
		"an operator or account deletion",
		"No operator route removes a pair room. The only two pair-room routes are\n" +
			"the account's own GET /api/pair-rooms and DELETE /api/pair-rooms/{id}.",
	},
	{
		"or an operator deletes it",
		"Same: there is no such route, and there never was one.",
	},
	{
		"ended only by the account or an operator",
		"The receiver ends one by completing it, and the account ends one by\n" +
			"releasing it. Neither is an operator action.",
	},
	{
		"no receiver spends it",
		"The Web receiver posts completions (web/src/lib/preupload-receive.svelte.ts).",
	},
	{
		"the Web receiver does not post",
		"It does. What it cannot do is post one from a browser that hands the bytes\n" +
			"off rather than writing them (protocol §7.6).",
	},
	{
		"no completion lifecycle",
		"pairroom_complete.go is that lifecycle.",
	},
	{
		"has no way to see and no way to release",
		"GET /api/pair-rooms and DELETE /api/pair-rooms/{id} are exactly those two\n" +
			"ways. (Describing the state BEFORE they existed is fine — put it in the\n" +
			"past tense so it cannot be read as current.)",
	},
	{
		"stored until the account is deleted",
		"Account deletion is the LAST exit, not the only one: the owner can release\n" +
			"a room, and a receiver that writes files to disk completes one.",
	},
}

func readClaimSource(t *testing.T, file string) string {
	t.Helper()
	src, err := os.ReadFile(file)
	if err != nil {
		t.Fatalf("read %s: %v", file, err)
	}
	return string(src)
}

// lineOf turns a byte offset into a 1-based line number, so a failure names a
// place to go rather than a string to hunt for.
func lineOf(src string, idx int) int {
	return 1 + strings.Count(src[:idx], "\n")
}

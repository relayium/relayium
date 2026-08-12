package main

import (
	"os"
	"strings"
	"testing"
)

// The -enable-preupload flag's help is the one description of this feature an
// operator reads at the moment they decide whether to turn it on, and it is the
// only one they read without opening the source. That makes it the surface where
// a stale claim costs the most: an operator who is told the server has NO way to
// end a joined room's storage reasons about the flag differently than one who is
// told the way exists but nothing spends it yet.
//
// Both of those were true at different commits, which is exactly why this guard
// exists. Before the completion capability was built (pairroom_complete.go), the
// help said a joined room's ciphertext had "no completion lifecycle". That
// sentence survived the commit that built one, and nothing failed — help strings
// are not compiled against the thing they describe, so they rot silently.
//
// A source-reading guard, and it has to be: the flags are declared inside main(),
// so no test can register them and read the help back off the flag package. This
// follows the same shape as account/admin_i18n_test.go, which reads its own
// source for the same reason.
func TestPreUploadFlagHelpDoesNotClaimThereIsNoCompletionLifecycle(t *testing.T) {
	line := preUploadFlagDeclaration(t)

	// The ban is conditional on the default, and the condition is the point. This
	// claim is only WRONG while the capability exists and the flag ships off; a
	// deployment default of true would be a different feature state with different
	// honest help, so rather than quietly keep enforcing a rule written for the
	// old state, fail and make someone re-read both.
	if !strings.Contains(line, `envBool("RELAYIUM_ENABLE_PREUPLOAD", false)`) {
		t.Fatalf("-enable-preupload no longer defaults to false.\n"+
			"That is a rollout decision, not a typo, so this guard will not quietly\n"+
			"keep enforcing a rule written for the default-off state. Re-read the\n"+
			"flag help against what the server actually does now, then update this\n"+
			"test to match the new state.\ndeclaration: %s", line)
	}

	// The exact stale sentence, banned by the letter of it. The capability is
	// built: a sender records a verifier at finalize and POST /api/files/{id}/
	// complete spends it (server/account/pairroom_complete.go). Saying it does
	// not exist misdescribes the server an operator is being asked to configure.
	if strings.Contains(line, "no completion lifecycle") {
		t.Errorf("-enable-preupload help still claims a joined room has \"no completion lifecycle\".\n"+
			"That was true before server/account/pairroom_complete.go existed and is\n"+
			"false now: the completion capability is built, mounted and spent by the\n"+
			"Web receiver. What is still open is that most receivers cannot complete\n"+
			"at all, that what becomes of a room nobody completes is undecided, and\n"+
			"that the rollout gates are open — say that instead.\nhelp: %s", line)
	}

	// The SAME rot, one commit later. "Built but nobody spends it" was true from
	// the commit that added pairroom_complete.go until the Web receiver started
	// posting completions (web/src/lib/preupload-receive.svelte.ts), and it is
	// false now. It is the more dangerous of the two stale sentences, because it
	// understates rather than overstates: an operator told that nothing ever ends
	// a joined room will not think to ask which receivers can end one and which
	// cannot — and that distinction is the whole shape of the storage commitment
	// they are being asked to take on (docs/protocol/relayium-pair-room-v1.md
	// §7.6: only a browser that commits files to disk itself completes at all).
	for _, stale := range []string{"no receiver spends it", "no receiver spends one"} {
		if strings.Contains(line, stale) {
			t.Errorf("-enable-preupload help still claims %q.\n"+
				"That was true before the Web receiver posted completions and is false\n"+
				"now. What is still open is that only a receiver whose browser commits\n"+
				"files to disk can complete at all, and that the rooms nobody completes\n"+
				"end when their owner releases them and not otherwise — say that\n"+
				"instead.\nhelp: %s", stale, line)
		}
	}

	// The THIRD version of the same rot, and the one that outlived the release
	// that falsified it. While the owner had no view of this storage, "stored
	// until the account is deleted" was the literal truth and the help said so.
	// It stopped being true when GET /api/pair-rooms and DELETE
	// /api/pair-rooms/{id} shipped (account/pairroom_owner.go): the account can
	// see every joined room it is holding and release one, transactionally and
	// irreversibly.
	//
	// This is the most expensive of the three to leave standing, because it is
	// the sentence an operator budgets against. Told the only exit is deleting
	// the customer's account, a reasonable operator concludes the feature cannot
	// be run at all — a false NO on a rollout question, from help that was
	// accurate two commits ago.
	for _, stale := range []string{
		"stored until the account is deleted",
		"can still be stored until the account is deleted",
		"only an operator",
		"an operator or account deletion",
	} {
		if strings.Contains(line, stale) {
			t.Errorf("-enable-preupload help still claims %q.\n"+
				"An authenticated owner can list joined pair-room storage and release a\n"+
				"whole room (GET /api/pair-rooms, DELETE /api/pair-rooms/{id},\n"+
				"server/account/pairroom_owner.go), so account deletion is not the last\n"+
				"exit and no operator route removes one at all. Say the three real\n"+
				"causes instead: receiver completion, owner release, account deletion.\n"+
				"help: %s", stale, line)
		}
	}

	// No clock, in either direction. §2's rule is that a joined room has no
	// expiry of any kind, and neither §7's completion nor §8's release is one —
	// so help that describes this storage as timed would be describing a server
	// that does not exist, and would hide the exact commitment the reader opened
	// -h to size.
	for _, timer := range []string{
		"expires after",
		"auto-expire",
		"automatically expire",
		"fallback expiry",
		"retention period",
	} {
		if strings.Contains(line, timer) {
			t.Errorf("-enable-preupload help says %q, which would mean a joined room is on a\n"+
				"clock. It is not: nothing the server runs ever ends one (pairroom.go\n"+
				"invariant 5). If a timer was genuinely added, that is a protocol change\n"+
				"and docs/protocol/relayium-pair-room-v1.md §2 and §7.5 have to move\n"+
				"first.\nhelp: %s", timer, line)
		}
	}

	// The other direction of the same rot, and the reason this guard is more than
	// a banned-substring list: help that drops the pointer stops being checkable
	// against anything. Naming the files that implement the two exits is what
	// lets the next reader — human or this test — find out whether the sentence
	// around it is still true.
	//
	// BOTH are required, not either. They answer different halves of the
	// operator's question: pairroom_complete.go is the exit the RECEIVER reaches
	// and cannot always reach (§7.6), and pairroom_owner.go is the one the
	// ACCOUNT always can. Help naming only the first describes a commitment with
	// no manual way out; naming only the second buries the fact that most rooms
	// end without anybody doing anything.
	for _, pointer := range []struct{ ref, why string }{
		{"pairroom_complete.go", "the receiver's exit"},
		{"pairroom_owner.go", "the owner's release, which is the only exit that always exists"},
	} {
		if !strings.Contains(line, pointer.ref) {
			t.Errorf("-enable-preupload help no longer points at %s (%s).\n"+
				"The help describes a storage commitment whose exits are those files;\n"+
				"without the pointer an operator cannot check the claim, and neither\n"+
				"can this test.", pointer.ref, pointer.why)
		}
	}

	// The route, spelled out, because it is the actionable half. A file path
	// tells an operator where to READ; the endpoint tells them what an account
	// can actually DO, which is the answer to "how do I get this storage back".
	if !strings.Contains(line, "/api/pair-rooms") {
		t.Errorf("-enable-preupload help no longer names /api/pair-rooms.\n" +
			"That pair of routes is what turns \"a room nobody completes waits for\n" +
			"its owner\" from a warning into something the operator can act on.")
	}

	// Who CANNOT complete is the shape of the commitment, not a footnote: the
	// browsers without File System Access are most of the web, so an operator
	// told only that "the receiver completes it" will size this at roughly zero
	// and be wrong (docs/protocol/relayium-pair-room-v1.md §7.6).
	if !strings.Contains(line, "Safari") {
		t.Errorf("-enable-preupload help no longer names the receivers that cannot\n" +
			"complete. Only a browser that writes files to disk itself can spend a\n" +
			"completion, so Firefox, Safari and every phone save normally and complete\n" +
			"nothing — that class is the storage commitment, and dropping it makes the\n" +
			"help read as though completion is the ordinary case.")
	}

	// Every file the help sends an operator to must be a file they can open. A
	// dangling pointer in operator-facing help is the same failure as the stale
	// sentence — text that used to be true about a layout that has since moved.
	for _, ref := range []string{
		"account/pairroom.go",
		"account/pairroom_complete.go",
		"account/pairroom_owner.go",
	} {
		if !strings.Contains(line, ref) {
			continue
		}
		if _, err := os.Stat(ref); err != nil {
			t.Errorf("-enable-preupload help points at %s, which does not exist: %v", ref, err)
		}
	}

	// Default-off is the single most consequential fact in this help — it is the
	// answer to the question the operator opened -h to ask — so it is required
	// explicitly rather than left to be inferred from the prose around it.
	if !strings.Contains(line, "default OFF") {
		t.Errorf("-enable-preupload help no longer states \"default OFF\" while the flag\n" +
			"still defaults to false. An operator reading -h must not have to infer\n" +
			"the default from the surrounding prose.")
	}
}

// The startup log is the SECOND thing an operator reads about this feature, and
// the only one they read after deciding — it lands in the journal of a server
// that is already accepting rooms. It rots exactly like the flag help and for
// the same reason (a string is not compiled against what it describes), so it
// gets the same guard.
//
// The two are not redundant. The help answers "should I turn this on"; the log
// answers "what did I just turn on", to a reader who has no -h in front of them
// and, months later, no memory of it. A log that names only the receiver's exit
// leaves an operator watching storage grow with no idea that the account itself
// can hand it back.
func TestPreUploadEnabledLogNamesEveryWayAJoinedRoomEnds(t *testing.T) {
	line := preUploadEnabledLog(t)

	// All three causes, and nothing that implies a fourth. This is the whole
	// lifecycle of a joined room's ciphertext (docs/protocol/
	// relayium-pair-room-v1.md §2), and each one is a different person's action:
	// the receiver's, the account's, and the account's again by deleting itself.
	for _, cause := range []struct{ token, why string }{
		{"complete", "the receiver's completion (pairroom_complete.go)"},
		{"/api/pair-rooms", "the owner's release (pairroom_owner.go)"},
		{"deleted", "account deletion, the last exit"},
	} {
		if !strings.Contains(line, cause.token) {
			t.Errorf("the pre-upload ENABLED log does not mention %s.\n"+
				"A joined room's ciphertext ends in exactly three ways and this log is\n"+
				"where an operator learns them.\nlog: %s", cause.why, line)
		}
	}

	// The negative half, and it is the one that was wrong before: the log used to
	// say a room nobody completes "has no expiry" and stop there, which is true
	// and useless — it named the problem and not the control that answers it.
	for _, stale := range []string{
		"a room nobody completes has no expiry",
		"an operator or account deletion",
		"until the account is deleted, and nothing else",
	} {
		if strings.Contains(line, stale) {
			t.Errorf("the pre-upload ENABLED log still says %q.\n"+
				"The owner can list and release joined pair-room storage\n"+
				"(server/account/pairroom_owner.go), so a room nobody completes has an\n"+
				"end — it just is not a clock.\nlog: %s", stale, line)
		}
	}

	// Still no clock, said in the log too. If this ever needs to change, the
	// protocol moves first.
	if !strings.Contains(line, "clock") {
		t.Errorf("the pre-upload ENABLED log no longer says that nothing expires on a\n" +
			"clock. That is the property the whole storage commitment follows from\n" +
			"(pairroom.go invariant 5); an operator who assumes a retention window\n" +
			"will size this wrong in the one direction that costs money.")
	}
}

// preUploadEnabledLog returns the single source line that logs the feature being
// enabled at startup. Exactly one, for the same reason as the flag declaration:
// a guard reading one of two copies is worse than no guard.
func preUploadEnabledLog(t *testing.T) string {
	t.Helper()
	src, err := os.ReadFile("main.go")
	if err != nil {
		t.Fatalf("read main.go: %v", err)
	}
	var found []string
	for line := range strings.SplitSeq(string(src), "\n") {
		if strings.Contains(line, "pairing-code pre-upload: ENABLED") {
			found = append(found, strings.TrimSpace(line))
		}
	}
	if len(found) != 1 {
		t.Fatalf("want exactly 1 pre-upload ENABLED log line in main.go, found %d", len(found))
	}
	return found[0]
}

// preUploadFlagDeclaration returns the single source line that declares
// -enable-preupload.
//
// Insisting on EXACTLY one match rather than taking the first: two declarations
// would mean the flag is registered twice (a flag package panic at startup) or
// that this guard is reading a copy while the binary uses the other, and a guard
// that silently checks the wrong one of two strings is worse than no guard.
func preUploadFlagDeclaration(t *testing.T) string {
	t.Helper()
	src, err := os.ReadFile("main.go")
	if err != nil {
		t.Fatalf("read main.go: %v", err)
	}
	var found []string
	for line := range strings.SplitSeq(string(src), "\n") {
		if strings.Contains(line, `flag.Bool("enable-preupload"`) {
			found = append(found, strings.TrimSpace(line))
		}
	}
	if len(found) != 1 {
		t.Fatalf("want exactly 1 declaration of -enable-preupload in main.go, found %d", len(found))
	}
	return found[0]
}

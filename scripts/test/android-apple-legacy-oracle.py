#!/usr/bin/env python3
"""Compare the two halves of one Android ↔ Apple legacy round.

The comparison is made HERE and by neither participant. Each half writes down
what it independently observed — digests it computed over bytes it actually
held, the SAS its own handshake derived, the state its own model reached — and
this file decides whether those two accounts describe the same transfer.

A half that judged itself would pass its own bugs. That is not a hypothetical:
"the right number of bytes under the right name" is true for a receiver that
split a multi-file stream one byte off, and only a digest computed on each side
separately can tell the difference.
"""
import json
import sys


def load(path):
    with open(path, encoding="utf-8") as handle:
        return json.load(handle)


def fail(message):
    print(f"legacy-oracle: {message}", file=sys.stderr)
    sys.exit(1)


def require_finished(doc, which):
    """Refuse a record whose round did not finish.

    The owning shell checks this too, and that is not a reason to leave it out:
    this file is runnable on its own, it is the thing a person reaches for when
    a round is being re-examined by hand, and every check below is a comparison
    between two accounts that only mean anything if both halves got to the end.
    A record that stopped early can have the right SAS, an agreeing wire and
    simply no observations, and every comparison would then pass on absence.

    `is not True` rather than a truthiness test: the flag is written last and
    only on the success path, so anything that is not exactly the boolean —
    missing, null, false, a string — is a record that did not claim to finish.
    """
    value = doc.get("complete")
    if value is not True:
        fail(f"the {which} half's record is not from a finished round (complete={value!r})")


def require_all_verified(done, expected, direction):
    """Every file's chained digest verified, and one verdict per file.

    `all([])` is TRUE, so a receiver that emitted no DONE at all — because it
    never got the batch, or because the harness lost the callback — would pass a
    bare `all()`. The count is what makes this a check: one verdict per declared
    file, each of them exactly True.
    """
    if not isinstance(done, list):
        fail(f"{direction}: the receiving half reported no per-file verdicts at all "
             f"(done={done!r})")
    if len(done) != expected:
        fail(f"{direction}: {expected} file(s) were sent but {len(done)} chained-digest "
             f"verdict(s) came back")
    for index, verdict in enumerate(done):
        if verdict is not True:
            fail(f"{direction}: file {index}'s chained digest did not verify "
                 f"(verdict={verdict!r})")


def remote_terminal(apple):
    """Did the far half observe the peer acting on the connection, either way?

    Deliberately a disjunction. The refusal byte is queued and then the channel
    is closed and the peer connection disposed in the same turn, so it may never
    drain; the teardown that follows can land after the parent's completion
    marker has already released this half. Requiring either one specifically
    makes a correct round fail on timing, and neither distinguishes a deliberate
    act from a failure — that is what the app's own record is for.
    """
    return bool(apple.get("rejected") or apple.get("closed") or apple.get("remoteTeardown"))


def digests(entries):
    """name -> (size, sha256, path), refusing a list that names one file twice.

    The PATH is part of the value, not decoration. A batch that carries a folder
    declares one, the receiver has to rebuild the tree under it, and a receiver
    that FLATTENED the tree produces identical names, identical sizes and
    identical digests — so a comparison that ignored the path would pass the one
    defect a nested batch exists to catch.
    """
    out = {}
    for entry in entries or []:
        name = entry["name"]
        if name in out:
            fail(f"the same file name appears twice: {name}")
        out[name] = (int(entry["size"]), entry["sha256"], entry.get("path"))
    return out


def compare_batch(sender, receiver, direction):
    sent = digests(sender)
    got = digests(receiver)
    if not sent:
        fail(f"{direction}: the sending half reported no files at all")
    if sent.keys() != got.keys():
        fail(f"{direction}: sent {sorted(sent)} but received {sorted(got)}")
    for name, (size, sha, path) in sent.items():
        rsize, rsha, rpath = got[name]
        if size != rsize:
            fail(f"{direction}: {name} was sent as {size} bytes and received as {rsize}")
        if sha != rsha:
            fail(f"{direction}: {name} has digest {sha} on the sending side and {rsha} on the other")
        if path != rpath:
            fail(f"{direction}: {name} was sent at path {path!r} and received at {rpath!r}")
    # The boundaries this batch exists to cross, checked rather than assumed:
    # without them a round could pass on three small files and prove nothing
    # about fragmentation or an empty entry.
    if not any(size > 192 * 1024 for size, _, _ in sent.values()):
        fail(f"{direction}: no file crossed the 192 KiB logical chunk boundary")
    if not any(size == 0 for size, _, _ in sent.values()):
        fail(f"{direction}: no ZERO-byte file was in the batch")
    if len(sent) < 2:
        fail(f"{direction}: a single-entry batch cannot advance the file sequence across entries")


def main():
    android_path, apple_path, intent, mode, direction, adversarial = sys.argv[1:7]
    android = load(android_path)
    apple = load(apple_path)

    # Before anything is compared: two records that did not finish describe
    # nothing, and comparing them would pass on emptiness.
    require_finished(android, "Android")
    require_finished(apple, "Apple")

    # ── the connection itself ───────────────────────────────────────────────
    expected_wire = "LEGACY_FILES" if mode == "file" else "LEGACY_TEXT"
    if android.get("wire") != expected_wire:
        fail(f"the app negotiated {android.get('wire')}, not {expected_wire}")
    if android.get("canSendFiles") is not (mode == "file"):
        fail("the app's own file capability disagrees with the negotiated wire")
    if android.get("canSendMessages") is not (mode == "text"):
        fail("the app's own message capability disagrees with the negotiated wire")

    # The SAS is derived independently on each side from the commit-reveal
    # exchange. Two implementations agreeing on it is the one check that says
    # the key agreement itself matched, rather than only the framing above it.
    android_sas, apple_sas = android.get("sas"), apple.get("sas")
    if not android_sas or not apple_sas:
        fail(f"a half reported no SAS (android={android_sas!r} apple={apple_sas!r})")
    if android_sas != apple_sas:
        fail(f"the two implementations derived different verification codes: {android_sas} vs {apple_sas}")

    if intent == "minter" and not android.get("mintedCode"):
        fail("a minter round must have minted its code through the app")

    # ── the adversarial paths ───────────────────────────────────────────────
    if adversarial == "decline":
        # A decline is a COMPLETE in-band exchange: the peer was told at its
        # prompt and nothing is in flight, so the connection must survive it.
        if android.get("phaseAfterDecline") != "CONNECTED":
            fail("a decline must not end the connection")
        if apple.get("rejected") is not True:
            fail("the Apple half did not observe its batch being declined")
        # It also has to have STAYED — a half that observed the refusal and hung
        # up would satisfy everything else while destroying the thing the round
        # asserts, and it did exactly that once.
        #
        # "Stayed" is proved by the PARENT'S completion marker, not by watching
        # for a teardown. The marker means the app half returned while this one
        # was still alive; a teardown means only that a cleanup happened to land
        # before this process exited, which is a race the marker itself creates.
        if apple.get("peerHalfReturned") is not True:
            fail("the Apple half did not stay alive until the app half finished, so it cannot "
                 "show the connection outlived the refusal")
        return
    if adversarial == "cancel":
        # There is no abort barrier on this wire and the shipped sender does
        # not re-read a mid-stream REJECT, so the only cancel that means
        # anything also closes the connection.
        #
        # The Apple half sees a teardown and CANNOT tell a user's cancel from a
        # peer that died underneath one — `PlainPeer` sets no departure handler
        # at all, so both arrive as `peerConnectionFailed`. Every discriminating
        # fact is on the app's side, and all four are required together.
        if (android.get("progressBeforeCancel") or 0) <= 0:
            fail("the cancel did not land mid-transfer: no bytes had been durably received")
        if android.get("cancelIssued") is not True:
            fail("the app never issued the cancel this round is about")
        if android.get("finalPhase") != "ENDED":
            fail("a mid-transfer cancel must end a connection the sender would otherwise keep filling")
        if android.get("finalError") is not None:
            fail(f"the session ended with {android.get('finalError')!r}, which is a failure rather "
                 f"than a user's cancel")
        if android.get("savedAfterCancel") != 0:
            fail("a cancelled receive must not report a saved batch")
        # The far side must have observed SOMETHING terminal — but which one is
        # not this test's to dictate. The lane queues its `0xff` and then closes
        # and disposes the connection in the same turn, so the refusal may never
        # drain; waiting for the teardown instead races the parent's marker.
        # Either is real evidence the peer acted, neither is guaranteed. The
        # four facts above are what make it a CANCEL rather than a failure;
        # this only shows it reached the wire at all.
        if not remote_terminal(apple):
            fail("the Apple half observed no refusal and no teardown, so nothing shows the "
                 "cancel reached it at all")
        return
    if adversarial == "refuse-text":
        # Anchored on the APP, for the same reason: its own record is the only
        # place a refusal is guaranteed to be observable.
        if android.get("textRejected") is not True:
            fail("the app never refused the conversation this round is about")
        if android.get("finalPhase") != "ENDED":
            fail("refusing the only conversation on a connection must end it")
        if android.get("finalError") is not None:
            fail(f"the session ended with {android.get('finalError')!r}; a refusal is a decision, "
                 f"not a failure")
        if not remote_terminal(apple):
            fail("the Apple half observed no refusal and no teardown after the conversation was "
                 "refused")
        return
    # ── the ordinary rounds ─────────────────────────────────────────────────
    if mode == "file":
        if direction == "receive":
            # The Apple half is the SENDER here, so it has no accumulator and no
            # DONE verdicts of its own; what the app wrote is read back through
            # the provider and compared against what the Apple half hashed
            # before it sent.
            compare_batch(apple.get("sent"), android.get("received"), "apple → android")
        else:
            compare_batch(android.get("sent"), apple.get("received"), "android → apple")
            if apple.get("trailingBytes"):
                fail("bytes arrived past the manifest the app declared")
            require_all_verified(apple.get("done"), len(digests(android.get("sent"))),
                                 "android → apple")
        return

    # Messages, both directions on one connection — the one thing this wire
    # does carry both ways at once.
    for label, left, right in (
        ("android → apple", android.get("messageOut"), apple.get("messageIn")),
        ("apple → android", apple.get("messageOut"), android.get("messageIn")),
    ):
        if not left or not right:
            fail(f"{label}: a half reported no message digest")
        if left != right:
            fail(f"{label}: the message digests differ ({left} vs {right})")
    if apple.get("messageMatched") is False:
        fail("the Apple half decoded a different body than the app sent")


# ── the oracle's own negative evidence ──────────────────────────────────────
#
# A comparison that cannot fail is a comparison that proves nothing, and the
# ways this one could quietly stop comparing are all cheap to demonstrate: a
# digest that moved, a file that never arrived, a record whose round never
# finished, a SAS the two sides did not agree on. The acceptance runs this
# BEFORE its rounds, so a no-op oracle is caught here rather than by passing
# ten rounds against nothing.


def _self_test():
    import copy
    import tempfile

    good_android = {
        "complete": True, "wire": "LEGACY_FILES", "canSendFiles": True,
        "canSendMessages": False, "sas": "705955",
        "received": [
            {"name": "bulk.bin", "path": "tree-x/day2/bulk.bin", "size": 199_000,
             "sha256": "a" * 64},
            {"name": "empty.bin", "path": "tree-x/day1/empty/empty.bin", "size": 0,
             "sha256": "b" * 64},
            {"name": "small.bin", "path": None, "size": 1024, "sha256": "c" * 64},
        ],
    }
    good_apple = {
        "complete": True, "sas": "705955", "trailingBytes": 0,
        "sent": copy.deepcopy(good_android["received"]),
        "done": [True, True, True],
    }

    def run(android, apple, args=("joiner", "file", "receive", "")):
        with tempfile.TemporaryDirectory() as tmp:
            apaths = []
            for name, doc in (("android.json", android), ("apple.json", apple)):
                path = f"{tmp}/{name}"
                with open(path, "w", encoding="utf-8") as handle:
                    json.dump(doc, handle)
                apaths.append(path)
            argv = sys.argv
            try:
                sys.argv = ["oracle", *apaths, *args]
                main()
                return "passed"
            except SystemExit as exit_code:
                return "failed" if exit_code.code else "passed"
            finally:
                sys.argv = argv

    cases = []

    def case(name, android, apple, expect, args=("joiner", "file", "receive", "")):
        cases.append((name, run(android, apple, args), expect))

    case("an agreeing pair", good_android, good_apple, "passed")

    mutated = copy.deepcopy(good_android)
    mutated["received"][0]["sha256"] = "d" * 64
    case("one digest moved", mutated, good_apple, "failed")

    missing = copy.deepcopy(good_android)
    del missing["received"][1]
    case("a file never arrived", missing, good_apple, "failed")

    resized = copy.deepcopy(good_android)
    resized["received"][2]["size"] = 1023
    case("a size disagrees", resized, good_apple, "failed")

    flattened = copy.deepcopy(good_android)
    for received_entry in flattened["received"]:
        received_entry["path"] = None
    case("a receiver that flattened the tree", flattened, good_apple, "failed")

    moved = copy.deepcopy(good_android)
    moved["received"][0]["path"] = "somewhere-else/bulk.bin"
    case("a file rebuilt at the wrong path", moved, good_apple, "failed")

    no_boundary = copy.deepcopy(good_android)
    no_boundary["received"] = [{"name": "a.bin", "path": None, "size": 10, "sha256": "a" * 64},
                               {"name": "b.bin", "path": None, "size": 0, "sha256": "b" * 64}]
    small_apple = copy.deepcopy(good_apple)
    small_apple["sent"] = copy.deepcopy(no_boundary["received"])
    case("no file crossed the fragment boundary", no_boundary, small_apple, "failed")

    no_empty = copy.deepcopy(good_android)
    no_empty["received"][1]["size"] = 8
    no_empty_apple = copy.deepcopy(good_apple)
    no_empty_apple["sent"] = copy.deepcopy(no_empty["received"])
    case("no zero-byte file in the batch", no_empty, no_empty_apple, "failed")

    empty_record = {"complete": True, "wire": "LEGACY_FILES", "canSendFiles": True,
                    "canSendMessages": False, "sas": "705955"}
    case("a record with no observations at all", empty_record,
         {"complete": True, "sas": "705955"}, "failed")

    # A round that did not finish. Every field below it can be right — the wire,
    # the capabilities, the SAS, even a full set of digests — and the record
    # still describes a round that stopped early.
    for which, mutate in (
        ("the Android", lambda a, b: (dict(a, complete=False), b)),
        ("the Apple", lambda a, b: (a, dict(b, complete=False))),
    ):
        android_doc, apple_doc = mutate(good_android, good_apple)
        case(f"{which} half's round did not finish", android_doc, apple_doc, "failed")
    for which, key in (("the Android", "android"), ("the Apple", "apple")):
        android_doc = {k: v for k, v in good_android.items() if not (key == "android" and k == "complete")}
        apple_doc = {k: v for k, v in good_apple.items() if not (key == "apple" and k == "complete")}
        case(f"{which} half never wrote a completion flag", android_doc, apple_doc, "failed")
    truthy_not_true = dict(good_apple, complete="true")
    case("a completion flag that is merely truthy", good_android, truthy_not_true, "failed")

    # ── the per-file chained-digest verdicts, on an android → apple round ────
    send_android = {
        "complete": True, "wire": "LEGACY_FILES", "canSendFiles": True,
        "canSendMessages": False, "sas": "705955",
        "sent": copy.deepcopy(good_android["received"]),
    }
    send_apple = {
        "complete": True, "sas": "705955", "trailingBytes": 0,
        "received": copy.deepcopy(good_android["received"]),
        "done": [True, True, True],
    }
    send_args = ("joiner", "file", "send", "")
    case("an agreeing send", send_android, send_apple, "passed", send_args)
    case("no chained-digest verdicts at all",
         send_android, dict(send_apple, done=[]), "failed", send_args)
    case("the verdict list is missing",
         send_android, {k: v for k, v in send_apple.items() if k != "done"},
         "failed", send_args)
    case("fewer verdicts than files",
         send_android, dict(send_apple, done=[True, True]), "failed", send_args)
    case("more verdicts than files",
         send_android, dict(send_apple, done=[True, True, True, True]), "failed", send_args)
    case("one file's digest did not verify",
         send_android, dict(send_apple, done=[True, False, True]), "failed", send_args)
    case("a verdict that is merely truthy",
         send_android, dict(send_apple, done=[True, 1, True]), "failed", send_args)
    case("bytes arrived past the manifest on a send",
         send_android, dict(send_apple, trailingBytes=3), "failed", send_args)

    disagreeing_sas = copy.deepcopy(good_apple)
    disagreeing_sas["sas"] = "111111"
    case("the two sides derived different verification codes",
         good_android, disagreeing_sas, "failed")

    no_sas = copy.deepcopy(good_apple)
    no_sas["sas"] = None
    case("a half reported no verification code at all", good_android, no_sas, "failed")

    wrong_wire = copy.deepcopy(good_android)
    wrong_wire["wire"] = "LINK"
    case("the app negotiated a different wire", wrong_wire, good_apple, "failed")

    # There is deliberately no receive-direction trailing-bytes case: on that
    # round the Apple half is the SENDER, so its accumulator was never fed and
    # a check on it would assert about a field nothing writes. The real one is
    # "bytes arrived past the manifest on a send" above, where the Apple half
    # is the receiver that could actually overrun.

    cancel_args = ("joiner", "file", "receive", "cancel")
    good_cancel_android = {"complete": True, "wire": "LEGACY_FILES", "canSendFiles": True,
                           "canSendMessages": False, "sas": "705955",
                           "progressBeforeCancel": 65_536, "cancelIssued": True,
                           "finalPhase": "ENDED", "finalError": None, "savedAfterCancel": 0}
    good_cancel_apple = {"complete": True, "sas": "705955", "rejected": True}
    case("an agreeing cancel", good_cancel_android, good_cancel_apple, "passed", cancel_args)
    case("a cancel that left the connection open",
         dict(good_cancel_android, finalPhase="CONNECTED"), good_cancel_apple,
         "failed", cancel_args)
    bare_cancel_apple = {k: v for k, v in good_cancel_apple.items() if k != "rejected"}
    case("a cancel the Apple half never saw at all",
         good_cancel_android, bare_cancel_apple, "failed", cancel_args)
    # Either terminal observation suffices on its own: a refusal that drained,
    # or a teardown that did not.
    case("a cancel seen only as a teardown", good_cancel_android,
         dict(bare_cancel_apple, closed=True), "passed", cancel_args)
    case("a cancel seen only as a transport failure", good_cancel_android,
         dict(bare_cancel_apple, remoteTeardown="peerConnectionFailed"), "passed", cancel_args)

    refuse_args = ("joiner", "text", "both", "refuse-text")
    good_refuse_android = {"complete": True, "wire": "LEGACY_TEXT", "canSendFiles": False,
                           "canSendMessages": True, "sas": "705955", "textRejected": True,
                           "finalPhase": "ENDED", "finalError": None}
    good_refuse_apple = {"complete": True, "sas": "705955", "closed": True}
    case("an agreeing refusal", good_refuse_android, good_refuse_apple, "passed", refuse_args)
    case("a refusal the app never made",
         {k: v for k, v in good_refuse_android.items() if k != "textRejected"},
         good_refuse_apple, "failed", refuse_args)
    case("a refusal that did not end the connection",
         dict(good_refuse_android, finalPhase="CONNECTED"), good_refuse_apple,
         "failed", refuse_args)
    case("a refusal that ended as a failure",
         dict(good_refuse_android, finalError="error_text_failed"), good_refuse_apple,
         "failed", refuse_args)
    case("a refusal the Apple half never saw at all",
         good_refuse_android, {"complete": True, "sas": "705955"}, "failed", refuse_args)
    case("a cancel with no bytes ever in flight",
         dict(good_cancel_android, progressBeforeCancel=0), good_cancel_apple,
         "failed", cancel_args)
    case("a remote failure laundered as a cancel",
         dict(good_cancel_android, finalError="error_connection_lost"), good_cancel_apple,
         "failed", cancel_args)
    case("a teardown the app never asked for",
         {k: v for k, v in good_cancel_android.items() if k != "cancelIssued"},
         good_cancel_apple, "failed", cancel_args)

    good_decline_android = {"complete": True, "wire": "LEGACY_FILES", "canSendFiles": True,
                            "canSendMessages": False, "sas": "705955",
                            "phaseAfterDecline": "CONNECTED"}
    good_decline_apple = {"complete": True, "sas": "705955", "rejected": True,
                          "errors": ["rejected"], "peerHalfReturned": True}
    decline_args = ("joiner", "file", "receive", "decline")
    case("an agreeing decline", good_decline_android, good_decline_apple, "passed", decline_args)
    case("a decline that ended the connection",
         dict(good_decline_android, phaseAfterDecline="ENDED"), good_decline_apple,
         "failed", decline_args)
    case("a decline the Apple half never observed",
         good_decline_android, {k: v for k, v in good_decline_apple.items() if k != "rejected"},
         "failed", decline_args)
    case("a decline where the Apple half hung up instead of staying",
         good_decline_android,
         {k: v for k, v in good_decline_apple.items() if k != "peerHalfReturned"},
         "failed", decline_args)

    text_android = {"complete": True, "wire": "LEGACY_TEXT", "canSendFiles": False,
                    "canSendMessages": True, "sas": "705955",
                    "messageOut": "e" * 64, "messageIn": "f" * 64}
    text_apple = {"complete": True, "sas": "705955",
                  "messageIn": "e" * 64, "messageOut": "f" * 64}
    case("an agreeing conversation", text_android, text_apple, "passed",
         ("joiner", "text", "both", ""))
    crossed = copy.deepcopy(text_apple)
    crossed["messageIn"] = "0" * 64
    case("a message body that did not survive the wire", text_android, crossed,
         "failed", ("joiner", "text", "both", ""))
    decoded_wrong = copy.deepcopy(text_apple)
    decoded_wrong["messageMatched"] = False
    case("a body that arrived with the right digest and the wrong bytes",
         text_android, decoded_wrong, "failed", ("joiner", "text", "both", ""))

    bad = [(name, got, want) for name, got, want in cases if got != want]
    for name, got, want in cases:
        print(f"  {'ok  ' if got == want else 'BAD '} {name}: {got} (expected {want})",
              file=sys.stderr)
    if bad:
        print(f"legacy-oracle self-test: {len(bad)} case(s) behaved wrongly", file=sys.stderr)
        sys.exit(1)
    print(f"legacy-oracle self-test: {len(cases)} cases OK", file=sys.stderr)


if __name__ == "__main__":
    if len(sys.argv) == 2 and sys.argv[1] == "--self-test":
        _self_test()
    else:
        main()

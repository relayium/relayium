#!/usr/bin/env python3
"""Judge one Android ↔ Apple BIDIRECTIONAL local-link round from both halves.

    android-nearby-apple-bidirectional-oracle.py \
        --android REPORT --apple-result RESULT --apple-observed OBSERVED \
        --expect EXPECTATIONS

The shell half owns the emulator, the Mac fixture, the payload rule and the
sequencing. This owns the COMPARISON, and it is deliberately a separate program:
a shell that greps its own log for the word it printed is checking that it
printed a word.

Nothing here trusts a device's self-assessment. `pass` is necessary and never
sufficient — every claim below is re-derived from the fields the two halves
independently observed, and a field that is MISSING is a failure rather than a
default, because "the round never got far enough to write it" and "the round got
there and the answer was false" must not look the same.

## The three rules this file exists to keep

**Every receipt is read from the RECEIVING side.** The Apple half's `files` are
read off `LinkCounterpart.liveReceipts`, which re-reads what the link's own
writer left on disk; the Android half's `received` are read back through the
real `ContentResolver` from the document ids the app's own manifest named.
Neither side's digest for a file it SENT appears in either report — a sender
that published its own hashes would be answering the question the receiver's
receipt is the only honest answer to. The expected digests come from the
launcher, which generated the bytes.

**A tuple is matched whole.** Name, path, size and digest are compared together,
one receipt per expected file and one expected file per receipt. Matching them
field by field is how a round passes with a name from one file and a digest from
another, and how a receiver that flattened a folder passes on names alone.

**Everything is bound to a phase that COMPLETED.** A digest that appears in a
diagnostic is not a receipt, so nothing here searches a document for a value;
each is read from a declared field of a declared type, on a report whose own
phase says the round finished.
"""
import argparse
import json
import sys
from urllib.parse import urlsplit


def fail(message):
    print(f"FAIL: {message}", file=sys.stderr)
    sys.exit(1)


def load(path, role):
    try:
        with open(path, encoding="utf-8") as handle:
            return json.load(handle)
    except FileNotFoundError:
        fail(f"the {role} wrote no report ({path}); it did not reach its own end")
    except json.JSONDecodeError as error:
        fail(f"the {role} report is not readable JSON: {error}")


def read_text(path, what):
    try:
        with open(path, encoding="utf-8") as handle:
            return handle.read()
    except FileNotFoundError:
        fail(f"the run declared {what} but wrote no file for it ({path})")


def need(report, role, field):
    if field not in report:
        fail(f"the {role} report has no {field!r}; the round stopped before observing it")
    return report[field]


def typed(value, kind, role, what):
    """Read one field of a DECLARED type, or fail naming it.

    Both halves publish typed documents — the Apple fixture builds `files` from
    `FileReceipt` (`name`, `size`, `sha256`, optional `path`) and the Android
    half writes the same four terms from its own read-back — so this reads that
    schema rather than searching text. An earlier oracle on this lane walked
    every string in the Apple peer's document and asked whether the expected
    digest appeared anywhere, which is not a receipt: a FAILED run whose
    diagnostic quoted the digest it was waiting for passed it.

    **`bool` is excluded from `int` explicitly, and that is a fix rather than a
    nicety.** `isinstance(True, int)` is True in Python, so a report that
    answered a COUNT with a boolean satisfied an `int` check and then satisfied
    `>= 1` as well — `savedBatchCount: true` and `size: false` both passed this
    file until an independent probe reproduced it.
    """
    if kind is bool:
        ok = isinstance(value, bool)
    elif kind is int:
        ok = isinstance(value, int) and not isinstance(value, bool)
    else:
        ok = isinstance(value, kind)
    if not ok:
        got = type(value).__name__
        fail(f"the {role}'s {what} is {got}, not {kind.__name__}; "
             "its report schema is not the one this run asserts")
    return value


def sas_digits(value, role):
    """The SHAPE of a short authentication string, not merely its equality.

    Both implementations derive exactly six ASCII digits — `String(format:
    "%06u", num % 1_000_000)` in `RelayiumKit/Crypto/Sas.swift` and
    `value.toString().padStart(6, '0')` in `protocol/Crypto.kt` — so anything
    else is not a SAS at all. Equality alone is satisfied by two halves that
    each reported the same placeholder, which is a way for a round where no
    handshake happened to claim the two endpoints authenticated each other.
    """
    typed(value, str, role, "SAS")
    if len(value) != 6 or not all(c in "0123456789" for c in value):
        fail(f"the {role}'s SAS {value!r} is not the six ASCII digits both "
             "implementations derive, so it is not a short authentication string")
    return value


def loopback_origin(raw, role):
    """A loopback origin, PARSED.

    `startswith("http://127.0.0.1:")` is not a host check, and an independent
    probe showed why: `http://127.0.0.1:80@evil.invalid` satisfies it, because
    everything before the `@` is USERINFO and the real host is
    `evil.invalid`. Every component is therefore read from a parse — scheme,
    userinfo, host, port and the absence of a path — rather than from a prefix.
    """
    typed(raw, str, role, "origin")
    parts = urlsplit(raw)
    if parts.scheme != "http":
        fail(f"the {role} resolved the scheme {parts.scheme!r}, not http; the run was not local")
    if parts.username is not None or parts.password is not None:
        fail(f"the {role}'s origin carries userinfo ({raw}). Everything before an '@' is a "
             "credential, not a host, so this names a REMOTE server")
    try:
        port = parts.port
    except ValueError:
        fail(f"the {role}'s origin has an unreadable port ({raw})")
    if parts.hostname != "127.0.0.1":
        fail(f"the {role} resolved the host {parts.hostname!r}, not 127.0.0.1; "
             "the run was not local")
    if not isinstance(port, int) or not 1 <= port <= 65535:
        fail(f"the {role}'s origin names no usable port ({raw})")
    if parts.path not in ("", "/") or parts.query or parts.fragment:
        fail(f"the {role}'s origin is not a bare origin ({raw})")
    return raw


def need_typed(report, role, field, kind):
    return typed(need(report, role, field), kind, role, field)


def receipt_tuple(entry, role, index):
    """One receipt, as the only four terms that can distinguish a real transfer
    from a plausible one. `path` is normalised to None so a loose file and a
    nested one are never interchangeable — a receiver that flattened a tree
    would otherwise produce a matching receipt."""
    entry = typed(entry, dict, role, f"receipt {index}")
    path = entry.get("path")
    if path is not None:
        path = typed(path, str, role, f"receipt {index} path")
    return (
        typed(entry.get("name"), str, role, f"receipt {index} name"),
        path,
        typed(entry.get("size"), int, role, f"receipt {index} size"),
        typed(entry.get("sha256"), str, role, f"receipt {index} sha256"),
    )


def expected_tuple(entry, index):
    if not isinstance(entry, dict):
        fail(f"the expectations file's file {index} is not an object")
    for field in ("name", "size", "sha256"):
        if field not in entry:
            fail(f"the expectations file's file {index} has no {field!r}")
    size = entry["size"]
    if not isinstance(size, int) or isinstance(size, bool):
        fail(f"the expectations file's file {index} declares a size that is not an integer")
    return (entry["name"], entry.get("path"), size, entry["sha256"])


def compare_receipts(direction, receiver, receipts, expected):
    """One receipt per expected file, one expected file per receipt, matched as
    WHOLE tuples.

    Counts first, so "the round sent four and three arrived" and "three arrived
    with one wrong digest" are different failures. Then an exhaustive
    consumption: a receipt that matches nothing left is reported as itself
    rather than silently ignored, which is what makes an EXTRA file a failure.
    """
    if len(receipts) != len(expected):
        fail(f"{direction}: {receiver} produced {len(receipts)} receipt(s) for "
             f"{len(expected)} file(s). Any other count means the receipt does not "
             "describe what was sent")
    remaining = list(expected)
    for got in receipts:
        if got in remaining:
            remaining.remove(got)
            continue
        # Named by the fields that can be compared without printing content, and
        # digests by a short prefix: a diagnostic is not a place to publish one.
        name, path, size, sha = got
        near = [e for e in remaining if e[0] == name]
        if near:
            want = near[0]
            fail(f"{direction}: {receiver}'s receipt for {name!r} does not match the bytes "
                 f"that were sent — path {path!r} vs {want[1]!r}, size {size} vs {want[2]}, "
                 f"digest {sha[:12]}… vs {want[3][:12]}…")
        fail(f"{direction}: {receiver} produced a receipt for {name!r}, which this round "
             "never sent")
    if remaining:
        missing = ", ".join(repr(e[0]) for e in remaining)
        fail(f"{direction}: {receiver} produced no receipt for {missing}")


def judge(android_path, result_path, observed_path, expect_path):
    expect = load(expect_path, "launcher (expectations)")
    android = load(android_path, "Android half")
    result = load(result_path, "Apple fixture (result)")
    observed = load(observed_path, "Apple fixture (observed)")

    dial_side = expect["dialSide"]
    if dial_side not in ("apple", "android"):
        fail(f"the expectations file declares an unknown dial side {dial_side!r}")
    apple_to_android = [expected_tuple(e, i) for i, e in enumerate(expect["appleToAndroid"])]
    android_to_apple = [expected_tuple(e, i) for i, e in enumerate(expect["androidToApple"])]
    if not apple_to_android:
        fail("the expectations file declares no Apple → Android files. That direction is the "
             "whole reason this acceptance exists; a round without it is the one-way round")
    if not android_to_apple:
        fail("the expectations file declares no Android → Apple files")
    android_message = read_text(expect["androidMessageFile"], "the message Android sends")
    apple_message = read_text(expect["appleMessageFile"], "the message the Mac sends")

    # ── the Android half's own terminal state ───────────────────────────────
    if need_typed(android, "Android half", "pass", bool) is not True:
        fail("the Android half did not complete its round")
    if android.get("errorKey"):
        fail(f"the Android half finished carrying the error {android['errorKey']!r}")
    if need_typed(android, "Android half", "wire", str) != "LINK":
        fail(f"the Apple counterpart was reached on {android['wire']}, not link/1")
    if not need_typed(android, "Android half", "sas", str):
        fail("the Android half reached CONNECTED with no SAS; the handshake did not complete")
    android_sas = sas_digits(android["sas"], "Android half")

    # ── identity: the device this round names, and no other ─────────────────
    #
    # Two emulator images report the same `Build.MODEL`, so a NAME is not an
    # identifier on this link. The advertisement identity the Mac minted is, and
    # both halves are held to it.
    if need_typed(android, "Android half", "peerId", str) != expect["peerIdentity"]:
        fail("the Android half linked to a device whose advertisement identity is not the one "
             "the Mac minted for this run")
    if need_typed(android, "Android half", "peerName", str) != expect["peerName"]:
        fail("the Android half's chosen device does not carry the name the Mac advertised")
    if need_typed(android, "Android half", "candidates", int) < 1:
        fail("the Android half listed no devices; it discovered nothing to select")

    # ── which side pressed Connect, and that consent was real ───────────────
    if need_typed(android, "Android half", "dialSide", str) != dial_side:
        fail(f"the Android half ran the {android['dialSide']!r} dial assignment, not the "
             f"{dial_side!r} one this run asked for")
    if dial_side == "apple":
        if "promptedBy" not in android:
            fail("the Apple side was to dial, but the Android half never saw an inbound "
                 "request; its connection was not consented to")
        if need_typed(android, "Android half", "promptedBy", str) != android["peerId"]:
            fail("the Android half was prompted by a device other than the one it discovered")

    # ── the Apple fixture's own terminal state ──────────────────────────────
    phase = need_typed(result, "Apple fixture", "phase", str)
    if phase != "released":
        fail(f"the Apple fixture finished in phase {phase!r}, not 'released'. A receipt from a "
             "run that did not reach its own barrier is not evidence of a delivery")
    if "failure" in result:
        fail(f"the Apple fixture reported a failure alongside its receipt: {result['failure']}")
    # Its OWN answer about the origin it resolved, not the string it was passed.
    loopback_origin(need(result, "Apple fixture", "origin"), "Apple fixture")
    if need_typed(result, "Apple fixture", "dialSide", str) != dial_side:
        fail("the Apple fixture ran a different dial assignment from the one this run asked for")
    # The ROLE, so a `/result` scraped from some other harness in the same run
    # root cannot be read as this one's.
    if need_typed(result, "Apple fixture", "role", str) != "local-link-bidirectional":
        fail(f"the result document was written by the {result['role']!r} role, not the "
             "bidirectional one this round drives")

    # ── both endpoints derived the SAME key ─────────────────────────────────
    #
    # Read from the LIVE snapshot the launcher took at the transfer barrier: the
    # SAS belongs to a link, and a value read after the workspace was dismissed
    # would be an earlier link's residue. Two clients that moved bytes without
    # agreeing a key would still move the files; the SAS is what makes the
    # session authenticated rather than merely working.
    if not need_typed(observed, "Apple fixture (observed)", "sas", str):
        fail("the Apple fixture's live view carries no SAS, so this round cannot show the two "
             "endpoints authenticated each other")
    apple_sas = sas_digits(observed["sas"], "Apple fixture (observed)")
    if apple_sas != android_sas:
        fail("the two clients derived DIFFERENT short authentication strings "
             f"({apple_sas} vs {android_sas}); they did not agree on a key")
    link_phase = need_typed(observed, "Apple fixture (observed)", "linkPhase", str)
    if not link_phase.startswith("open("):
        fail(f"the Apple fixture's barrier snapshot was taken at {link_phase!r} rather than on "
             "an open link, so nothing in it describes a live session")

    # ── the manifest the sender DECLARED and the receiver PARSED agree ──────
    #
    # State rather than a receipt, and asserted separately from the bytes: two
    # independently written clients disagreeing about a `path` is exactly the
    # class of defect neither side's own tests can see, and it would otherwise
    # surface only as a digest mismatch that names the wrong cause.
    declared = [(typed(e, dict, "Apple fixture", "manifest entry").get("name"), e.get("path"))
                for e in need_typed(result, "Apple fixture", "manifest", list)]
    parsed = [(typed(e, dict, "Android half", "inbound manifest entry").get("name"),
               e.get("path"))
              for e in need_typed(android, "Android half", "inboundManifest", list)]
    wanted = [(e[0], e[1]) for e in apple_to_android]
    if sorted(declared) != sorted(wanted):
        fail(f"the Apple fixture declared the manifest {sorted(declared)}, not the "
             f"{sorted(wanted)} this round staged for it")
    if sorted(parsed) != sorted(wanted):
        fail(f"the Android half accepted the manifest {sorted(parsed)}, not the "
             f"{sorted(wanted)} the Apple side declared. The two implementations disagree "
             "about the manifest itself")

    # ── the bytes, in BOTH directions, compared by whole tuples ─────────────
    compare_receipts(
        "Apple → Android", "the Android half",
        [receipt_tuple(e, "Android half", i)
         for i, e in enumerate(need_typed(android, "Android half", "received", list))],
        apple_to_android,
    )
    compare_receipts(
        "Android → Apple", "the Apple fixture",
        [receipt_tuple(e, "Apple fixture", i)
         for i, e in enumerate(need_typed(result, "Apple fixture", "files", list))],
        android_to_apple,
    )

    # ── the batch counts each side COMMITTED, not merely started ────────────
    if need_typed(android, "Android half", "savedBatchCount", int) < 1:
        fail("the Android half committed no incoming batch")
    if need_typed(android, "Android half", "sentBatchCount", int) != len(android_to_apple):
        fail(f"the Apple peer confirmed {android['sentBatchCount']} outgoing batch(es) for "
             f"{len(android_to_apple)} file(s); this round sends one batch per file")
    if result.get("sentBatches") != "1":
        fail(f"the Apple fixture reports {result.get('sentBatches')!r} completed outgoing "
             "batch(es), not the one this round enqueues. 'finished' is the only state that "
             "means the peer took it")
    if result.get("receivedBatches") != str(len(android_to_apple)):
        fail(f"the Apple fixture committed {result.get('receivedBatches')!r} inbound batch(es), "
             f"not {len(android_to_apple)}")

    # ── the text, judged from each RECEIVING side, by equality ──────────────
    #
    # Read from files rather than argv: both bodies are non-ASCII and
    # whitespace-significant, and a comparison value that had to survive two
    # levels of shell quoting is not a reliable comparison. Compared by
    # equality against each entry, never by containment: a message that arrived
    # with different whitespace is a DIFFERENT message.
    if need_typed(android, "Android half", "peerMessageArrived", bool) is not True:
        fail("the Android half never observed the Mac's message arriving")
    if need_typed(android, "Android half", "messageSent", bool) is not True:
        fail("the Android half never reported sending the message this round asserts")
    apple_messages = need_typed(result, "Apple fixture", "messages", list)
    if not any(isinstance(m, str) and m == android_message for m in apple_messages):
        fail("the Apple fixture's received messages do not contain the EXACT message the "
             f"Android half sent ({len(apple_messages)} received). Not printed here on purpose")
    if result.get("messageSent") != "true":
        fail("the Apple fixture never reported sending its own message, so the Android half's "
             "arrival claim describes a frame nothing accounts for")
    # The Apple side's outbound body is asserted through the ANDROID half's
    # arrival check above; this is the launcher's own record of what it staged,
    # and it must be non-empty or that check compared nothing.
    if not apple_message:
        fail("the run declared a Mac → Android message assertion with an empty body")

    # ── neither half tore down while the other was still asserting ──────────
    for field, guards in (
        ("barrier", "end the session the other was still reading receipts off"),
        ("barrierRoom", "stop advertising while the other was still checking its roster"),
    ):
        value = need_typed(android, "Android half", field, str)
        if value != "released":
            fail(f"the Android half did not pass the {field} barrier ({field}={value!r}); "
                 f"one side would have been free to {guards}")

    # ── finishing returned to the list rather than ending the room ──────────
    if need_typed(android, "Android half", "listedAfterDisconnect", int) < 1:
        fail("the Android half's room did not survive its own transfer "
             f"({android['listedAfterDisconnect']} device(s) listed afterwards)")
    if result.get("targetStillListed") != "true":
        fail("the Apple fixture's roster lost the Android device once the link ended, so its "
             "own room did not survive the transfer it just served")

    # ── the owned pickers did not end the session ───────────────────────────
    #
    # `need_typed`, not `.get(...)`: a claim about the picker that is absent is
    # a claim nothing observed, and a default pass here would let a run that
    # fell back to calling the view model directly print the headline about
    # surviving real DocumentsUI round trips. There is no opt-out on this lane —
    # both pickers are the real ones or the round does not run.
    if need_typed(android, "Android half", "survivedPicker", bool) is not True:
        fail("the Android half's session did not survive its own document pickers; an "
             "ended-and-rejoined session is not continuity")

    print(f"PASS counterpart=apple-fixture direction=both dial={dial_side} wire=LINK "
          f"sas={apple_sas} apple->android={len(apple_to_android)} "
          f"android->apple={len(android_to_apple)} batches=android:{len(android_to_apple)}"
          f"/apple:1 messages=2")
    print("NOTE the Apple half is the SHIPPED local-link modules compiled on this host and "
          "driven by a fixture caller. It is NOT an iOS binary and NOT a physical device; a "
          "Mac running shipped modules is not an iPhone.", file=sys.stderr)
    print("NOTE nested `path` is exercised in the Apple → Android direction only. Android's own "
          "Nearby send surface is OpenMultipleDocuments — files, never a folder — so this side "
          "cannot originate one. That is a product fact, not a gap in this round.",
          file=sys.stderr)
    return 0


def main():
    parser = argparse.ArgumentParser(add_help=True, description=__doc__)
    parser.add_argument("--android", required=True)
    parser.add_argument("--apple-result", required=True)
    parser.add_argument("--apple-observed", required=True)
    parser.add_argument("--expect", required=True)
    args = parser.parse_args()
    return judge(args.android, args.apple_result, args.apple_observed, args.expect)


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""The Android ↔ Web interop comparison, as a file both the acceptance and its
own test can run.

## Why this is not a heredoc inside the shell script

It was, and a heredoc cannot be mutation-tested. The first version of this
comparison skipped the digest check whenever the browser reported NO received
bytes -- `elif browser.get("receivedFileHex")` -- so an observation in which
the browser received nothing at all passed exactly like one where it received
the right bytes. A false green in the acceptance oracle is worse than a missing
test: the lane reports that two implementations agreed when one of them
transferred nothing.

So the rules live here, `scripts/test/android-interop-oracle-test.mjs` runs
them against a correct observation AND against mutants of it, and every mutant
must be REJECTED. A rule that has never been observed rejecting something is
indistinguishable from a rule that cannot.

## The shape of the judgement

Both halves write down only what they OBSERVED. Neither compares anything, and
neither may grant itself a pass. This file:

  * requires every field it reads to be PRESENT -- a missing field is a
    failure, never a skipped check;
  * compares payloads by size AND digest, including for zero-byte and empty
    results, so "nothing arrived" can never satisfy "the right thing arrived";
  * requires the round's declared shape (cancels, retries, repeated batches)
    to have actually happened, rather than accepting a flag that says so.

Usage: android-interop-oracle.py <browser.json> <android.json> <expect.json>
Exit 0 means the round agreed. Anything else prints every problem it found.
"""
import hashlib
import json
import sys


def sha256_hex(hex_bytes):
    return hashlib.sha256(bytes.fromhex(hex_bytes)).hexdigest()


def judge(browser, android, expect):
    problems = []

    def require(obj, key, where):
        """Read a field that MUST exist. Absence is a failure, not a skip."""
        if key not in obj:
            problems.append("%s is missing the field %r" % (where, key))
            return None
        return obj[key]

    # ── the run was against this run's own server ───────────────────────────
    origin = require(android, "origin", "the Android report")
    if origin is not None and origin != expect["origin"]:
        problems.append("the Android app resolved %r, not this run's server %r"
                        % (origin, expect["origin"]))

    if require(browser, "reachedWorkspace", "the browser report") is False:
        problems.append("the browser never reached the unified workspace")

    error_key = require(android, "errorKey", "the Android report")
    if error_key:
        problems.append("the Android app ended the round with %r" % (error_key,))
    if require(android, "cleanupIncomplete", "the Android report"):
        problems.append("the Android app reported an incomplete cleanup")

    # ── one link, one SAS, derived independently by two implementations ─────
    #
    # The only cell in the matrix where this can be checked at all: the Kotlin
    # vector test and the Web test each check their own implementation against
    # a frozen value, and neither has ever compared two live endpoints.
    browser_sas = require(browser, "sas", "the browser report")
    android_sas = require(android, "sas", "the Android report")
    if expect.get("verify") == "on":
        if not browser_sas:
            problems.append("the browser derived no SAS on the path that shows one")
        elif not android_sas:
            problems.append("the Android app derived no SAS")
        elif browser_sas != android_sas:
            problems.append("the two sides derived different SAS digits: browser %s, android %s"
                            % (browser_sas, android_sas))

    # ── text, both directions, exactly ──────────────────────────────────────
    seen_by_browser = require(browser, "receivedMessages", "the browser report") or []
    for message in expect["androidMessages"]:
        if message not in seen_by_browser:
            problems.append("the browser did not receive the Android message %r; it saw %r"
                            % (message, seen_by_browser))
    android_received = require(android, "receivedMessage", "the Android report")
    if android_received != expect["webMessage"]:
        problems.append("Android did not receive the browser's message: %r"
                        % (android_received,))

    # ── files: android → web ────────────────────────────────────────────────
    #
    # Compared as a SET of complete records. The old rule read one name and one
    # hex string and skipped the digest when the hex was empty, which is the
    # false green this file exists to prevent.
    got = {}
    for entry in require(browser, "receivedFiles", "the browser report") or []:
        name = entry.get("name")
        if name is None:
            problems.append("a browser save record has no name: %r" % (entry,))
            continue
        if "hex" not in entry or "size" not in entry:
            problems.append("the browser save record for %r has no bytes or no size" % (name,))
            continue
        got[name] = entry

    for want in expect["androidSent"]:
        entry = got.get(want["name"])
        if entry is None:
            problems.append("the browser never completed a save of %r; it completed %r"
                            % (want["name"], sorted(got)))
            continue
        # SIZE and DIGEST, unconditionally. An empty result fails both against
        # a non-empty expectation, and a zero-byte expectation is satisfied
        # only by a zero-byte result with the digest of the empty string.
        if entry["size"] != want["size"]:
            problems.append("the browser saved %r as %d bytes, not %d"
                            % (want["name"], entry["size"], want["size"]))
        if len(entry["hex"]) != 2 * entry["size"]:
            problems.append("the browser's record for %r is internally inconsistent: "
                            "%d hex chars for %d bytes"
                            % (want["name"], len(entry["hex"]), entry["size"]))
        digest = sha256_hex(entry["hex"])
        if digest != want["sha256"]:
            problems.append("the browser's bytes for %r differ from what Android sent "
                            "(%s vs %s)" % (want["name"], digest, want["sha256"]))

    # A cancelled SEND is not proved by the forbidden name being absent — the
    # real Web calls sink.close() on the abort path (mixed-file-session
    # closeSink), so it genuinely commits a PARTIAL file. The claim is instead:
    # if the cancelled name is present at all, it is strictly SMALLER than the
    # full payload and does not match its digest; and the gate that made the
    # cancel deterministically active actually ran.
    full = expect.get("cancelledFullSize", 0)
    for forbidden in expect.get("browserMustNotSave", []):
        entry = got.get(forbidden)
        if not full:
            # No full size declared: the name must not appear as a completed
            # save at all (the strict rule for a round that expects nothing of
            # it to survive).
            if entry is not None:
                problems.append("the browser completed a save of %r, which this round cancelled"
                                % (forbidden,))
            continue
        if entry is None:
            continue  # a cancelled send may leave nothing committed at all
        # Otherwise only a strictly-smaller PARTIAL is allowed: a save AT or
        # ABOVE the full size is a completed transfer (the run7 failure), since
        # a partial can never reach — let alone match the digest of — the whole.
        if entry.get("size", 0) >= full:
            problems.append("the browser saved the cancelled file %r at %d bytes, not a "
                            "strictly-smaller partial of %d — the cancel was not active"
                            % (forbidden, entry.get("size", 0), full))

    if expect.get("cancel") == "send":
        # The gate's lifecycle proves the cancel was ACTIVE and OBSERVED, not
        # synthesized: the browser really held the first write, saw the peer's
        # cancel request, and released it. A round missing any of these did not
        # cancel a live transfer.
        gate = require(browser, "forbiddenGate", "the browser report")
        if not gate:
            problems.append("the send-cancel round recorded no gate lifecycle")
        else:
            if not gate.get("writeHeld"):
                problems.append("the browser never held the cancelled file's write, so the "
                                "sender's batch was never stalled mid-flight")
            if not gate.get("cancelObserved"):
                problems.append("the browser never observed the peer's cancel request")
            if not gate.get("released"):
                problems.append("the browser never released the held write, so the real "
                                "BATCH_ABORT could not run")

    # ── files: web → android ────────────────────────────────────────────────
    saved = {}
    for entry in require(android, "saved", "the Android report") or []:
        name = entry.get("name")
        if name is None or "sha256" not in entry or "size" not in entry:
            problems.append("an Android save record is incomplete: %r" % (entry,))
            continue
        saved[name] = entry

    for want in expect["webSent"]:
        entry = saved.get(want["name"])
        if entry is None:
            problems.append("Android never saved %r; it saved %r"
                            % (want["name"], sorted(saved)))
            continue
        if entry["size"] != want["size"]:
            problems.append("Android saved %r as %d bytes, not %d"
                            % (want["name"], entry["size"], want["size"]))
        if entry["sha256"].lower() != want["sha256"].lower():
            problems.append("Android's bytes for %r differ from what the browser sent"
                            % (want["name"],))

    for forbidden in expect.get("androidMustNotSave", []):
        if forbidden in saved:
            problems.append("Android saved %r, which this round cancelled" % (forbidden,))

    # The boundary payloads are named as REQUIREMENTS, not hoped for: a round
    # whose sizes drifted below them would still compare equal and would prove
    # much less than the comment above it claims. In BOTH directions — before
    # the android→web checks existed, zero-byte and multi-entry were proved
    # web→android only while the run's claim covered both.
    #
    # Only for an UNCANCELLED round: a receive-cancel round discards the
    # boundary-carrying first batch by design and completes a single-file
    # retry, and a send-cancel round retries one file. Demanding the
    # boundaries there would reject every correct cancel round; the boundary
    # proof is the cancel-free rounds' job, and those run in the same
    # acceptance.
    if expect.get("cancel", "none") == "none":
        sizes = [e["size"] for e in saved.values()]
        if not any(s == 0 for s in sizes):
            problems.append("no ZERO-byte file was saved by Android; sizes were %r" % (sizes,))
        if not any(s > 196608 for s in sizes):
            problems.append("nothing crossed the 192KiB fragment boundary on Android: %r" % (sizes,))
        if len(expect["webSent"]) < 2:
            problems.append("this round's plan sends fewer than two inbound files, so the "
                            "multi-entry file sequence is not exercised")
        sent_sizes = [w["size"] for w in expect["androidSent"]]
        if not any(s == 0 for s in sent_sizes):
            problems.append("this round's plan sends no ZERO-byte file android→web: %r"
                            % (sent_sizes,))
        if not any(s > 196608 for s in sent_sizes):
            problems.append("nothing in the plan crosses the 192KiB boundary android→web: %r"
                            % (sent_sizes,))
        if len(expect["androidSent"]) < 2:
            problems.append("this round's plan sends fewer than two android→web files, so the "
                            "multi-entry file sequence is not exercised in that direction")

    # ── the terminal handshake actually happened ────────────────────────────
    #
    # The done message is what keeps the Android Activity alive until the
    # browser has everything; a round in which it silently stopped happening
    # would be one premature-teardown regression away from the pilot that
    # reported OK while the browser's ledger was missing a file.
    sent_done = require(browser, "sentDone", "the browser report")
    if sent_done is not None and sent_done is not True:
        problems.append("the browser never sent the terminal done handshake")
    peer_left = require(browser, "peerLeft", "the browser report")
    if peer_left is not None and peer_left is not True:
        problems.append("the browser never observed the Android peer leave after done")
    confirmed = require(android, "peerConfirmedDone", "the Android report")
    if confirmed is not None and confirmed is not True:
        problems.append("Android closed without the browser's in-band done confirmation")

    # ── the round's declared shape actually happened ────────────────────────
    if expect.get("cancel") == "receive":
        tree_after = require(android, "treeAfterCancel", "the Android report")
        if tree_after is None:
            problems.append("the receive-cancel round recorded no post-cancel directory listing")
        else:
            leaked = [n for n in expect.get("androidMustNotSave", []) if n in tree_after]
            if leaked:
                problems.append("a cancelled receive left %r in the destination" % (leaked,))
        if not require(android, "sentinelIntact", "the Android report"):
            problems.append("the cancelled receive's rollback damaged unrelated content")
    if expect.get("cancel") == "send":
        if not require(android, "sendCancelled", "the Android report"):
            problems.append("the send-cancel round did not cancel")

    # A retry is only a retry if something was cancelled and something later
    # succeeded; both halves have to show it.
    if expect.get("cancel") in ("send", "receive"):
        if not expect["androidSent"] and not expect["webSent"]:
            problems.append("a cancel round with no successful transfer proves no retry")

    return problems


def main():
    if len(sys.argv) != 4:
        print(__doc__.strip().splitlines()[-2], file=sys.stderr)
        return 2
    browser = json.load(open(sys.argv[1]))
    android = json.load(open(sys.argv[2]))
    expect = json.load(open(sys.argv[3]))

    problems = judge(browser, android, expect)
    if problems:
        for p in problems:
            print("  - %s" % p, file=sys.stderr)
        print("browser: %s" % json.dumps(browser, ensure_ascii=False)[:2000], file=sys.stderr)
        print("android: %s" % json.dumps(android, ensure_ascii=False)[:2000], file=sys.stderr)
        return 1

    print("-- round agreed: %s, both directions, files byte-identical (browser was %s)"
          % ("SAS %s on both sides" % browser["sas"] if expect.get("verify") == "on"
             else "verification at its shipped default", browser.get("role")),
          file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())

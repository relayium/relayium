#!/usr/bin/env python3
"""Judge one Nearby acceptance round from the two devices' own reports.

The shell half owns the emulators, the roles and the payloads. This owns the
COMPARISON, and it is deliberately a separate program: a shell that greps its
own log for the word it printed is checking that it printed a word.

Nothing here trusts a device's self-assessment. `pass` is necessary and never
sufficient — every claim below is re-derived from the fields the two halves
independently observed, and a field that is missing is a FAILURE rather than a
default, because "the round never got far enough to write it" and "the round
got there and the answer was false" must not look the same.
"""
import json
import sys


def fail(message):
    print(f"FAIL: {message}", file=sys.stderr)
    sys.exit(1)


def load(path, role):
    try:
        with open(path, encoding="utf-8") as handle:
            return json.load(handle)
    except FileNotFoundError:
        fail(f"the {role} device wrote no report ({path}); it did not reach its own end")
    except json.JSONDecodeError as error:
        fail(f"the {role} report is not readable JSON: {error}")


def need(report, role, field):
    if field not in report:
        fail(f"the {role} report has no {field!r}; the round stopped before observing it")
    return report[field]


def typed(value, kind, what):
    """Read one field of a declared type, or fail naming it.

    The Apple peer publishes a TYPED receipt — `State.result()` in
    `LocalTransferPeer/main.swift` builds `files` from `FileReceipt` with
    `name`, `size`, `sha256` and an optional `path` — so this reads that schema
    rather than searching text. The earlier version walked every string in the
    document and asked whether the expected digest appeared anywhere, which is
    not a receipt: a FAILED run whose diagnostic message quoted the digest it was
    waiting for passed it, and a digest and a name could be satisfied by two
    DIFFERENT files.
    """
    if not isinstance(value, kind):
        fail(f"the Apple peer's {what} is not {kind.__name__}; its receipt schema is not the one this run asserts")
    return value


def judge_apple(android_path, result_path, observed_path,
                expected_sha, expected_name, expected_size, message_path=None):
    """Android → the unchanged Apple `local-link-peer`.

    Every claim is bound to the SAME received file, and the two endpoints must
    agree on the key they derived. Nothing here is a substring match and nothing
    is taken from a free-text field.

    Failure messages name the field that disagreed and, for digests, a short
    prefix. They never echo the peer's document: a diagnostic is not a place to
    print content.
    """
    android = load(android_path, "android")
    if need(android, "android", "pass") is not True:
        fail("the Android half did not complete its round")
    if need(android, "android", "wire") != "LINK":
        fail(f"the Apple counterpart was reached on {android['wire']}, not link/1")
    if need(android, "android", "sentBatchCount") < 1:
        fail("the Apple peer never confirmed the batch, so nothing was verifiably delivered")
    android_sas = need(android, "android", "sas")
    if not android_sas:
        fail("the Android half reached CONNECTED with no SAS; the handshake did not complete")

    result = load(result_path, "Apple peer (result)")
    observed = load(observed_path, "Apple peer (observed)")

    # ── the peer's own terminal state ───────────────────────────────────────
    phase = typed(result.get("phase"), str, "phase")
    if phase != "done":
        fail(
            f"the Apple peer finished in phase {phase!r}, not 'done'. A receipt from a run "
            "that did not complete is not evidence of a delivery"
        )
    if "failure" in result:
        fail("the Apple peer reported a failure alongside its receipt")

    # Its OWN answer about the origin it resolved, not the string we passed it.
    origin = typed(result.get("origin"), str, "origin")
    if not origin.startswith("http://127.0.0.1:"):
        fail(f"the Apple peer resolved a non-loopback origin ({origin}); the run was not local")

    # ── exactly one file, and every field bound to THAT file ────────────────
    files = typed(result.get("files"), list, "files array")
    if len(files) != 1:
        fail(
            f"the Apple peer received {len(files)} file(s); this round sends exactly one, so "
            "any other count means the receipt does not describe what was sent"
        )
    entry = typed(files[0], dict, "file receipt")
    name = typed(entry.get("name"), str, "file receipt name")
    sha = typed(entry.get("sha256"), str, "file receipt sha256")
    size = typed(entry.get("size"), int, "file receipt size")
    if "path" in entry:
        path = typed(entry.get("path"), str, "file receipt path")
        # The peer writes only inside the receive root the launcher gave it.
        if not path.endswith(name):
            fail("the Apple peer's receipt path does not end in the file it names")

    if name != expected_name:
        fail(f"the Apple peer received a file named {name!r}, not {expected_name!r}")
    if sha != expected_sha:
        fail(
            "the file the Apple peer received does not hash to the bytes Android sent "
            f"(receipt {sha[:12]}… vs expected {expected_sha[:12]}…)"
        )
    if size != expected_size:
        fail(f"the Apple peer received {size} bytes, not {expected_size}")

    # ── both endpoints derived the SAME key ─────────────────────────────────
    #
    # Asserted from the Apple side's own live view, not inferred. Two clients
    # that transferred bytes without agreeing a SAS would still move the file;
    # the SAS is what makes the session authenticated rather than merely working.
    apple_sas = observed.get("sas")
    if not isinstance(apple_sas, str) or not apple_sas:
        fail(
            "the Apple peer's live view carries no SAS, so this round cannot show the two "
            "endpoints authenticated each other"
        )
    if apple_sas != android_sas:
        fail(
            "the two clients derived DIFFERENT short authentication strings "
            f"({apple_sas} vs {android_sas}); they did not agree on a key"
        )

    # ── the message, judged from the RECEIVING side ─────────────────────────
    #
    # The Android half records only that the frame entered its own channel,
    # which is not arrival. If this round advertises text acceptance, the Apple
    # peer's own `messages` must contain it EXACTLY — a sealed text frame that
    # was trimmed, normalised or re-encoded shows up here and nowhere else.
    #
    # Read from a file rather than argv: the fixture is non-ASCII and
    # whitespace-significant, and a comparison value that had to survive two
    # levels of shell quoting is not a reliable comparison.
    messages_checked = 0
    if message_path:
        try:
            with open(message_path, encoding="utf-8") as handle:
                expected_message = handle.read()
        except FileNotFoundError:
            fail(f"the run declared a text assertion but wrote no expected message ({message_path})")
        if not android.get("messageSent"):
            fail("the Android half never reported sending the message this round asserts")
        messages = typed(observed.get("messages"), list, "messages array")
        # Compared by equality against each entry, never by containment: a
        # message that arrived with different whitespace is a DIFFERENT message,
        # and that is exactly the class of defect a text lane can have.
        if not any(isinstance(m, str) and m == expected_message for m in messages):
            fail(
                "the Apple peer's received messages do not contain the exact message this round "
                f"sent ({len(messages)} message(s) received). Not printed here on purpose"
            )
        messages_checked = 1

    print(
        f"PASS counterpart=apple wire=LINK sas={apple_sas} messages={messages_checked} "
        f"candidates={android.get('candidates')} file={expected_name} "
        f"bytes={expected_size} sha={expected_sha[:12]}"
    )
    print(
        "NOTE one direction only: local-link-peer receives and does not send. "
        "A Mac running the shipped modules is not an iPhone.",
        file=sys.stderr,
    )
    return 0


def main():
    if len(sys.argv) >= 2 and sys.argv[1] == "--counterpart":
        if len(sys.argv) not in (9, 10) or sys.argv[2] != "apple":
            print(
                "usage: android-nearby-oracle.py --counterpart apple ANDROID_REPORT "
                "APPLE_RESULT APPLE_OBSERVED EXPECTED_SHA EXPECTED_NAME EXPECTED_SIZE "
                "[EXPECTED_MESSAGE_FILE]",
                file=sys.stderr,
            )
            return 2
        return judge_apple(sys.argv[3], sys.argv[4], sys.argv[5],
                           sys.argv[6], sys.argv[7], int(sys.argv[8]),
                           sys.argv[9] if len(sys.argv) > 9 else None)
    if len(sys.argv) != 7:
        print(
            "usage: android-nearby-oracle.py HOST_REPORT GUEST_REPORT "
            "HOST_SHA GUEST_SHA MODE REAL_PICKER",
            file=sys.stderr,
        )
        return 2
    host_path, guest_path, host_sha, guest_sha, mode, real_picker = sys.argv[1:]
    host = load(host_path, "host")
    guest = load(guest_path, "guest")

    for role, report in (("host", host), ("guest", guest)):
        if need(report, role, "pass") is not True:
            fail(f"the {role} device did not complete its round")

    # ── discovery, not addressing ───────────────────────────────────────────
    for role, report in (("host", host), ("guest", guest)):
        listed = need(report, role, "listed")
        if not isinstance(listed, int) or listed < 1:
            fail(f"the {role} device listed {listed} devices; it discovered nothing to select")

    host_peer = need(host, "host", "peerId")   # the GUEST's id, as the host saw it
    guest_peer = need(guest, "guest", "peerId")  # the HOST's id, as the guest saw it
    if host_peer == guest_peer:
        fail(
            "both devices report the SAME peer id. Ids are per room and per device, "
            "so this means the two halves did not observe each other"
        )

    # ── which role the SELECTING side played ────────────────────────────────
    #
    # `linkRole` gives the offer to the smaller id, and which id is smaller has
    # nothing to do with who pressed Connect. So a run exercises ONE of the two
    # assignments, at random, and the halves are not symmetric: the selecting
    # side that sorts BELOW its peer offers, and the one that sorts ABOVE sends a
    # request and waits to be offered. That second shape is the one that was
    # broken — the selecting side treated its own answer as a stranger's ask —
    # so a green run in the first shape says nothing about it.
    #
    # Derived here rather than observed on a device, because both ids are already
    # in the two reports and neither half knows the comparison. Reported, not
    # asserted: which assignment a run gets is chance, and the run cannot choose.
    selected_role = "INITIATOR" if host_peer < guest_peer else "RESPONDER"

    # ── the connection was ASKED for and ANSWERED, not assumed ──────────────
    if "promptedBy" not in host:
        fail("the host never saw an inbound request; its connection was not consented to")
    if need(host, "host", "promptedBy") != need(host, "host", "peerId"):
        fail("the host was prompted by a device other than the one it selected")

    # ── keys really were compared ───────────────────────────────────────────
    host_sas, guest_sas = need(host, "host", "sas"), need(guest, "guest", "sas")
    if not host_sas or not guest_sas:
        fail("a side reached CONNECTED with no SAS; the handshake did not complete")
    if host_sas != guest_sas:
        fail(
            f"the two devices derived DIFFERENT short authentication strings "
            f"({host_sas} vs {guest_sas}); they did not agree on a key"
        )

    # ── both wires are the one this build negotiates ────────────────────────
    for role, report in (("host", host), ("guest", guest)):
        wire = need(report, role, "wire")
        if wire != "LINK":
            fail(f"the {role} device established {wire}, not the link/1 wire")

    # ── the bytes, in BOTH directions, compared by digest ───────────────────
    if need(host, "host", "savedSha") != guest_sha:
        fail(
            "the host saved bytes that are not the ones the guest sent "
            f"({host['savedSha']} != {guest_sha})"
        )
    if need(guest, "guest", "savedSha") != host_sha:
        fail(
            "the guest saved bytes that are not the ones the host sent "
            f"({guest['savedSha']} != {host_sha})"
        )

    # ── the direct path's whole claim ───────────────────────────────────────
    if mode == "direct":
        for role, report in (("host", host), ("guest", guest)):
            hits = need(report, role, "backendConnections")
            if hits != 0:
                fail(
                    f"the {role} device opened {hits} connection(s) to the backend on the "
                    "DIRECT path, which must contact no server at all"
                )
    elif mode == "hub":
        for role, report in (("host", host), ("guest", guest)):
            if report.get("backendConnections") is not None:
                fail(f"the {role} hub round reported a backend trap; it must use a real server")
    else:
        fail(f"unknown mode {mode!r}")

    # ── neither half tore down while the other was still asserting ──────────
    #
    # `need`, so a round that never reached the barrier fails as that rather
    # than as whatever it failed at afterwards. "released" is the only value
    # that means both halves finished their own assertions.
    for role, report in (("host", host), ("guest", guest)):
        for field, guards in (
            ("barrier", "end the session the other was still reading"),
            ("barrierRoom", "stop advertising while the other was still checking its roster"),
        ):
            value = need(report, role, field)
            if value != "released":
                fail(
                    f"the {role} device did not pass the {field} barrier ({field}={value!r}); "
                    f"one side would have been free to {guards}"
                )

    # ── finishing returned to the list rather than ending the room ──────────
    for role, report in (("host", host), ("guest", guest)):
        after = need(report, role, "listedAfterDisconnect")
        if not isinstance(after, int) or after < 1:
            fail(
                f"the {role} device's room did not survive its own transfer "
                f"({after} devices listed afterwards)"
            )

    # ── the owned picker did not end the session ────────────────────────────
    #
    # `need`, not `.get(...)`: a claim about the picker that is absent from the
    # report is a claim nothing observed, and a default pass here would let a
    # run that fell back to calling the view model directly print the headline
    # about surviving a real DocumentsUI round trip.
    for role, report in (("host", host), ("guest", guest)):
        used_real = need(report, role, "realPicker")
        if real_picker != "0" and used_real is not True:
            fail(
                f"the {role} device did not drive the REAL document picker, but the run was "
                "not told to skip it. A direct view-model call does not stop this Activity, "
                "so it cannot show that an owned picker leaves the session alive"
            )
        if need(report, role, "survivedPicker") is not True:
            fail(
                f"the {role} device's session did not survive its own document picker; "
                "an ended-and-rejoined session is not continuity"
            )

    picker = "real DocumentsUI" if real_picker != "0" else "skipped (explicitly)"
    print(
        f"PASS mode={mode} picker={picker} sas={host_sas} "
        f"selected-side-role={selected_role} "
        f"host<-{host['savedSha'][:12]} guest<-{guest['savedSha'][:12]}"
    )
    print(
        f"NOTE this run covered the {selected_role} assignment for the selecting side. "
        "The other one is a different code path and needs its own green run.",
        file=sys.stderr,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())

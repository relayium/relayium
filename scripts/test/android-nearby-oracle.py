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
        fail(f"{what} is not {kind.__name__}; the schema is not the one this run asserts")
    return value


def strict_bool(value, what):
    """A real boolean, not something truthy.

    `1`, `"yes"` and a non-empty list are all truthy, and a receipt that carried
    any of them where a decision belongs is not a decision that was made.
    """
    if not isinstance(value, bool):
        fail(f"{what} is {type(value).__name__}, not a boolean; a truthy value is not a "
             "recorded decision")
    return value


def strict_count(value, what):
    """A real non-negative integer, and NEVER a boolean.

    `bool` is a subclass of `int` in Python, so `isinstance(True, int)` is True
    and `True >= 1` holds — which means a receipt that said `true` where a COUNT
    belongs would satisfy every count check in this file. That is exactly the
    shape a fabricated receipt takes, so it is refused by type before it is ever
    compared.
    """
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        fail(f"{what} is {value!r}, which is not a non-negative integer count "
             "(a boolean is never a count)")
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
    phase = typed(result.get("phase"), str, "the Apple peer's phase")
    if phase != "done":
        fail(
            f"the Apple peer finished in phase {phase!r}, not 'done'. A receipt from a run "
            "that did not complete is not evidence of a delivery"
        )
    if "failure" in result:
        fail("the Apple peer reported a failure alongside its receipt")

    # Its OWN answer about the origin it resolved, not the string we passed it.
    origin = typed(result.get("origin"), str, "the Apple peer's origin")
    if not origin.startswith("http://127.0.0.1:"):
        fail(f"the Apple peer resolved a non-loopback origin ({origin}); the run was not local")

    # ── exactly one file, and every field bound to THAT file ────────────────
    files = typed(result.get("files"), list, "the Apple peer's files array")
    if len(files) != 1:
        fail(
            f"the Apple peer received {len(files)} file(s); this round sends exactly one, so "
            "any other count means the receipt does not describe what was sent"
        )
    entry = typed(files[0], dict, "the Apple peer's file receipt")
    name = typed(entry.get("name"), str, "the Apple peer's file receipt name")
    sha = typed(entry.get("sha256"), str, "the Apple peer's file receipt sha256")
    size = typed(entry.get("size"), int, "the Apple peer's file receipt size")
    if "path" in entry:
        path = typed(entry.get("path"), str, "the Apple peer's file receipt path")
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
        messages = typed(observed.get("messages"), list, "the Apple peer's messages array")
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



def judge_web(android_path, browser_path, expect_path):
    """Android ↔ the real Web, in the code-less room, with two decoys.

    Every claim is re-derived from what the two halves INDEPENDENTLY observed and
    then cross-checked between them: the room's peer ids are one namespace, so
    the device the phone says it selected and the device the browser says it is
    have to be the same id, and neither half can produce that agreement alone.

    Nothing here is a substring match, nothing is taken from a free-text field,
    and no message body or file content is ever printed — a diagnostic is not a
    place to put content.
    """
    android = load(android_path, "android")
    browser = load(browser_path, "browser")
    expect = load(expect_path, "expectations")

    target_name = typed(expect.get("targetName"), str, "expected target name")
    decoy_names = typed(expect.get("decoyNames"), list, "expected decoy names")
    if len(decoy_names) != 2:
        fail("this round is defined with exactly two decoys; the expectations name "
             f"{len(decoy_names)}")
    want_real_picker = expect.get("realPicker") is True
    messages = typed(expect.get("messages"), dict, "expected messages")
    android_sends = typed(expect.get("androidSends"), list, "expected android files")
    browser_sends = typed(expect.get("browserSends"), list, "expected browser files")

    # ── both halves reached their own end ───────────────────────────────────
    if need(android, "android", "pass") is not True:
        fail("the Android half did not complete its round")
    if need(browser, "browser", "pass") is not True:
        fail("the browser half did not complete its round")

    # ── the run was local, by the phone's OWN answer ────────────────────────
    origin = typed(need(android, "android", "backendOrigin"), str, "resolved origin")
    if not origin.startswith("http://10.0.2.2:"):
        fail(f"the phone resolved {origin!r}, which is not this run's throwaway server. "
             "Backend.resolve fails closed to PRODUCTION, so this is the check that "
             "stands between an acceptance and the real service")

    # ── the negative control, if this is one ────────────────────────────────
    #
    # A positive round must NOT have been told to mis-tap. Read from the phone's
    # own report rather than from the shell's intent, so a run that was launched
    # with the control still set cannot be reported as an ordinary pass.
    if need(android, "android", "wrongSelection") is not False:
        fail("this report comes from a run that deliberately tapped the wrong row; "
             "it can only be judged as a negative control")
    if need(android, "android", "tappedRow") != target_name:
        fail(f"the phone tapped the row named {android['tappedRow']!r}, not {target_name!r}")

    # ── three candidates, and the target is not first ───────────────────────
    candidates = need(android, "android", "candidates")
    if not isinstance(candidates, int) or candidates < 3:
        fail(f"the phone listed {candidates} candidate(s); fewer than three cannot show "
             "that the RIGHT one was chosen out of several")
    expected_names = list(decoy_names) + [target_name]
    model_order = typed(need(android, "android", "candidateOrder"), list, "candidate order")
    shown_order = typed(need(android, "android", "displayedOrder"), list, "displayed order")
    for name in expected_names:
        if model_order.count(name) != 1:
            fail(f"the phone's candidate list holds {model_order.count(name)} entries named "
                 f"{name!r}; the round cannot say which device it measured")
    if sorted(shown_order) != sorted(expected_names):
        fail("the on-screen order does not describe exactly this round's three browser "
             f"devices (it names {len(shown_order)})")
    # Both orders, because "the model is sorted" and "the user sees them in that
    # order" are different claims, and a fallback to the first ROW is answered
    # only by the second one.
    if model_order.index(target_name) == 0:
        fail("the target was FIRST in the phone's own candidate order, so a client that "
             "simply took the first peer would have connected to it and this round would "
             "have proved nothing")
    if shown_order.index(target_name) == 0:
        fail("the target was the FIRST ROW on the phone's screen, so a client that took "
             "the first row would have connected to it and this round would have proved "
             "nothing")
    # The screen must agree with the model it renders. A disagreement is not a
    # verdict this round can interpret, so it fails rather than picking one.
    if shown_order != [n for n in model_order if n in expected_names]:
        fail("the phone's on-screen order disagrees with the model order it renders; "
             "this round cannot say which order a user would have chosen from")

    # ── the selection, agreed by BOTH halves ────────────────────────────────
    target_id = typed(need(android, "android", "targetId"), str, "target id")
    selected_id = typed(need(android, "android", "selectedId"), str, "selected id")
    if selected_id != target_id:
        fail("the phone connected to a device other than the named target")
    if need(android, "android", "selectedName") != target_name:
        fail(f"the phone's own state names its peer {android['selectedName']!r}, "
             f"not {target_name!r}")
    if need(browser, "browser", "targetName") != target_name:
        fail("the browser half was driving a different target than this round expects")
    browser_target_id = typed(
        typed(need(browser, "browser", "target"), dict, "target observation").get("selfId"),
        str, "the target browser's own peer id")
    # The cross-check neither half can produce alone: one room, one id namespace.
    if browser_target_id != target_id:
        fail("the device the phone selected is not the browser that answered "
             "(the two halves report different peer ids for the same name)")
    decoy_ids = typed(need(android, "android", "decoyIds"), list, "decoy ids")
    browser_decoy_ids = typed(need(browser, "browser", "decoyIds"), dict, "browser decoy ids")
    if sorted(decoy_ids) != sorted(browser_decoy_ids.values()):
        fail("the phone and the browsers disagree about which peer ids the decoys hold")
    if target_id in decoy_ids:
        fail("the target's id is also listed as a decoy's; the room's ids are not distinct")

    # ── the phone joined under the name the browsers matched ────────────────
    self_name = typed(need(android, "android", "selfName"), str, "the phone's announced name")
    if need(browser, "browser", "androidName") != self_name:
        fail("the browsers matched a different name than the phone announced, so 'the phone "
             "was in the room' is a claim about a room it may never have joined")
    listed_by = typed(need(browser, "browser", "androidListedBy"), dict, "roster observations")
    if sorted(listed_by.keys()) != sorted(expected_names):
        fail("not all three browser devices reported listing the phone")
    if len(set(listed_by.values())) != 1:
        fail("the three browser devices listed different ids for the phone's name")

    # ── the target joined LAST ──────────────────────────────────────────────
    join_order = typed(need(browser, "browser", "joinOrder"), list, "join order")
    if join_order[-1] != target_name:
        fail("the target did not join the room LAST, so it may have been the first entry "
             "the phone ever saw and a first-in-roster fallback would pass")

    # ── one authenticated link ──────────────────────────────────────────────
    if need(android, "android", "wire") != "LINK":
        fail(f"the browser was reached on {android['wire']}, not link/1")
    android_sas = need(android, "android", "sas")
    browser_sas = typed(browser["target"].get("sas"), str, "the browser's SAS")
    if not isinstance(android_sas, str) or not android_sas:
        fail("the phone reached CONNECTED with no SAS; the handshake did not complete")
    if not (len(android_sas) == 6 and android_sas.isdigit()):
        fail("the phone's short authentication string is not six digits")
    if android_sas != browser_sas:
        fail(f"the two clients derived DIFFERENT short authentication strings "
             f"({browser_sas} vs {android_sas}); they did not agree on a key")

    # ── the decoys, latched across the WHOLE run ────────────────────────────
    decoys = typed(need(browser, "browser", "decoys"), list, "decoy observations")
    if sorted(d.get("name") for d in decoys) != sorted(decoy_names):
        fail("the browser half did not report on exactly this round's two decoys")
    for decoy in decoys:
        name = decoy.get("name")
        # Anti-vacuity FIRST. Every number below is asserted to be zero or false,
        # and a latch that never looked reports exactly the same thing.
        if strict_count(decoy.get("latchTicks"), f"the decoy {name}'s latchTicks") < 1:
            fail(f"the decoy {name} never sampled its own DOM, so its zeroes mean nothing")
        if strict_count(decoy.get("latchChooser"), f"the decoy {name}'s latchChooser") < 1:
            fail(f"the decoy {name} never rendered a chooser surface, so its selectors "
                 "matched nothing and its zeroes mean nothing")
        # `strict_count` first: `False != 0` is False in Python, so a counterfeit
        # `false` here would read as a clean decoy.
        if strict_count(decoy.get("dialFrames"), f"the decoy {name}'s dialFrames") != 0:
            fail(f"the phone sent the decoy {name} {decoy.get('dialFrames')} establishment "
                 f"frame(s) {decoy.get('dialShapes')}; it dialled a device it was not told to")
        for field, what in (("everHead", "a workspace"), ("everPanel", "a message panel"),
                            ("everFileRequest", "a file consent card"),
                            ("everTextRequest", "a text consent card")):
            if strict_bool(decoy.get(field), f"the decoy {name}'s {field}"):
                fail(f"the decoy {name} rendered {what} at some point; a session that was "
                     "opened and then abandoned is still a wrong selection")

    # ── the text, judged at each RECEIVING side ─────────────────────────────
    to_browser = typed(messages.get("androidToBrowser"), str, "the phone's message")
    to_android = typed(messages.get("browserToAndroid"), str, "the browser's message")
    received = typed(browser["target"].get("receivedMessages"), list, "received messages")
    # By EQUALITY against each entry, never by containment: a message that arrived
    # with different whitespace is a DIFFERENT message, and that is exactly the
    # class of defect a text lane can have. The browser reads only INBOUND bodies,
    # so its own echo cannot satisfy this.
    if not any(isinstance(m, str) and m == to_browser for m in received):
        fail(f"the browser's {len(received)} received message(s) do not include the exact "
             "body the phone sent. Not printed here on purpose")
    if need(android, "android", "peerMessageReceived") is not True:
        fail("the phone never observed the browser's message")
    if need(android, "android", "messageSent") != to_browser:
        fail("the phone sent a different body than this round declares")
    if need(browser, "browser", "sent").get("message") != to_android:
        fail("the browser sent a different body than this round declares")

    # ── the files, per file, at each RECEIVING side ─────────────────────────
    #
    # Bound to the SAME record each time. A name satisfied by one file and a
    # digest by another is not a receipt, and a global search for a digest
    # somewhere in a document is not one either.
    saved = typed(browser["target"].get("receivedFiles"), list, "the browser's save ledger")
    if len(saved) != len(android_sends):
        fail(f"the browser completed {len(saved)} save(s); the phone sent "
             f"{len(android_sends)}. An extra or a missing save means the ledger does not "
             "describe what was sent")
    for want in android_sends:
        matches = [r for r in saved if r.get("name") == want["name"]]
        if len(matches) != 1:
            fail(f"the browser saved {len(matches)} file(s) named {want['name']!r}")
        got = matches[0]
        if got.get("size") != want["size"]:
            fail(f"the browser saved {got.get('size')} bytes for {want['name']!r}, "
                 f"not {want['size']}")
        if got.get("sha256") != want["sha256"]:
            fail(f"the bytes the browser saved for {want['name']!r} are not the bytes the "
                 f"phone sent ({str(got.get('sha256'))[:12]}… vs {want['sha256'][:12]}…)")

    landed = typed(need(android, "android", "savedFiles"), list, "the phone's saved files")
    if len(landed) != len(browser_sends):
        fail(f"the phone saved {len(landed)} file(s); the browser sent {len(browser_sends)}")
    for want in browser_sends:
        matches = [r for r in landed if r.get("path") == want["path"]]
        if len(matches) != 1:
            fail(f"the phone holds {len(matches)} file(s) at {want['path']!r}. The PATH is "
                 "the claim: a nested file that landed flat satisfies a name check and is "
                 "still the wrong tree")
        got = matches[0]
        if got.get("size") != want["size"]:
            fail(f"the phone saved {got.get('size')} bytes at {want['path']!r}, "
                 f"not {want['size']}")
        if got.get("sha256") != want["sha256"]:
            fail(f"the bytes the phone saved at {want['path']!r} are not the bytes the "
                 f"browser sent ({str(got.get('sha256'))[:12]}… vs {want['sha256'][:12]}…)")
    sent_names = [f.get("name") for f in typed(
        browser["sent"].get("files"), list, "the browser's sent files")]
    if sorted(sent_names) != sorted(f["name"] for f in browser_sends):
        fail("the browser did not attach the files this round declares")

    # ── the TEXT consent, judged against the negotiation that happened ──────
    #
    # This used to demand that the BROWSER answered a consent card, and that was
    # a party contract the product does not have. The shipped Web opens the text
    # lane by itself, once per authenticated link (`App.svelte`'s `textOpener`),
    # so on an ordinary round the phone is the side holding an INCOMING_REQUEST
    # and the browser correctly never sees one. Run v4 passed every real
    # assertion and failed on that stale rule.
    #
    # What must be true is not "the browser accepted" but "a consent prompt was
    # ANSWERED, through real UI, by whichever endpoint was actually offered one"
    # — and the side that did NOT answer must be the side that INITIATED. Both
    # legitimate directions satisfy that; neither answering does not.
    negotiation = typed(need(android, "android", "textNegotiation"), dict,
                        "the phone's text-lane negotiation receipt")
    native_requested = strict_bool(negotiation.get("requestedLocally"),
                                   "the phone's requestedLocally")
    native_saw = strict_bool(negotiation.get("sawIncomingRequest"),
                             "the phone's sawIncomingRequest")
    native_prompts = strict_count(negotiation.get("incomingPrompts"),
                                  "the phone's incomingPrompts")
    # ACCEPTED PROMPTS, never raw clicks: the card can still be on screen on the
    # tick after a successful press, and a second click on the SAME prompt is not
    # a second person answering a second question.
    native_accepted = strict_count(negotiation.get("acceptedPrompts"),
                                   "the phone's acceptedPrompts")
    native_clicks = strict_count(negotiation.get("acceptClicks"), "the phone's acceptClicks")
    native_open = strict_bool(negotiation.get("openedAfterAccept"),
                              "the phone's openedAfterAccept")
    browser_accepted = strict_bool(browser["target"].get("acceptedTextRequest"),
                                   "the browser's acceptedTextRequest")
    browser_clicks = strict_count(browser["target"].get("textConsentClicks"),
                                  "the browser's textConsentClicks")

    if native_saw != (native_prompts > 0):
        fail("the phone's receipt says it did and did not see an incoming request")
    if native_accepted > native_prompts:
        fail(f"the phone answered {native_accepted} prompt(s) but only {native_prompts} were "
             "ever offered; a repeated click on one card is not a second prompt")
    if native_accepted > native_clicks:
        fail("the phone answered more prompts than it recorded clicks")
    if native_open != (native_accepted > 0):
        fail("the phone's openedAfterAccept disagrees with its own accepted-prompt count")
    if browser_accepted != (browser_clicks > 0):
        fail("the browser's consent flag disagrees with its own click count")

    native_answered = native_accepted > 0 and native_open
    browser_answered = browser_accepted and browser_clicks > 0
    if not (native_answered or browser_answered):
        fail("NEITHER endpoint answered a text consent prompt, so this round never went "
             "through the stop a person is meant to answer")
    # Whoever did not answer must account for the prompt the other one answered.
    #
    # A prompt the PHONE answered came from the peer by construction — the lane
    # cannot offer this side a request it did not receive — so `native_prompts`
    # is itself the evidence the browser opened it. The other direction needs
    # saying out loud: a browser that answered a card while the phone never
    # asked would mean a consent card appeared with nothing behind it.
    if browser_answered and not native_answered and not native_requested:
        fail("the browser answered a text consent card but the phone never asked for the "
             "lane, so nothing accounts for the request the browser answered")
    if native_answered and browser_answered:
        # A genuine simultaneous open is possible and the lane's own rules
        # resolve it. Allowed, and reported, because it is a different path.
        initiation = "collision"
    elif native_answered:
        initiation = "web-opened"
    else:
        initiation = "android-opened"

    accepted_files = strict_count(browser["target"].get("acceptedFileRequests"),
                                  "the browser's acceptedFileRequests")
    if accepted_files < 1:
        fail("the browser never answered a file consent card")

    # ── the real pickers, and the session that survived them ────────────────
    used_real = need(android, "android", "realPicker")
    if want_real_picker and used_real is not True:
        fail("the phone did not drive the REAL document picker, but the run was not told to "
             "skip it. A direct view-model call does not stop this Activity, so it cannot "
             "show that an owned picker leaves the session alive")
    if need(android, "android", "survivedPicker") is not True:
        fail("the phone's session did not survive its own document picker; an ended-and-"
             "rejoined session is not continuity")
    if need(android, "android", "sentBatchCount") < len(android_sends):
        fail(f"the browser confirmed {android['sentBatchCount']} batch(es); the phone sent "
             f"{len(android_sends)}")
    if need(android, "android", "savedBatchCount") < 1:
        fail("the phone completed no incoming batch")

    # ── neither half tore down while the other was still asserting ──────────
    for who, report in (("android", android), ("browser", browser)):
        for field, guards in (
            ("barrier", "end the session the other was still reading"),
            ("barrierRoom", "leave the room while the other was still checking its roster"),
        ):
            value = need(report, who, field)
            if value != "released":
                fail(f"the {who} half did not pass the {field} barrier ({field}={value!r}); "
                     f"one side would have been free to {guards}")

    # ── the room outlived its own transfer ──────────────────────────────────
    after = need(android, "android", "listedAfterDisconnect")
    if not isinstance(after, int) or after < len(expected_names):
        fail(f"the phone listed {after} device(s) after disconnecting; the room did not "
             "survive its own transfer")
    names_after = typed(need(android, "android", "namesAfterDisconnect"), list,
                        "the names listed after the disconnect")
    for name in expected_names:
        if name not in names_after:
            fail(f"the browser device {name!r} was gone from the phone's list after the "
                 "transfer; the room did not survive it")

    print(
        f"PASS counterpart=web wire=LINK sas={android_sas} candidates={candidates} "
        f"model-order={model_order.index(target_name)} "
        f"screen-order={shown_order.index(target_name)} decoys-clean={len(decoys)} "
        f"android->browser={len(android_sends)} browser->android={len(browser_sends)} "
        f"text-initiation={initiation} consent-answered-by="
        f"{'phone' if native_answered else ''}{'+' if native_answered and browser_answered else ''}"
        f"{'browser' if browser_answered else ''}"
    )
    print(
        "NOTE emulator and a headless browser, never a physical phone; the hub room only, "
        "not the direct path. Save-as and the folder-relative path are stubbed on the "
        "browser side (see web/e2e/android-nearby-hub.mjs).",
        file=sys.stderr,
    )
    return 0


def judge_web_negative(android_path, browser_path, expect_path):
    """The `wrong-selection` control, judged on TYPED evidence.

    "The run failed" is not the claim. A crash, a missing runner, a build that
    never produced an APK or a plain timeout all make a run fail, and none of
    them says anything about whether a wrong selection is DETECTABLE — so a
    control that accepted any failure would be a control that always holds.

    What must be true instead, and every part of it is read from a field rather
    than inferred:

      * the phone ran far enough to make a selection AT ALL — it listed three
        candidates, recorded both orders, and named the row it tapped;
      * it tapped the FIRST row on screen, and that row is not the target;
      * the mismatch actually materialised: it connected, and to a DECOY;
      * the browser corroborates it — that same decoy was dialled or rendered a
        session, latched across the run rather than sampled at the end;
      * and neither half reported a pass.

    A round missing any of those fails this judge, so an inconclusive control is
    reported as inconclusive rather than as evidence.
    """
    android = load(android_path, "android")
    browser = load(browser_path, "browser")
    expect = load(expect_path, "expectations")
    target_name = typed(expect.get("targetName"), str, "the expected target name")
    decoy_names = typed(expect.get("decoyNames"), list, "the expected decoy names")

    if need(android, "android", "wrongSelection") is not True:
        fail("this report is not from a wrong-selection run, so it cannot be judged as the "
             "negative control")

    # The phone must have got as far as SELECTING. Every field below is required,
    # so a crash before the device list — the failure that proves nothing — fails
    # here instead of being counted as the control holding.
    candidates = need(android, "android", "candidates")
    if not isinstance(candidates, int) or candidates < 3:
        fail(f"the control listed {candidates} candidate(s); it never reached the state in "
             "which a wrong selection is even possible")
    shown_order = typed(need(android, "android", "displayedOrder"), list, "the displayed order")
    typed(need(android, "android", "candidateOrder"), list, "the candidate order")
    tapped = typed(need(android, "android", "tappedRow"), str, "the row that was tapped")
    if not shown_order:
        fail("the control recorded an empty on-screen order")
    if tapped != shown_order[0]:
        fail(f"the control tapped {tapped!r}, which is not the FIRST row on screen "
             f"({shown_order[0]!r}); it did not exercise the fallback it exists to catch")
    if tapped == target_name:
        fail("the control tapped the TARGET row, so it is not a wrong selection at all")
    if tapped not in decoy_names:
        fail(f"the control tapped {tapped!r}, which is neither the target nor a known decoy")

    # And the mismatch must have MATERIALISED. A phone that tapped a decoy and
    # then failed to connect to anything would leave the selection invariant
    # untested — the assertion this control exists to trip is "the id it
    # connected to is not the target's".
    target_id = typed(need(android, "android", "targetId"), str, "the target's id")
    selected_id = typed(need(android, "android", "selectedId"), str, "the selected id")
    if not selected_id:
        fail("the control never connected to anything, so the target-vs-selected assertion "
             "was never reached and this run does not show it works")
    if selected_id == target_id:
        fail("the control tapped a decoy row but still connected to the TARGET; that is a "
             "row-to-peer binding failure in the other direction and is not a held control")
    decoy_ids = typed(need(android, "android", "decoyIds"), list, "the decoy ids")
    if selected_id not in decoy_ids:
        fail("the control connected to a device that is neither the target nor a listed decoy")

    # The browser's own, independent corroboration: the decoy that was tapped
    # must have been dialled or have rendered a session. Latched across the run,
    # so a session that was opened and abandoned still counts.
    decoys = typed(need(browser, "browser", "decoys"), list, "the decoy observations")
    hit = [d for d in decoys if d.get("name") == tapped]
    if len(hit) != 1:
        fail(f"the browser half reported {len(hit)} observation(s) for the decoy that was "
             "tapped, so it cannot corroborate the wrong dial")
    seen = hit[0]
    dialled = isinstance(seen.get("dialFrames"), int) and seen["dialFrames"] > 0
    rendered = any(seen.get(field) is True for field in
                   ("everHead", "everPanel", "everFileRequest", "everTextRequest"))
    if not (dialled or rendered):
        fail(f"the browser half saw nothing at the decoy {tapped!r} — no establishment frame "
             "and no rendered session. The phone's own report says it connected there, so "
             "the two halves disagree and this control shows nothing")

    if android.get("pass") is True:
        fail("the phone reported a PASS on a wrong-selection run; its own assertions did not "
             "catch the mis-tap")
    if browser.get("pass") is True:
        fail("the browser half reported a PASS on a wrong-selection run; its decoy assertions "
             "did not catch the wrong dial")

    print(
        f"NEGATIVE-CONTROL HELD tapped={tapped} target={target_name} "
        f"selected!=target=yes decoy-corroboration={'wire' if dialled else 'dom'} "
        f"candidates={candidates}"
    )
    return 0


def selftest():
    """Executable negative controls for the `web` mode.

    An oracle nobody has tried to fool is a formatting exercise. This builds one
    report set that MUST pass, then mutates it one field at a time and requires
    every mutation to be REJECTED — including the ones that fail closed, where a
    field is deleted rather than falsified, because "the round never got far
    enough to write it" and "the round got there and the answer was false" must
    not look the same.

    Runs with no device, no browser and no server, so it is part of an ordinary
    edit-time check rather than something only a full round can exercise.
    """
    import copy
    import tempfile
    import os

    sha_a = "a" * 64
    sha_b = "b" * 64
    sha_c = "c" * 64
    sha_d = "d" * 64
    expect = {
        "targetName": "relayium-web-target-zz",
        "decoyNames": ["relayium-web-decoy-01", "relayium-web-decoy-02"],
        "realPicker": True,
        "messages": {"androidToBrowser": "  hi \u00fc", "browserToAndroid": "there\n\t",
                     "ready": "relayium-nearby-web:ready"},
        "androidSends": [{"name": "android-large.bin", "size": 307200, "sha256": sha_a},
                         {"name": "android-zero.bin", "size": 0, "sha256": sha_b}],
        "browserSends": [{"name": "web-large.bin", "path": "web-large.bin",
                          "size": 307200, "sha256": sha_c},
                         {"name": "n.bin", "path": "outer dir/inner/n.bin",
                          "size": 1234, "sha256": sha_d}],
    }
    android = {
        "pass": True, "backendOrigin": "http://10.0.2.2:41234", "wrongSelection": False,
        "tappedRow": "relayium-web-target-zz", "candidates": 3,
        "candidateOrder": ["relayium-web-decoy-01", "relayium-web-decoy-02",
                           "relayium-web-target-zz"],
        "displayedOrder": ["relayium-web-decoy-01", "relayium-web-decoy-02",
                           "relayium-web-target-zz"],
        "targetId": "T", "selectedId": "T", "selectedName": "relayium-web-target-zz",
        "decoyIds": ["D1", "D2"], "selfName": "sdk_gphone64_arm64",
        "wire": "LINK", "sas": "123456",
        "peerMessageReceived": True, "messageSent": "  hi \u00fc",
        "savedFiles": [{"path": "web-large.bin", "size": 307200, "sha256": sha_c},
                       {"path": "outer dir/inner/n.bin", "size": 1234, "sha256": sha_d}],
        "realPicker": True, "survivedPicker": True,
        # The shape an ordinary round produces: the shipped Web opened the lane,
        # so the PHONE is the endpoint holding the consent prompt.
        "textNegotiation": {
            "requestedLocally": False, "sawIncomingRequest": True,
            "incomingPrompts": 1, "acceptedPrompts": 1, "acceptClicks": 2,
            "openedAfterAccept": True, "finalTextState": "OPEN",
        },
        "sentBatchCount": 2, "savedBatchCount": 1,
        "barrier": "released", "barrierRoom": "released",
        "listedAfterDisconnect": 3,
        "namesAfterDisconnect": ["relayium-web-decoy-01", "relayium-web-decoy-02",
                                 "relayium-web-target-zz"],
    }
    clean_decoy = {"dialFrames": 0, "dialShapes": [], "everHead": False, "everPanel": False,
                   "everFileRequest": False, "everTextRequest": False,
                   "latchTicks": 40, "latchChooser": 12}
    browser = {
        "pass": True, "androidName": "sdk_gphone64_arm64",
        "targetName": "relayium-web-target-zz",
        "joinOrder": ["relayium-web-decoy-01", "relayium-web-decoy-02",
                      "relayium-web-target-zz"],
        "androidListedBy": {"relayium-web-decoy-01": "A", "relayium-web-decoy-02": "A",
                            "relayium-web-target-zz": "A"},
        "decoyIds": {"relayium-web-decoy-01": "D1", "relayium-web-decoy-02": "D2"},
        "target": {"selfId": "T", "sas": "123456",
                   "receivedMessages": ["  hi \u00fc"],
                   "receivedFiles": [
                       {"name": "android-large.bin", "size": 307200, "sha256": sha_a},
                       {"name": "android-zero.bin", "size": 0, "sha256": sha_b}],
                   "acceptedTextRequest": False, "textConsentClicks": 0,
                   "acceptedFileRequests": 1},
        "sent": {"message": "there\n\t",
                 "files": [{"name": "web-large.bin"}, {"name": "n.bin"}]},
        "decoys": [dict(clean_decoy, name="relayium-web-decoy-01"),
                   dict(clean_decoy, name="relayium-web-decoy-02")],
        "barrier": "released", "barrierRoom": "released",
    }

    def run(a, b, e):
        root = tempfile.mkdtemp(prefix="nearby-web-oracle-")
        paths = []
        for name, doc in (("a.json", a), ("b.json", b), ("e.json", e)):
            path = os.path.join(root, name)
            with open(path, "w", encoding="utf-8") as handle:
                json.dump(doc, handle, ensure_ascii=False)
            paths.append(path)
        try:
            return judge_web(*paths)
        except SystemExit as exit_code:
            return exit_code.code or 1

    def drop(doc, *path):
        out = copy.deepcopy(doc)
        node = out
        for key in path[:-1]:
            node = node[key]
        del node[path[-1]]
        return out

    def put(doc, value, *path):
        out = copy.deepcopy(doc)
        node = out
        for key in path[:-1]:
            node = node[key]
        node[path[-1]] = value
        return out

    if run(android, browser, expect) != 0:
        print("SELFTEST FAIL: the clean fixture (Web opened, phone answered) does not pass",
              file=sys.stderr)
        return 1

    # BOTH legitimate initiations must be accepted. Which endpoint answers is
    # decided by the shipped design, so an oracle that only accepted one of them
    # would be asserting a party contract the product does not have — which is
    # exactly the rule run v4 failed on.
    android_asked = put(android, {"requestedLocally": True, "sawIncomingRequest": False,
                                  "incomingPrompts": 0, "acceptedPrompts": 0, "acceptClicks": 0,
                                  "openedAfterAccept": False, "finalTextState": "OPEN"},
                        "textNegotiation")
    browser_answered_fixture = put(put(browser, True, "target", "acceptedTextRequest"),
                                   2, "target", "textConsentClicks")
    if run(android_asked, browser_answered_fixture, expect) != 0:
        print("SELFTEST FAIL: the phone-opened / browser-answered round does not pass",
              file=sys.stderr)
        return 1
    # And a genuine simultaneous open, which the lane's own rules resolve.
    both = put(android, {"requestedLocally": True, "sawIncomingRequest": True,
                         "incomingPrompts": 1, "acceptedPrompts": 1, "acceptClicks": 1,
                         "openedAfterAccept": True, "finalTextState": "OPEN"},
               "textNegotiation")
    if run(both, browser_answered_fixture, expect) != 0:
        print("SELFTEST FAIL: a genuine simultaneous open does not pass", file=sys.stderr)
        return 1

    controls = [
        ("the phone was pointed at production",
         put(android, "https://relayium.com", "backendOrigin"), browser),
        ("the wrong row was tapped", put(android, "relayium-web-decoy-01", "tappedRow"), browser),
        ("the run was a negative control", put(android, True, "wrongSelection"), browser),
        ("only two candidates were listed", put(android, 2, "candidates"), browser),
        ("the target was FIRST in the model order",
         put(android, ["relayium-web-target-zz", "relayium-web-decoy-01",
                       "relayium-web-decoy-02"], "candidateOrder"), browser),
        ("the target was the FIRST ROW on screen",
         put(android, ["relayium-web-target-zz", "relayium-web-decoy-01",
                       "relayium-web-decoy-02"], "displayedOrder"), browser),
        ("the phone connected to another id", put(android, "D1", "selectedId"), browser),
        ("the two halves disagree about the target's id",
         android, put(browser, "OTHER", "target", "selfId")),
        ("the browsers matched another name", android, put(browser, "someone-else", "androidName")),
        ("the target joined FIRST", android,
         put(browser, ["relayium-web-target-zz", "relayium-web-decoy-01",
                       "relayium-web-decoy-02"], "joinOrder")),
        ("the wire was not link/1", put(android, "LEGACY", "wire"), browser),
        ("the SAS is not six digits", put(android, "12345", "sas"), browser),
        ("the two SAS values differ", android, put(browser, "654321", "target", "sas")),
        ("a decoy was dialled", android,
         put(browser, [dict(clean_decoy, name="relayium-web-decoy-01", dialFrames=3),
                       dict(clean_decoy, name="relayium-web-decoy-02")], "decoys")),
        ("a decoy rendered a workspace", android,
         put(browser, [dict(clean_decoy, name="relayium-web-decoy-01", everHead=True),
                       dict(clean_decoy, name="relayium-web-decoy-02")], "decoys")),
        ("a decoy's latch never looked", android,
         put(browser, [dict(clean_decoy, name="relayium-web-decoy-01", latchTicks=0),
                       dict(clean_decoy, name="relayium-web-decoy-02")], "decoys")),
        ("a decoy's selectors matched nothing", android,
         put(browser, [dict(clean_decoy, name="relayium-web-decoy-01", latchChooser=0),
                       dict(clean_decoy, name="relayium-web-decoy-02")], "decoys")),
        ("the message arrived with different whitespace", android,
         put(browser, ["hi \u00fc"], "target", "receivedMessages")),
        ("a saved file has the wrong digest", android,
         put(browser, [{"name": "android-large.bin", "size": 307200, "sha256": sha_b},
                       {"name": "android-zero.bin", "size": 0, "sha256": sha_b}],
             "target", "receivedFiles")),
        ("a saved file has the wrong size", android,
         put(browser, [{"name": "android-large.bin", "size": 1, "sha256": sha_a},
                       {"name": "android-zero.bin", "size": 0, "sha256": sha_b}],
             "target", "receivedFiles")),
        ("the browser saved an extra file", android,
         put(browser, [{"name": "android-large.bin", "size": 307200, "sha256": sha_a},
                       {"name": "android-zero.bin", "size": 0, "sha256": sha_b},
                       {"name": "stray.bin", "size": 1, "sha256": sha_c}],
             "target", "receivedFiles")),
        ("the nested file landed FLAT",
         put(android, [{"path": "web-large.bin", "size": 307200, "sha256": sha_c},
                       {"path": "n.bin", "size": 1234, "sha256": sha_d}], "savedFiles"),
         browser),
        ("the nested file has the wrong digest",
         put(android, [{"path": "web-large.bin", "size": 307200, "sha256": sha_c},
                       {"path": "outer dir/inner/n.bin", "size": 1234, "sha256": sha_a}],
             "savedFiles"), browser),
        ("NEITHER endpoint answered a text consent prompt",
         put(android, {"requestedLocally": True, "sawIncomingRequest": False,
                       "incomingPrompts": 0, "acceptedPrompts": 0, "acceptClicks": 0,
                       "openedAfterAccept": False, "finalTextState": "OPEN"},
             "textNegotiation"), browser),
        ("the phone's receipt is missing entirely", drop(android, "textNegotiation"), browser),
        ("the phone claims more accepted prompts than were offered",
         put(android, {"requestedLocally": False, "sawIncomingRequest": True,
                       "incomingPrompts": 1, "acceptedPrompts": 2, "acceptClicks": 2,
                       "openedAfterAccept": True, "finalTextState": "OPEN"},
             "textNegotiation"), browser),
        ("a repeated click on ONE card is counted as a second prompt",
         put(android, {"requestedLocally": False, "sawIncomingRequest": True,
                       "incomingPrompts": 1, "acceptedPrompts": 1, "acceptClicks": 1,
                       "openedAfterAccept": True, "finalTextState": "OPEN"},
             "textNegotiation"),
         put(browser, True, "target", "acceptedTextRequest")),
        ("the phone's own flags contradict each other",
         put(android, {"requestedLocally": False, "sawIncomingRequest": False,
                       "incomingPrompts": 1, "acceptedPrompts": 1, "acceptClicks": 1,
                       "openedAfterAccept": True, "finalTextState": "OPEN"},
             "textNegotiation"), browser),
        ("openedAfterAccept is claimed with no accepted prompt",
         put(android, {"requestedLocally": False, "sawIncomingRequest": True,
                       "incomingPrompts": 1, "acceptedPrompts": 0, "acceptClicks": 0,
                       "openedAfterAccept": True, "finalTextState": "OPEN"},
             "textNegotiation"), browser),
        # COUNTERFEIT TYPES. `bool` is a subclass of `int`, so `True` satisfies
        # every naive count check — which is the shape a fabricated receipt takes.
        ("a boolean is passed off as a prompt COUNT",
         put(android, {"requestedLocally": False, "sawIncomingRequest": True,
                       "incomingPrompts": True, "acceptedPrompts": True, "acceptClicks": True,
                       "openedAfterAccept": True, "finalTextState": "OPEN"},
             "textNegotiation"), browser),
        ("a count is passed off as the browser's consent DECISION", android,
         put(put(browser, 1, "target", "acceptedTextRequest"), 1, "target", "textConsentClicks")),
        ("a boolean is passed off as the file-consent count", android,
         put(browser, True, "target", "acceptedFileRequests")),
        ("a boolean is passed off as a decoy's dial count", android,
         put(browser, [dict(clean_decoy, name="relayium-web-decoy-01", dialFrames=False),
                       dict(clean_decoy, name="relayium-web-decoy-02")], "decoys")),
        ("a truthy value is passed off as a decoy's session flag", android,
         put(browser, [dict(clean_decoy, name="relayium-web-decoy-01", everHead=1),
                       dict(clean_decoy, name="relayium-web-decoy-02")], "decoys")),
        ("no file consent was answered", android,
         put(browser, 0, "target", "acceptedFileRequests")),
        ("the browser answered a card the phone never asked for",
         put(android, {"requestedLocally": False, "sawIncomingRequest": False,
                       "incomingPrompts": 0, "acceptedPrompts": 0, "acceptClicks": 0,
                       "openedAfterAccept": False, "finalTextState": "OPEN"},
             "textNegotiation"),
         put(put(browser, True, "target", "acceptedTextRequest"),
             1, "target", "textConsentClicks")),
        ("the real picker was skipped without being told to",
         put(android, False, "realPicker"), browser),
        ("the session did not survive the picker",
         put(android, False, "survivedPicker"), browser),
        ("a batch was never confirmed by the peer",
         put(android, 1, "sentBatchCount"), browser),
        ("the phone left the transfer barrier early",
         put(android, "waiting", "barrier"), browser),
        ("the browser left the room barrier early", android,
         put(browser, "waiting", "barrierRoom")),
        ("the room did not survive the transfer",
         put(android, 1, "listedAfterDisconnect"), browser),
        ("a browser device was gone from the list afterwards",
         put(android, ["relayium-web-decoy-01", "relayium-web-decoy-02"],
             "namesAfterDisconnect"), browser),
        ("the phone never reported its pass", drop(android, "pass"), browser),
        # Fail-CLOSED controls: the field is absent, not false.
        ("the displayed order was never recorded", drop(android, "displayedOrder"), browser),
        ("the decoy observations are missing", android, drop(browser, "decoys")),
        ("the room barrier was never recorded", drop(android, "barrierRoom"), browser),
    ]

    failures = []
    for label, a, b in controls:
        if run(a, b, expect) == 0:
            failures.append(label)

    # ── and the negative CONTROL's own judge ────────────────────────────────
    #
    # It has the same failure mode as the oracle it guards, one level up: a
    # control that accepted any failing run would always hold, and would
    # therefore say nothing. So a properly held control is built and must be
    # accepted, and every way a run could fail WITHOUT exercising the selection
    # — a crash before the list, a tap that never connected, a browser that saw
    # nothing at the decoy — must be rejected.
    held_android = dict(
        android, wrongSelection=True, tappedRow="relayium-web-decoy-01",
        selectedId="D1", selectedName="relayium-web-decoy-01", pass_placeholder=None,
    )
    del held_android["pass_placeholder"]
    del held_android["pass"]
    held_browser = copy.deepcopy(browser)
    del held_browser["pass"]
    held_browser["decoys"] = [dict(clean_decoy, name="relayium-web-decoy-01", dialFrames=4,
                                   everHead=True),
                              dict(clean_decoy, name="relayium-web-decoy-02")]

    def run_negative(a, b):
        root = tempfile.mkdtemp(prefix="nearby-web-negative-")
        paths = []
        for name, doc in (("a.json", a), ("b.json", b), ("e.json", expect)):
            path = os.path.join(root, name)
            with open(path, "w", encoding="utf-8") as handle:
                json.dump(doc, handle, ensure_ascii=False)
            paths.append(path)
        try:
            return judge_web_negative(*paths)
        except SystemExit as exit_code:
            return exit_code.code or 1

    if run_negative(held_android, held_browser) != 0:
        failures.append("the properly HELD control was rejected by its own judge")

    negative_controls = [
        ("the run was not a wrong-selection run at all",
         put(held_android, False, "wrongSelection"), held_browser),
        ("it crashed before the device list", drop(held_android, "candidates"), held_browser),
        ("it never recorded the on-screen order",
         drop(held_android, "displayedOrder"), held_browser),
        ("it tapped a row that was not the first one",
         put(held_android, "relayium-web-decoy-02", "tappedRow"), held_browser),
        ("it tapped the TARGET row", put(put(held_android, "relayium-web-target-zz", "tappedRow"),
                                         ["relayium-web-target-zz", "relayium-web-decoy-01",
                                          "relayium-web-decoy-02"], "displayedOrder"),
         held_browser),
        ("it never connected to anything", put(held_android, "", "selectedId"), held_browser),
        ("it tapped a decoy but connected to the TARGET",
         put(held_android, "T", "selectedId"), held_browser),
        ("the browser saw nothing at the decoy that was tapped", held_android,
         put(held_browser, [dict(clean_decoy, name="relayium-web-decoy-01"),
                            dict(clean_decoy, name="relayium-web-decoy-02")], "decoys")),
        ("the phone reported a PASS anyway", put(held_android, True, "pass"), held_browser),
        ("the browser reported a PASS anyway", held_android, put(held_browser, True, "pass")),
    ]
    for label, a, b in negative_controls:
        if run_negative(a, b) == 0:
            failures.append(f"[negative judge] {label}")

    if failures:
        print(f"SELFTEST FAIL: {len(failures)} control(s) were ACCEPTED:", file=sys.stderr)
        for label in failures:
            print(f"  - {label}", file=sys.stderr)
        return 1
    print(f"SELFTEST PASS web: 1 clean fixture accepted and {len(controls)} negative controls "
          f"rejected; 1 held wrong-selection control accepted and {len(negative_controls)} "
          "inconclusive ones rejected")
    return 0


def main():
    if len(sys.argv) >= 2 and sys.argv[1] == "--selftest":
        return selftest()
    if len(sys.argv) >= 3 and sys.argv[1] == "--counterpart" \
            and sys.argv[2] in ("web", "web-negative"):
        if len(sys.argv) != 6:
            print(
                f"usage: android-nearby-oracle.py --counterpart {sys.argv[2]} ANDROID_REPORT "
                "BROWSER_OBSERVATION EXPECTATIONS",
                file=sys.stderr,
            )
            return 2
        judge = judge_web if sys.argv[2] == "web" else judge_web_negative
        return judge(sys.argv[3], sys.argv[4], sys.argv[5])
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

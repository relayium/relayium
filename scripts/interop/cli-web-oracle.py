#!/usr/bin/env python3
"""The judge of one CLI ↔ Web round (A12).

    cli-web-oracle.py PLAN.json OBSERVED.json
    cli-web-oracle.py accepted-prefix SERVER.log IDS_CSV EXPECTED
    cli-web-oracle.py peer-id-log SERVER.log IDS_CSV

Exit 0 and print the CLI's link role (`initiator`/`responder`) on stdout when
the round agrees; exit 1 with every problem on stderr when it does not.

It trusts neither endpoint's own summary:
  * the CLI's received TREE is read off disk here, every regular file hashed
    here, and compared with digests derived here from the plan's seeds — an
    extra file (a declined or cancelled batch, a leftover partial or staging
    file) fails as surely as a missing one;
  * the page's saves come from its save ledger (bytes the product wrote,
    hashed in the page) and are compared with digests derived here;
  * the CLI's stdout must be EXACTLY the page's two messages, each followed by
    the newline `pair` appends off a terminal — stdout carries the peer's words
    and nothing else (A10 output contract);
  * every outcome line the CLI owes is counted, not merely found once;
  * both ends' own statements of the link role must be complementary, and on a
    `verify=on` round the two SAS must be the same digits.

## Who played which role

The plan's `identity` is the deterministic schedule (`cli-matrix-plan.py
web`): every websocket the round opens, in order, with the id the loopback
acceptance server assigns it (`RELAYIUM_ACCEPTANCE_PEER_IDS`) and the role the
CLI's and the code room's ids imply (`linkwire.LinkRole`: the smaller id
initiates). It is re-derived and checked here, then judged against what
happened: the CLI's ONE `linked with …` line must name the planned role; the
page's own wire history — every document it loaded, every websocket each
document opened, and every welcome and roster each socket received, recorded
in the page before any navigation reset it — must be exactly the planned
sockets, each welcomed ONCE as its planned id, with no other client in any
room; and the driver must have confirmed each socket's accepted prefix, with
every actor it had started still alive, before opening the next one. An extra,
refused or reconnected socket is a failure, never a new round.

## accepted-prefix

The driver's barrier (and the shell's round-end check) on the LIVE server
log: which of the schedule's websockets the server has ACCEPTED so far. Only
lines that end in a newline count; a line still being written is ignored. The
log may list concurrent accepts out of order, so the set of sequences is
judged, not their order. Exit 0 when exactly sequences 1..EXPECTED are logged
with their scheduled ids; exit 3 (pending) when a shorter contiguous prefix
is, including none; exit 1 for anything that cannot become EXPECTED by
waiting — a sequence beyond it, a gap below a later sequence, a duplicate, a
wrong id or a malformed marker line — and for a schedule or bound that is not
one. A sequence longer than the schedule's own decimal width is refused from
its digits alone, never converted or used as a range bound.

## peer-id-log

The final count, on the COMPLETE log of a server that has been stopped:
exactly sequences 1..N, each once, each carrying its scheduled id — the same
semantics as `scripts/test/android-interop-oracle.py peer-id-log`, judged here
so this lane depends on no other lane's file. The id list cycles in the
server, so a second pass through it (sequences N+1..2N) is extra, never a
match.
"""
import hashlib
import json
import os
import re
import sys

ID16 = re.compile(r"[0-9a-f]{16}")
ROLES = ("initiator", "responder")
PENDING = 3

# `server/main.go` `acceptancePeerIDLogFormat`, behind Go's standard log
# prefix. `scripts/test/cli-interop-matrix-test.mjs` renders lines from the Go
# constant itself, so the producer and this grammar cannot drift silently.
PEER_ID_MARKER = "relayium-acceptance-peer-id"
PEER_ID_LINE = re.compile(
    r"(?:\d{4}/\d{2}/\d{2} \d{2}:\d{2}:\d{2}(?:\.\d{1,9})? )?"
    + re.escape(PEER_ID_MARKER) + r" seq=([1-9][0-9]*) id=([0-9a-f]{16})")

# The sockets each code role's round opens, in order (`cli-matrix-plan.py`'s
# WEB_SOCKETS, restated: the oracle does not trust the planner it judges), and
# the page documents they live in: a CLI-minted round's page loads
# `/cross-network#c=CODE` once; a page-minted round's page loads `/`, signs in,
# loads `/cross-network`, and mints, which rebinds that document's socket.
WEB_SOCKETS = {
    "cli": (("cli", "code-room"), ("web", "code-room")),
    "web": (("web", "landing"), ("web", "cross-network"), ("web", "code-room"), ("cli", "code-room")),
}
WEB_DOCUMENTS = {
    "cli": (("code-link", ("code-room",)),),
    "web": (("landing", ("landing",)), ("cross-network", ("cross-network", "code-room"))),
}
IDENTITY_KEYS = ("schedule", "firstSeq", "endSeq", "sockets", "expectedCliId", "expectedWebId", "plannedRole")


def body(size, seed):
    period = bytes(((i * 31 + seed) & 0xFF) for i in range(256))
    reps, rest = divmod(size, 256)
    return period * reps + period[:rest]


def digest(size, seed):
    return hashlib.sha256(body(size, seed)).hexdigest()


def tree(root):
    """Every entry under root: files with size+sha256, and every directory."""
    files, dirs = {}, set()
    for dirpath, dirnames, filenames in os.walk(root):
        for d in dirnames:
            full = os.path.join(dirpath, d)
            if os.path.islink(full):
                files[os.path.relpath(full, root)] = {"symlink": True}
            else:
                dirs.add(os.path.relpath(full, root).replace(os.sep, "/"))
        for f in filenames:
            full = os.path.join(dirpath, f)
            rel = os.path.relpath(full, root).replace(os.sep, "/")
            if os.path.islink(full) or not os.path.isfile(full):
                files[rel] = {"special": True}
                continue
            with open(full, "rb") as fh:
                data = fh.read()
            files[rel] = {"size": len(data), "sha256": hashlib.sha256(data).hexdigest()}
    return files, dirs


def count(lines, pattern):
    rx = re.compile(pattern)
    return sum(1 for l in lines if rx.search(l))


def judge(plan, obs):
    problems = []
    p = problems.append

    if not obs.get("complete"):
        p("the driver did not complete the round (steps reached: %r)" % obs.get("steps"))
    cleanup = obs.get("cleanup") or {}
    if cleanup.get("cliExited") is not True or cleanup.get("browserExited") is not True:
        p("the round's clients were not all observed to exit before it was counted: %r" % (obs.get("cleanup"),))
    cli = obs.get("cli") or {}
    stderr = cli.get("stderr") or []
    web = obs.get("web") or {}

    # ── link roles and SAS ────────────────────────────────────────────────
    linked = [re.match(r"^linked with (.*) \(end-to-end encrypted link/1, (initiator|responder)\)$", l) for l in stderr]
    linked = [m for m in linked if m]
    cli_role = ""
    if len(linked) != 1:
        p("the CLI printed %d linked lines, not exactly one" % len(linked))
    else:
        cli_role = linked[0].group(2)
        if linked[0].group(1) != "a Relayium app or the web page":
            p("the CLI named its peer %r, not the app/web wording" % linked[0].group(1))
    web_role = web.get("role", "")
    if web_role not in ("initiator", "responder"):
        p("the page could not name its role: %r" % web_role)
    elif cli_role and {cli_role, web_role} != {"initiator", "responder"}:
        p("both ends claim the same link role: CLI %s, page %s" % (cli_role, web_role))

    sas = [re.match(r"^verification code \(SAS\): (\S+) — ", l) for l in stderr]
    sas = [m.group(1) for m in sas if m]
    if len(sas) != 1:
        p("the CLI printed %d SAS lines, not exactly one" % len(sas))
    if plan["verify"] == "on":
        wd = re.sub(r"\D", "", web.get("sas", ""))
        cd = re.sub(r"\D", "", sas[0]) if sas else ""
        if not wd:
            p("the page showed no SAS on a verify=on round")
        elif wd != cd:
            p("the two ends derived different SAS digits: page %s, CLI %s" % (wd, cd))

    judge_identity(plan, cli_role, obs, p)

    # ── text ─────────────────────────────────────────────────────────────
    want_stdout = "".join(m + "\n" for m in plan["webMessages"])
    if cli.get("stdout") != want_stdout:
        p("the CLI's stdout is not exactly the page's two messages: %r" % (cli.get("stdout", "")[:600],))
    got_web_msgs = web.get("receivedMessages") or []
    for m in plan["cliMessages"]:
        if m not in got_web_msgs:
            p("the page never showed the CLI's message %r (it has %r)" % (m, got_web_msgs[-6:]))

    # ── web → cli: the tree on disk ───────────────────────────────────────
    files, dirs = tree(plan["dest"])
    want = {}
    for e in plan["webBatches"]["flat"]:
        want[e["name"]] = e
    for e in plan["webBatches"]["folder"]:
        want[e["path"]] = e
    for rel, e in sorted(want.items()):
        got = files.get(rel)
        if got is None:
            p("the CLI did not save %s (it has %s)" % (rel, sorted(files)))
        elif got.get("size") != e["size"] or got.get("sha256") != digest(e["size"], e["seed"]):
            p("the CLI saved %s with the wrong bytes: %r" % (rel, got))
    for rel in sorted(set(files) - set(want)):
        p("the CLI's destination holds an entry it must not: %s %r" % (rel, files[rel]))
    want_dirs = set()
    for e in plan["webBatches"]["folder"]:
        parts = e["path"].split("/")[:-1]
        for i in range(1, len(parts) + 1):
            want_dirs.add("/".join(parts[:i]))
    for d in sorted(dirs - want_dirs):
        p("the CLI's destination holds a directory it must not: %s/" % d)
    for d in sorted(want_dirs - dirs):
        p("the CLI's destination lacks the directory %s/" % d)

    # ── cli → web: the page's save ledger ─────────────────────────────────
    saves = web.get("saves") or []
    complete = [s for s in saves if s.get("closed") and not s.get("removed") and not s.get("aborted")]
    by_path = {}
    for s in complete:
        by_path.setdefault(s.get("path"), []).append(s)
    want_web = {}
    for e in plan["cliBatches"]["flat"]:
        want_web[e["name"]] = e
    for e in plan["cliBatches"]["dir"]["entries"]:
        want_web[e["path"]] = e
    for path, e in sorted(want_web.items()):
        got = by_path.get(path, [])
        if len(got) != 1:
            p("the page completed %d saves of %s, not exactly one (saves: %r)"
              % (len(got), path, [(s.get("path"), s.get("size")) for s in saves]))
            continue
        if got[0].get("size") != e["size"] or got[0].get("sha256") != digest(e["size"], e["seed"]):
            p("the page saved %s with the wrong bytes: size %r" % (path, got[0].get("size")))
    declined = plan["cliBatches"]["declined"]["name"]
    if any(s.get("name") == declined for s in saves):
        p("the page opened a save for %s, which it declined" % declined)
    stopped = [plan["cliBatches"]["cancel"]]
    if plan["ending"] == "interrupt":
        stopped.append(plan["cliBatches"]["final"])
    for e in stopped:
        for s in saves:
            if s.get("name") == e["name"] and s.get("size", 0) >= e["size"]:
                p("the page holds the FULL body of %s, which must not have completed" % e["name"])
            if s.get("name") == e["name"] and s.get("sha256") == digest(e["size"], e["seed"]):
                p("the page's save of %s matches the full body" % e["name"])
    extra = sorted(set(by_path) - set(want_web) - {e["name"] for e in stopped})
    if extra:
        p("the page completed saves nobody sent it: %r" % extra)

    # ── the CLI's own account of every outcome, counted ──────────────────
    expect_counts = [
        (r"^saved: every file verified and written to disk in ", 2, "saved"),
        (r"^declined$", 1, "its own decline"),
        (r"^delivered: the other side verified and saved the files$", 2, "delivered"),
        (r"^not sent: the other side declined the files$", 1, "the page's decline"),
        (r"^not saved: the sender cancelled$", 1, "the sender's cancel"),
        (r"^not delivered: the other side stopped the transfer$", 1, "the receiver's stop"),
        (r"^the partial files of that batch were removed; nothing from it was kept$", 1, "the discard of the cancelled batch"),
    ]
    for pattern, n, what in expect_counts:
        got = count(stderr, pattern)
        if got != n:
            p("the CLI reported %s %d time(s), not %d" % (what, got, n))
    for pattern, what in [
        (r"^the connection to the other side was lost$", "a lost connection"),
        (r"^the link ended: ", "an abnormal link end"),
        (r"^messages: ", "a text-lane failure"),
        (r"not confirmed: the other side never confirmed", "an unconfirmed delivery"),
        (r"could not be written to stdout", "lost output"),
    ]:
        if count(stderr, pattern):
            p("the CLI reported %s" % what)
    if not obs.get("cancel", {}).get("webCancelClicked") or not obs.get("cancel", {}).get("resumed"):
        p("the sender-cancel cell did not run as planned: %r" % obs.get("cancel"))
    if not (obs.get("receiverCancel") or {}).get("clicked"):
        p("the receiver-stop cell did not run as planned: %r" % obs.get("receiverCancel"))

    # ── the ending ───────────────────────────────────────────────────────
    ex = cli.get("exit") or {}
    if plan["ending"] == "quit":
        # A declined batch, a sender cancel and a receiver stop are each a
        # batch that did not complete, so `pair` exits 1 (pair.go exit table).
        if ex.get("code") != 1:
            p("after /quit the CLI exited %r, not 1 (the round declined and cancelled batches)" % (ex,))
    else:
        if ex.get("code") != 130:
            p("after SIGINT the CLI exited %r, not 130" % (ex,))
        if count(stderr, r"^interrupted: leaving the session$") != 1:
            p("the CLI did not say it was leaving on the interrupt")
        if count(stderr, r"^delivered: ") > 2:
            p("the CLI reported the interrupted batch as delivered")
    return problems, cli_role, web_role


def link_role(self_id, peer_id):
    return "initiator" if self_id < peer_id else "responder"


def planned_identity(plan, p):
    """The plan's identity, re-derived from its schedule; None (with the
    reason) when it is missing or cannot be a schedule."""
    if "identity" not in plan or plan["identity"] is None:
        p("the plan does not say which identities this round schedules")
        return None
    ident = plan["identity"]
    if not isinstance(ident, dict):
        p("the plan's identity is not a schedule: %r" % (ident,))
        return None
    missing = [k for k in IDENTITY_KEYS if k not in ident]
    extra = sorted(set(ident) - set(IDENTITY_KEYS))
    if missing or extra:
        p("the plan's identity has no %r / carries fields nobody judges %r" % (missing, extra))
        return None
    ids = ident["schedule"]
    if not (isinstance(ids, list) and len(ids) == 12 and all(isinstance(i, str) and ID16.fullmatch(i) for i in ids)):
        p("the plan's schedule is not twelve 16-lowercase-hex ids: %r" % (ids,))
        return None
    if len(set(ids)) != len(ids):
        p("the plan's schedule repeats an id; two sockets would carry the SAME id")
        return None
    shape = WEB_SOCKETS.get(plan.get("codeRole"))
    first = ident["firstSeq"]
    if shape is None or not (isinstance(first, int) and not isinstance(first, bool) and 1 <= first <= 12):
        p("the plan's identity is inconsistent: code role %r, first socket %r" % (plan.get("codeRole"), first))
        return None
    want = [{"seq": first + i, "id": ids[first + i - 1] if first + i <= 12 else None, "actor": a, "stage": st}
            for i, (a, st) in enumerate(shape)]
    cli_id = next(x["id"] for x in want if x["actor"] == "cli")
    web_id = next(x["id"] for x in want if x["actor"] == "web" and x["stage"] == "code-room")
    role = link_role(cli_id, web_id) if cli_id and web_id else None
    if (ident["sockets"] != want or ident["endSeq"] != first + len(shape) - 1 or cli_id is None or web_id is None
            or ident["expectedCliId"] != cli_id or ident["expectedWebId"] != web_id):
        p("the plan's schedule is inconsistent: its sockets/ids are not the %s-minted round's %d sockets from %r"
          % (plan.get("codeRole"), len(shape), first))
        return None
    if ident["plannedRole"] not in ROLES or ident["plannedRole"] != role:
        p("the plan's schedule is inconsistent: ids CLI %s / page %s make the CLI %s, not the planned %r"
          % (cli_id, web_id, role, ident["plannedRole"]))
        return None
    return ident


def judge_identity(plan, cli_role, obs, p):
    """The planned identities against the CLI's line, the page's own wire
    history and the driver's barriers. See the header."""
    ident = planned_identity(plan, p)
    if ident is None:
        return
    cli_id, web_id, planned = ident["expectedCliId"], ident["expectedWebId"], ident["plannedRole"]
    if cli_role != planned:
        p("the CLI linked as %s, but the schedule (CLI %s, page %s) planned %s"
          % (cli_role or "nothing", cli_id, web_id, planned))
    web = obs.get("web") or {}
    if web.get("selfId") != web_id or web.get("peerId") != cli_id:
        p("the page paired as %r with %r, but the schedule planned page %s with CLI %s"
          % (web.get("selfId"), web.get("peerId"), web_id, cli_id))
    judge_wire(plan["codeRole"], ident, web.get("wire"), p)

    barriers = obs.get("barriers")
    want = [s["seq"] for s in ident["sockets"]]
    got = [b.get("seq") for b in barriers] if isinstance(barriers, list) and all(isinstance(b, dict) for b in barriers) else None
    if got != want:
        p("the driver confirmed the accepted sockets %r, not the planned %r in order" % (got, want))
    elif not all(b.get("status") == "exact" and b.get("alive") is True for b in barriers):
        p("a barrier was passed without an exact prefix and every started actor alive: %r" % (barriers,))


def judge_wire(code_role, ident, wire, p):
    """Every document, socket, welcome and roster the page saw."""
    by_stage = {s["stage"]: s for s in ident["sockets"] if s["actor"] == "web"}
    want_docs = WEB_DOCUMENTS[code_role]
    docs = wire.get("documents") if isinstance(wire, dict) else None
    if not isinstance(docs, list):
        p("the page's websocket history is missing: %r" % (wire,))
        return
    if [d.get("stage") if isinstance(d, dict) else None for d in docs] != [st for st, _ in want_docs]:
        p("the page loaded documents %r, not the planned %r"
          % ([d.get("stage") if isinstance(d, dict) else d for d in docs], [st for st, _ in want_docs]))
        return
    web_id, cli_id = ident["expectedWebId"], ident["expectedCliId"]
    for doc, (stage, socket_stages) in zip(docs, want_docs):
        sockets = doc.get("sockets")
        if not isinstance(sockets, list) or len(sockets) != len(socket_stages):
            p("the page's %s document opened %s websocket(s), not the planned %d: an extra, refused or "
              "reconnected socket" % (stage, len(sockets) if isinstance(sockets, list) else repr(sockets), len(socket_stages)))
            continue
        for sock, sst in zip(sockets, socket_stages):
            planned = by_stage[sst]
            room = "code" if sst == "code-room" else "lan"
            where = "the page's %s socket (seq %d)" % (sst, planned["seq"])
            if not isinstance(sock, dict) or sock.get("path") != "/ws" or sock.get("room") != room:
                p("%s is not a %s-room /ws socket: %r" % (where, room, sock))
                continue
            welcomes = sock.get("welcomes")
            if not isinstance(welcomes, list) or len(welcomes) != 1:
                p("%s saw %s welcomes, not one: a reconnect or a refused join"
                  % (where, len(welcomes) if isinstance(welcomes, list) else repr(welcomes)))
                continue
            got = welcomes[0]
            if not (isinstance(got, str) and ID16.fullmatch(got)):
                p("%s was welcomed with a malformed id %r" % (where, got))
                continue
            if got != planned["id"]:
                p("%s was welcomed as %s, but the schedule planned %s" % (where, got, planned["id"]))
                continue
            rosters = sock.get("rosters")
            if not (isinstance(rosters, list) and all(isinstance(r, list) for r in rosters)):
                p("%s has no roster history: %r" % (where, rosters))
                continue
            if room == "lan":
                strangers = sorted({i for r in rosters for i in r} - {got})
                if strangers:
                    p("%s listed other clients in the LAN room: %r" % (where, strangers))
                continue
            # The code room: the page's own roster shape includes itself.
            # S = the page alone, F = the page and the planned CLI.
            classes = []
            for r in rosters:
                if sorted(r) == [web_id]:
                    classes.append("S")
                elif sorted(r) == sorted([web_id, cli_id]):
                    classes.append("F")
                else:
                    classes.append("X")
            history = "".join(classes)
            shape = r"S+F+S*" if code_role == "web" else r"F+S*"
            if not re.fullmatch(shape, history):
                p("%s's roster history %r is not %s (S = the page alone, F = the page and CLI %s): "
                  % (where, rosters, "the page alone, then with the CLI" if code_role == "web"
                     else "the page joining the CLI already there", cli_id)
                  + ("a client nobody planned was in the room" if "X" in history else "the wrong order"))


def parse_schedule(ids_csv):
    ids = ids_csv.split(",")
    problems = []
    if len(ids) < 2 or not all(ID16.fullmatch(i) for i in ids):
        problems.append("the schedule %r is not a list of 16-lowercase-hex ids" % (clip(ids_csv, 200),))
    elif len(set(ids)) != len(ids):
        problems.append("the schedule repeats an id; a repeated id cannot tell sockets apart")
    return ids, problems


def clip(text, limit=40):
    """An input-derived token for a message, cut to a bounded length."""
    return text if len(text) <= limit else "%s...(%d characters)" % (text[:limit], len(text))


def parse_markers(text, ids, problems):
    """{seq: id} for every marker line in `text`; refusals into `problems`.
    A sequence wider than the schedule's decimal width is refused from its
    digits alone (and kept out of the map), so nothing input-derived is ever
    converted from a long string or used as a range bound."""
    width = len(str(len(ids)))
    seen, beyond = {}, []
    for line in text.split("\n"):
        if PEER_ID_MARKER not in line:
            continue
        m = PEER_ID_LINE.fullmatch(line)
        if not m:
            problems.append("a peer-id log line is malformed: %r" % (clip(line, 200),))
            continue
        digits, got = m.group(1), m.group(2)
        if len(digits) > width or int(digits) > len(ids):
            beyond.append((clip(digits), got))
            continue
        seq = int(digits)
        if seq in seen:
            problems.append("sequence %d was logged twice" % seq)
            continue
        seen[seq] = got
    return seen, beyond


def judge_accepted_prefix(text, ids_csv, expected):
    """Returns (status, problems, seen) for a LIVE server log; see the header."""
    ids, problems = parse_schedule(ids_csv)
    width = len(str(len(ids)))
    if not (re.fullmatch(r"[1-9][0-9]*", expected) and len(expected) <= width and int(expected) <= len(ids)):
        problems.append("the expected prefix %r is not a sequence within the %d-id schedule" % (clip(expected), len(ids)))
    if problems:
        return 1, problems, {}
    want = int(expected)
    # Complete lines only: the server may be mid-write.
    seen, beyond = parse_markers(text[:text.rfind("\n") + 1], ids, problems)
    for digits, got in beyond:
        problems.append("sequence %s (%s) was accepted while waiting for %d; it is beyond the %d-id schedule, "
                        "an extra client or the wrong order" % (digits, got, want, len(ids)))
    for seq in sorted(seen):
        if seq > want:
            problems.append("sequence %d (%s) was accepted while waiting for %d; a socket beyond the schedule's "
                            "point here is an extra client or the wrong order" % (seq, seen[seq], want))
        elif seen[seq] != ids[seq - 1]:
            problems.append("sequence %d carried %s, not the schedule's %s" % (seq, seen[seq], ids[seq - 1]))
    if seen:
        # `seen` holds only sequences within the schedule, so this range is its.
        gaps = [s for s in range(1, max(seen) + 1) if s not in seen]
        if gaps:
            problems.append("sequence(s) %s are missing below the accepted %d; accepts are not a contiguous prefix"
                            % (gaps, max(seen)))
    if problems:
        return 1, problems, seen
    return (0 if len(seen) == want else PENDING), [], seen


def judge_peer_id_log(text, ids):
    """Returns (problems, table) for the COMPLETE log of a stopped server."""
    problems = []
    if not text:
        return ["the server log is empty; no accepted socket was recorded"], []
    if not text.endswith("\n"):
        problems.append("the server log does not end with a newline; it was truncated or read while still being written")
    seen, beyond = parse_markers(text, ids, problems)
    missing = [s for s in range(1, len(ids) + 1) if s not in seen]
    if missing or beyond:
        problems.append("the server accepted %d websocket(s), not exactly the %d scheduled (missing %s, extra %s)"
                        % (len(seen) + len(beyond), len(ids), missing, [d for d, _ in beyond]))
    for seq in sorted(seen):
        if seen[seq] != ids[seq - 1]:
            problems.append("sequence %d carried %s, but the schedule's entry %d is %s" % (seq, seen[seq], seq, ids[seq - 1]))
    return problems, [(seq, seen[seq]) for seq in sorted(seen)]


def read_log(path):
    with open(path, encoding="utf-8", errors="strict") as fh:
        return fh.read()


def accepted_prefix_main(argv):
    if len(argv) != 5:
        print("usage: cli-web-oracle.py accepted-prefix <server.log> <ids-csv> <expected>", file=sys.stderr)
        return 2
    try:
        text = read_log(argv[2])
    except (OSError, ValueError) as err:
        print("  - the server log is unreadable: %s" % err, file=sys.stderr)
        return 1
    status, problems, seen = judge_accepted_prefix(text, argv[3], argv[4])
    for x in problems:
        print("  - %s" % x, file=sys.stderr)
    if status == 0:
        print("-- the server accepted sockets 1..%s with their scheduled ids; seq %s was assigned %s"
              % (argv[4], argv[4], seen[int(argv[4])]), file=sys.stderr)
    elif status == PENDING:
        print("-- pending: the server has accepted %d of the first %s scheduled sockets" % (len(seen), argv[4]),
              file=sys.stderr)
    return status


def peer_id_log_main(argv):
    if len(argv) != 4:
        print("usage: cli-web-oracle.py peer-id-log <server.log> <ids-csv>", file=sys.stderr)
        return 2
    ids, problems = parse_schedule(argv[3])
    if not problems:
        try:
            text = read_log(argv[2])
        except (OSError, ValueError) as err:
            problems = ["the server log is unreadable: %s" % err]
        else:
            problems, table = judge_peer_id_log(text, ids)
            for seq, got in table:
                print("-- accepted websocket seq=%d id=%s" % (seq, got), file=sys.stderr)
    for x in problems:
        print("  - %s" % x, file=sys.stderr)
    if problems:
        return 1
    print("-- the server accepted exactly the %d scheduled websockets, one id each" % len(ids), file=sys.stderr)
    return 0


def main(argv):
    if len(argv) >= 2 and argv[1] == "accepted-prefix":
        return accepted_prefix_main(argv)
    if len(argv) >= 2 and argv[1] == "peer-id-log":
        return peer_id_log_main(argv)
    if len(argv) != 3:
        print(__doc__, file=sys.stderr)
        return 2
    plan = json.load(open(argv[1]))
    obs = json.load(open(argv[2]))
    problems, cli_role, web_role = judge(plan, obs)
    if problems:
        for x in problems:
            print("  - %s" % x, file=sys.stderr)
        return 1
    sdp = (obs.get("web") or {}).get("sdp") or {}
    print("-- round %s agreed: code by %s, CLI %s / page %s as planned (CLI %s, page %s, sockets %d..%d), SAS %s, "
          "page advertised max-message-size %r and saw the CLI advertise %r"
          % (plan["round"], plan["codeRole"], cli_role, web_role, plan["identity"]["expectedCliId"],
             plan["identity"]["expectedWebId"], plan["identity"]["firstSeq"], plan["identity"]["endSeq"],
             "compared" if plan["verify"] == "on" else "not shown (default)",
             sorted({d.get("maxMessageSize") for d in sdp.get("local", [])}, key=str),
             sorted({d.get("maxMessageSize") for d in sdp.get("remote", [])}, key=str)),
          file=sys.stderr)
    print(cli_role)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))

#!/usr/bin/env python3
"""The launcher's half of the two-device physical acceptance channel.

`DevicePairChannel` in `apps/ios/RelayiumUITests/DevicePairAcceptance.swift`
emits one bounded line per fact; this reads those lines back out of an
`xcodebuild` log. The grammar is defined in both places and neither trusts the
other: the runner refuses to emit anything outside it, and this refuses to read
anything outside it.

Why that matters here specifically: the PAIRING-CODE value is extracted from a
log while the generating runner is still on screen waiting, and is then handed
to a second `xcodebuild` process as environment. Whatever this function accepts
is, in effect, input to another run. So:

  * the marker, this run's own tag, the expected role and the expected event
    must all match — a stale line from an earlier run, or a line from a second
    `xcodebuild` sharing a terminal, carries a different tag and is ignored
    rather than raced with;
  * the value must match the event's own pattern, not merely "some token". Six
    decimal digits is six decimal digits;
  * a line carrying the marker twice is refused outright rather than parsed. It
    cannot be produced by the emitter, so its presence means something is
    echoing log lines and the parse is no longer trustworthy;
  * two DIFFERENT values for the same (tag, role, event) is a failure, not a
    "take the first". One device minting two codes means the run's model of
    what is happening is wrong, and typing either of them would be a guess.

Nothing secret travels here and nothing secret exists to travel: the vocabulary
is a public six-digit pairing code, a six-digit short-authentication string that
is public by construction (people read it aloud to each other), and the run's
own tag. No credential, no bearer, no device identifier.

The one thing that travels the OTHER way — launcher to device — is a release,
and its file name is composed here for the same reason the grammar is parsed
here: both ends compute it and neither trusts the other. See `release_name`.

    python3 device_pair_channel.py extract --log F --tag T --role R --event E
    python3 device_pair_channel.py release-name --tag T --role R
    python3 device_pair_channel.py self-test
"""

import argparse
import re
import sys

MARKER = "RELAYIUM-DEVICE-PAIR"

# The general bounded value set, matching `DevicePairChannel.isEmittable`.
VALUE = r"[A-Za-z0-9._-]{1,64}"

# Per-event refinements. An event absent from here is held to VALUE alone.
#
# Both digit events are held to EXACTLY six, because on current `main` both
# really are six and nothing else:
#
#   * `signal.CodeLen` is 6 and `signal.CodeAlphabet` is exactly "0123456789";
#   * `sas()` in `RelayiumKit/Crypto/Sas.swift` ends
#     `String(format: "%06u", num % 1_000_000)`, so a shorter or longer string
#     cannot have come from the product's own derivation and must not be
#     compared as if it had.
EVENT_VALUE = {
    "PAIRING-CODE": re.compile(r"\A[0-9]{6}\Z"),
    "SAS": re.compile(r"\A[0-9]{6}\Z"),
}

TOKEN = re.compile(r"\A[A-Za-z0-9._-]{1,64}\Z")

# ── the one thing that travels launcher → device ─────────────────────────────
#
# A receiving runner publishes RECEIVED and then STAYS ALIVE, holding the state
# the product reached, so the launcher can read the received bytes out of a live
# app container rather than out of whatever is left after both `xcodebuild`
# processes have exited. The launcher releases it by writing one file into the
# UI-TEST RUNNER's own container — not the product's — and this composes that
# file's name.
#
# It is composed here, from the same bounded token set the log grammar admits,
# because the name is the whole handshake: a name the two ends disagreed about
# would leave the receiver holding to its ceiling on every run while the launcher
# believed it had released it, which is a harness that works and is slow rather
# than one that visibly fails.
#
# The tag is IN the name, so a file left in that container by an earlier run
# cannot release this one; the runner also requires the content to be this run's
# tag. And because the token set excludes "/" the result is always exactly one
# path component — `..` is an admissible token but
# `relayium-device-pair-release-..-r` is not `..`, so there is no destination
# outside the directory the launcher named.
RELEASE_PREFIX = "relayium-device-pair-release"


class ChannelError(Exception):
    """A refusal, phrased for the operator reading a failed run."""


def release_name(tag, role):
    """The file the launcher writes to release one holding receiving role."""
    for name, value in (("tag", tag), ("role", role)):
        if not TOKEN.match(value):
            raise ChannelError(
                "%s %r is outside the set this channel admits" % (name, value))
    return "%s-%s-%s" % (RELEASE_PREFIX, tag, role)


def _pattern(tag, role, event):
    for name, value in (("tag", tag), ("role", role), ("event", event)):
        if not TOKEN.match(value):
            raise ChannelError(
                "%s %r is outside the set this channel admits" % (name, value))
    return re.compile(
        r"%s %s %s %s (%s)\s*\Z"
        % (re.escape(MARKER), re.escape(tag), re.escape(role),
           re.escape(event), VALUE)
    )


def values(lines, tag, role, event):
    """Every distinct value published for one (tag, role, event), in order."""
    pattern = _pattern(tag, role, event)
    refined = EVENT_VALUE.get(event)
    found = []
    for raw in lines:
        line = raw.rstrip("\r\n")
        count = line.count(MARKER)
        if count == 0:
            continue
        if count > 1:
            raise ChannelError(
                "a log line carries the channel marker %d times, which the runner "
                "cannot produce; something is echoing log lines and this parse is "
                "not trustworthy: %r" % (count, line[:200])
            )
        match = pattern.search(line)
        if not match:
            continue
        value = match.group(1)
        if refined and not refined.match(value):
            raise ChannelError(
                "%s published %r, which is not a valid %s value" % (role, value, event)
            )
        if value not in found:
            found.append(value)
    return found


def extract(lines, tag, role, event):
    """The one value published, or a refusal that says which way it failed."""
    found = values(lines, tag, role, event)
    if not found:
        raise ChannelError(
            "%s never published a %s line for run %s" % (role, event, tag))
    if len(found) > 1:
        raise ChannelError(
            "%s published %d different %s values (%s); the run's model of what is "
            "happening is wrong and choosing one would be a guess"
            % (role, len(found), event, ", ".join(found))
        )
    return found[0]


# ── self-test ────────────────────────────────────────────────────────────────
#
# Deterministic, offline, and run by the launcher on every start: the grammar is
# the one piece of this harness that acts on input from outside itself, so it is
# proved before a device is touched rather than trusted.


def _self_test():
    tag, role, event = "ab12cd34", "pair-generator", "PAIRING-CODE"
    good = "%s %s %s %s 483920" % (MARKER, tag, role, event)

    # Counted rather than written down. A hand-maintained total is the one part
    # of a self-test that silently stops describing it.
    counted = [0]

    def case():
        counted[0] += 1

    def expect(lines, want):
        case()
        got = extract(lines, tag, role, event)
        assert got == want, "expected %r, got %r" % (want, got)

    def refuse(lines, because):
        case()
        try:
            extract(lines, tag, role, event)
        except ChannelError:
            return
        raise AssertionError("accepted a line it must refuse: %s" % because)

    expect([good], "483920")
    # An xcodebuild prefix before the marker is ordinary and must not defeat it.
    expect(["    t =  12.34s " + good], "483920")
    expect([good + "\n"], "483920")
    expect([good, good], "483920")            # the same value repeated is one value
    expect(["noise", good, "more noise"], "483920")

    refuse([], "nothing was published")
    refuse(["%s %s %s %s 483921" % (MARKER, tag, role, event), good],
           "two different codes")
    refuse(["%s ffffffff %s %s 483920" % (MARKER, role, event)], "another run's tag")
    refuse(["%s %s pair-joiner %s 483920" % (MARKER, tag, event)], "the other role")
    refuse(["%s %s %s SAS 483920" % (MARKER, tag, role)], "a different event")
    refuse(["%s %s %s %s 48392" % (MARKER, tag, role, event)], "five digits")
    refuse(["%s %s %s %s 4839201" % (MARKER, tag, role, event)], "seven digits")
    refuse(["%s %s %s %s 48392a" % (MARKER, tag, role, event)], "a non-digit")
    refuse(["%s %s %s %s 483920 extra" % (MARKER, tag, role, event)], "a trailing field")
    refuse(["%s %s %s %s $(id)" % (MARKER, tag, role, event)], "a shell substitution")
    refuse([good + " " + good], "the marker twice on one line")
    refuse(["%s %s %s %s" % (MARKER, tag, role, event)], "no value at all")

    # ── the SAS event's own bound ────────────────────────────────────────────
    #
    # Six digits, exactly, because that is what `sas()` produces. A run that
    # compared a truncated or padded value would be comparing two strings the
    # product never derived.
    case()
    assert extract(["%s %s nearby-resident SAS 590397" % (MARKER, tag)],
                   tag, "nearby-resident", "SAS") == "590397"
    for bad, because in (("abcdef", "a non-numeric SAS"),
                         ("59039", "a five-digit SAS"),
                         ("5903971", "a seven-digit SAS")):
        case()
        try:
            extract(["%s %s nearby-resident SAS %s" % (MARKER, tag, bad)],
                    tag, "nearby-resident", "SAS")
        except ChannelError:
            continue
        raise AssertionError("accepted %s" % because)

    # ── the tag-carrying events ─────────────────────────────────────────────
    #
    # READY is the start barrier's evidence and HOLDING is the end barrier's.
    # Both carry the run tag rather than a bare word, so a line from an earlier
    # run of the same role cannot answer this run's question.
    for name in ("READY", "HOLDING", "RECEIVED"):
        case()
        assert extract(["%s %s nearby-resident %s %s" % (MARKER, tag, name, tag)],
                       tag, "nearby-resident", name) == tag

    # BOTH Nearby roles publish READY. An event-only match would be opened by
    # the very runner the start barrier exists to hold back, so the role is part
    # of the match and is proved to be.
    case()
    try:
        extract(["%s %s nearby-connector READY %s" % (MARKER, tag, tag)],
                tag, "nearby-resident", "READY")
    except ChannelError:
        pass
    else:
        raise AssertionError("one role's READY answered the other role's question")

    refuse(["%s %s %s HOLDING 483920" % (MARKER, tag, role)],
           "a HOLDING line answering a request for a different event")

    # A malformed request is refused before it can search for anything —
    # otherwise a tag containing regex metacharacters would be compiled into a
    # pattern that matches something else.
    for bad in ("has space", "", "x" * 65, "semi;colon", ".*"):
        for position in range(3):
            case()
            request = [tag, role, event]
            request[position] = bad
            try:
                _pattern(*request)
            except ChannelError:
                continue
            raise AssertionError("accepted a malformed request field %r" % bad)

    # ── the release name, which is the OTHER direction ──────────────────────
    #
    # Composed rather than parsed, so what is proved here is the shape both ends
    # compute and the refusal of anything that is not one path component.
    case()
    assert release_name(tag, "pair-file-joiner") == \
        "relayium-device-pair-release-ab12cd34-pair-file-joiner"
    # The run's own tag is IN the name. An earlier run's release file, left in a
    # runner container that outlives one run, therefore cannot open this gate —
    # the same rule the log grammar applies in the other direction.
    case()
    assert release_name("0badcafe", "pair-file-joiner") != \
        release_name(tag, "pair-file-joiner")
    for bad in ("has space", "", "x" * 65, "a/b", "semi;colon", "$(id)"):
        for position in range(2):
            case()
            request = [tag, "nearby-resident"]
            request[position] = bad
            try:
                release_name(*request)
            except ChannelError:
                continue
            raise AssertionError("composed a release name from %r" % bad)
    # Every ADMITTED token still produces exactly one path component. "." and
    # ".." are inside the token set, and the prefix is what makes them harmless:
    # the launcher writes to a directory it names and this can never leave it.
    for odd in (".", "..", "-", "_", "a.b-c_d"):
        case()
        assert "/" not in release_name(odd, odd)
        assert release_name(odd, odd) not in (".", "..")

    print("device_pair_channel self-test: %d cases OK" % counted[0])


def main(argv):
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    get = sub.add_parser("extract")
    get.add_argument("--log", required=True)
    get.add_argument("--tag", required=True)
    get.add_argument("--role", required=True)
    get.add_argument("--event", required=True)
    name = sub.add_parser("release-name")
    name.add_argument("--tag", required=True)
    name.add_argument("--role", required=True)
    sub.add_parser("self-test")

    args = parser.parse_args(argv)
    if args.command == "self-test":
        _self_test()
        return 0
    if args.command == "release-name":
        try:
            print(release_name(args.tag, args.role))
        except ChannelError as error:
            print(str(error), file=sys.stderr)
            return 2
        return 0
    try:
        with open(args.log, "r", encoding="utf-8", errors="replace") as handle:
            print(extract(handle, args.tag, args.role, args.event))
    except ChannelError as error:
        print(str(error), file=sys.stderr)
        return 2
    except OSError as error:
        print("cannot read %s: %s" % (args.log, error), file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

#!/usr/bin/env python3
"""Keep the crash report of a failed macOS UI smoke run.

## Why this exists

Run 37072256451 (`ui-smoke (device-inbox)`, attempt 1) failed because the app
under test was killed mid-test: the kernel logged an unrecoverable exception
for `Relayium[9374]`, and ReportCrash then wrote
`Relayium-2026-10-02-224143.ips` (named in `testmanagerd.log`). That file was
written about eighteen seconds after the kill, which was after the test's own
teardown had already looked for crash reports, so XCTest ignored it ("not
currently tracking it") and it never reached the `.xcresult`. The job's only
upload is that `.xcresult`, and the runner is ephemeral, so the one object that
held the target's stack was destroyed with the runner. Nothing in this script
explains that crash; it only keeps the next one.

## What it does

`mark` runs immediately before the UI smoke step and writes a small marker
holding the time and the run it belongs to (commit, run id, attempt, shard).
`capture` runs only after that step FAILED or was CANCELLED. It looks in
exactly two directories — the runner user's `~/Library/Logs/DiagnosticReports`
and its `Retired` subdirectory, one level each, never recursively — for reports
named like `Relayium-<time>.ips` or `RelayiumUITests-Runner-<time>.ips` that are
newer than the marker, copies the raw bytes of each one that parses as an Apple
crash report (two JSON objects, `bug_type` 309, the expected bundle), and writes
a manifest of allowlisted fields beside them.

## Every path is walked through directory descriptors

The two trusted bases are the runner's temp directory and its home directory,
each opened once (a base may itself sit behind a system alias such as macOS's
`/var` -> `/private/var`; that is the base, not something below it). Every
component BELOW a base is opened relative to its parent's descriptor with
`O_NOFOLLOW` (and `O_DIRECTORY` for directories), and its device/inode from
`lstat` must equal the opened descriptor's. A name swapped for a symbolic link
between the check and the open therefore fails to open; one swapped for a
different real directory or file fails the identity check. Before and after
each report is read, and before anything is written, the whole chain is walked
again from the base and must still name the same inodes; if any component was
replaced or renamed, the capture fails closed for that directory rather than
read what is now outside it.

A report is read only if it is still exactly the file the scan chose (same
device, inode, size and mtime) and its opened size is within the per-file cap
and what is left of the total; the read is bounded by that verified size, not
by the file's size now. A file that changed after the scan is refused even if
the replacement would be acceptable.

Output is created only through descriptors of directories this script itself
created (empty, no group/other bits when created), with `O_EXCL`. After the
file is opened, and immediately before every chunk written, the whole chain
and the file's name must still be what was bound and created; otherwise
nothing more is written and the capture stops (`Escape`, exit 4), leaving its
own partial file in place — it never deletes anything. A same-user rename that
lands between a check and the write right after it cannot be excluded by any
check; it is bounded to one chunk. A directory's identity is bound at its
first open after `mkdir`, which returns none; it is not proven to be the
directory `mkdir` created.

## Bounds

One budget, `--poll-seconds` (60) + `--settle-seconds` (5), starts when the
capture starts. Everything — reading the marker, the built binaries' UUIDs,
listing, reading, parsing and the one settle rescan — is charged to it and must
finish up to 3 s before it ends (kept for the manifest); an operation that
finishes later is refused, and nothing resets the budget. That check is
cooperative. On the command line a real-time `SIGALRM` watchdog also ends the
capture when the budget ends, even inside a blocking read (exit 5, no
manifest); the workflow step's 2-minute timeout remains the outer bound. Listing
stops after `MAX_DIR_ENTRIES` entries per directory and collection after
`MAX_FRESH_CANDIDATES`; when either stops early the manifest says the scan was
incomplete and gives counts as lower bounds. At most 8 reports, 2 MiB each and
8 MiB in total are read.

## What it deliberately does not do

  * No symbolication (no `atos`), no binaries uploaded, no environment or
    memory captured. Frames the OS left without a symbol stay that way; the
    manifest counts them for the images this job built.
  * `procPath` is redacted by the OS (`/Users/USER/*/...`) and is not used.
    The PID is recorded, never used to choose a report: nothing here knows the
    target's PID.
  * Build provenance is proven only by comparing the report's `slice_uuid` with
    the `LC_UUID` of the binary this job built. Anything else is labelled
    `mismatch` or `unknown` and is still kept, but it is not a match.
  * A crash in a run whose UI smoke step SUCCEEDS is not captured: the capture
    step does not run then, so a green run costs nothing.
  * The marker's run binding is diagnostic provenance, not release evidence.

Python 3.9 standard library only: it runs as `/usr/bin/python3` on the hosted
macOS image and its tests run on Linux.
"""

import argparse
import datetime
import errno
import hashlib
import json
import os
import re
import signal
import stat
import struct
import sys
import time
from typing import Callable, Dict, List, Optional, Tuple

SCHEMA_MARKER = "relayium-macos-ui-crash-marker/2"
SCHEMA_MANIFEST = "relayium-macos-ui-crash-diagnostics/2"

DIAG_DIR = "macos-crash-diagnostics"
MARKER_NAME = "marker.json"
CAPTURE_DIR = "capture"
REPORTS_SUBDIR = "reports"
MANIFEST_NAME = "manifest.json"

POLL_SECONDS_MAX = 60
SETTLE_SECONDS_MAX = 5
MAX_CANDIDATES = 8
MAX_REPORT_BYTES = 2 * 1024 * 1024
MAX_TOTAL_BYTES = 8 * 1024 * 1024
MAX_DIR_ENTRIES = 4096
MAX_FRESH_CANDIDATES = 32
MAX_RECORDED_REFUSALS = 64
MAX_MARKER_BYTES = 4096
MAX_MACHO_LOAD_COMMAND_BYTES = 4 * 1024 * 1024
MAX_FAT_ARCHS = 32
MAX_FIELD_CHARS = 256
# Of the one budget, the part kept back from looking and reading so the manifest
# can still be written before the watchdog fires (at most this, at most a quarter).
WRITE_RESERVE_SECONDS = 3.0
# Output is written in chunks of at most this, each after a fresh check.
WRITE_CHUNK = 64 * 1024

# Report file name -> the process and bundle that report must be for.
EXPECTED = {
    "Relayium": "com.relayium.mac",
    "RelayiumUITests-Runner": "com.relayium.mac.UITests.xctrunner",
}
REPORT_NAME = re.compile(r"^(Relayium|RelayiumUITests-Runner)-\d{4}-\d{2}-\d{2}-\d{6}\.ips$")

SHA_RE = re.compile(r"^[0-9a-f]{40}$")
SHARD_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,39}$")
ATTEMPT_RE = re.compile(r"^[1-9][0-9]{0,3}$")
RUN_ID_RE = re.compile(r"^[1-9][0-9]{0,19}$")
UUID_RE = re.compile(r"^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$")
HEADER_TIME_RE = re.compile(r"^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))? ([+-])(\d{2})(\d{2})$")

# The report directories, relative to the runner's home directory.
SOURCE_DIRS = (
    ("DiagnosticReports", ("Library", "Logs", "DiagnosticReports")),
    ("Retired", ("Library", "Logs", "DiagnosticReports", "Retired")),
)

# The binaries this job built, relative to `<runner temp>/dd-mac-ui-<shard>`.
# `Relayium.debug.dylib` exists only when Xcode splits a Debug build; its
# absence is recorded, never an error.
BUILT_IMAGES = (
    ("app_main", "Relayium", ("Build", "Products", "Debug", "Relayium.app", "Contents", "MacOS", "Relayium")),
    ("app_debug_dylib", None, ("Build", "Products", "Debug", "Relayium.app", "Contents", "MacOS", "Relayium.debug.dylib")),
    ("ui_test_runner", "RelayiumUITests-Runner",
     ("Build", "Products", "Debug", "RelayiumUITests-Runner.app", "Contents", "MacOS", "RelayiumUITests-Runner")),
)

LIMITATIONS = [
    "Failure-only: a crash in a run whose UI smoke step succeeded is not captured.",
    "uuid_provenance 'match' means the report's slice_uuid equals the LC_UUID of the binary this job built; "
    "'mismatch' and 'unknown' reports are kept but are not provenance matches.",
    "No symbolication was performed and no binary was uploaded; frames without a symbol in the raw report stay unsymbolized.",
    "procPath is redacted by the OS and is not used; pid is recorded only and was not used to select reports.",
    "A report named outside the exact Relayium / RelayiumUITests-Runner pattern, or older than the marker, is not read.",
    "A report written after the polling window and its one settle rescan is not captured.",
    "The run binding (commit, run id, attempt, shard) is diagnostic provenance, not release evidence.",
    "The deadline is checked between and after operations; on the command line a SIGALRM watchdog ends the "
    "capture at the end of the budget (exit 5, no manifest). timing.elapsed_seconds is measured, never clamped.",
]

DIR_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
FILE_FLAGS = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK
NEW_FILE_FLAGS = os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW


class Refusal(Exception):
    """A report (or input) that is not used, with the one reason it was not."""

    def __init__(self, reason: str):
        super().__init__(reason)
        self.reason = reason


class UsageError(Exception):
    pass


class Escape(Exception):
    """The owned output directory is no longer where it was created."""


class DeadlineExceeded(Exception):
    """The capture's watchdog fired: the one budget is spent, no more work."""


# ── small helpers ──────────────────────────────────────────────────────────


def _utc(epoch_ns: int) -> str:
    seconds, rem = divmod(epoch_ns, 1_000_000_000)
    stamp = datetime.datetime.fromtimestamp(seconds, tz=datetime.timezone.utc)
    return stamp.strftime("%Y-%m-%dT%H:%M:%S") + ".%06dZ" % (rem // 1000)


def _no_duplicates(pairs):
    out = {}
    for key, value in pairs:
        if key in out:
            raise ValueError("duplicate key %r" % key)
        out[key] = value
    return out


def _no_constants(name):
    raise ValueError("non-JSON constant %s" % name)


_DECODER = json.JSONDecoder(object_pairs_hook=_no_duplicates, parse_constant=_no_constants)


def _short_str(value) -> Optional[str]:
    if isinstance(value, str) and len(value) <= MAX_FIELD_CHARS:
        return value
    return None


def _plain_int(value) -> Optional[int]:
    if isinstance(value, int) and not isinstance(value, bool):
        return value
    return None


def _norm_uuid(value) -> Optional[str]:
    if isinstance(value, str) and UUID_RE.match(value):
        return value.upper()
    return None


def _same(a, b) -> bool:
    return (a.st_dev, a.st_ino) == (b.st_dev, b.st_ino)


def _identity(st) -> Tuple[int, int, int, int]:
    return (st.st_dev, st.st_ino, st.st_size, st.st_mtime_ns)


def _validate_identity(head: str, run_id: str, attempt: str, shard: str) -> None:
    if not SHA_RE.match(head):
        raise UsageError("--head must be a 40-character lowercase hex commit id")
    if not RUN_ID_RE.match(run_id):
        raise UsageError("--run-id must be a positive integer")
    if not ATTEMPT_RE.match(attempt):
        raise UsageError("--attempt must be a positive integer")
    if not SHARD_RE.match(shard):
        raise UsageError("--shard must match %s" % SHARD_RE.pattern)


# ── descriptor-bound directories ───────────────────────────────────────────


class Base:
    """A trusted base directory, opened once. The path may pass through a
    system alias; it is resolved here, once, and never again below."""

    def __init__(self, path: str, flag: str):
        if not os.path.isabs(path):
            raise UsageError("%s must be an absolute path" % flag)
        try:
            self.fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
        except OSError:
            raise UsageError("%s is not an openable directory" % flag)
        self.path = path
        self.flag = flag
        self.stat = os.fstat(self.fd)

    def still_here(self) -> bool:
        try:
            return _same(os.stat(self.path), self.stat)
        except OSError:
            return False

    def close(self) -> None:
        os.close(self.fd)


class Chain:
    """Directories opened one component at a time below a Base, each bound by
    descriptor and checked by device/inode; `verify` re-walks the names."""

    def __init__(self, base: Base):
        self.base = base
        self.links = []  # (parent fd, name, stat of the opened directory, fd)

    @property
    def fd(self) -> int:
        return self.links[-1][3] if self.links else self.base.fd

    def descend(self, name: str) -> None:
        """Open `name` below the current directory, or raise Refusal with why not."""
        if "/" in name or name in ("", ".", ".."):
            raise Refusal("bad_component")
        parent = self.fd
        try:
            before = os.lstat(name, dir_fd=parent)
        except FileNotFoundError:
            raise Refusal("absent")
        if stat.S_ISLNK(before.st_mode):
            raise Refusal("symlink")
        if not stat.S_ISDIR(before.st_mode):
            raise Refusal("not_a_directory")
        try:
            fd = os.open(name, DIR_FLAGS, dir_fd=parent)
        except OSError as err:
            # ELOOP / ENOTDIR: swapped for a link or a file after the lstat.
            raise Refusal("replaced" if err.errno in (errno.ELOOP, errno.ENOTDIR, errno.EMLINK) else "absent")
        opened = os.fstat(fd)
        if not stat.S_ISDIR(opened.st_mode) or not _same(opened, before):
            os.close(fd)
            raise Refusal("replaced")
        self.links.append((parent, name, opened, fd))

    def verify(self) -> bool:
        """Every name in the chain still names the inode that was opened."""
        if not self.base.still_here():
            return False
        for parent, name, opened, _ in self.links:
            try:
                now = os.lstat(name, dir_fd=parent)
            except OSError:
                return False
            if stat.S_ISLNK(now.st_mode) or not _same(now, opened):
                return False
        return True

    def pop(self) -> None:
        """Close and forget the innermost directory."""
        os.close(self.links.pop()[3])

    def close(self) -> None:
        for _, _, _, fd in reversed(self.links):
            os.close(fd)
        self.links = []


def open_chain(base: Base, parts) -> Chain:
    chain = Chain(base)
    try:
        for part in parts:
            chain.descend(part)
    except BaseException:
        chain.close()
        raise
    return chain


def open_file_in(dir_fd: int, name: str, expect=None, limit: Optional[int] = None) -> Tuple[int, os.stat_result]:
    """A regular file in a bound directory, by name, never following a link;
    its lstat and its descriptor must be the same file.

    With `expect` (the scan's lstat of this candidate), the file must still be
    exactly that file — same device, inode, size and mtime — or it is refused
    as `changed_since_scan`, even if what replaced it would be acceptable.
    With `limit`, the OPENED descriptor's size must be within it before
    anything is read."""
    try:
        before = os.lstat(name, dir_fd=dir_fd)
    except FileNotFoundError:
        raise Refusal("absent")
    if stat.S_ISLNK(before.st_mode):
        raise Refusal("symlink_file")
    if not stat.S_ISREG(before.st_mode):
        raise Refusal("nonregular")
    if expect is not None and _identity(before) != _identity(expect):
        raise Refusal("changed_since_scan")
    try:
        fd = os.open(name, FILE_FLAGS, dir_fd=dir_fd)
    except OSError:
        raise Refusal("unstable")
    opened = os.fstat(fd)
    if not stat.S_ISREG(opened.st_mode) or _identity(opened) != _identity(before):
        os.close(fd)
        raise Refusal("unstable")
    if limit is not None and opened.st_size > limit:
        os.close(fd)
        raise Refusal("oversize")
    return fd, before


def _still_mine(chain: Chain, name: str, fd: int) -> bool:
    """The whole chain still names the directories it bound, and `name` in the
    innermost one is still the file open on `fd`."""
    if not chain.verify():
        return False
    try:
        named = os.lstat(name, dir_fd=chain.fd)
    except FileNotFoundError:
        return False
    return not stat.S_ISLNK(named.st_mode) and _same(named, os.fstat(fd))


def _write_owned(chain: Chain, name: str, data: bytes) -> None:
    """Create `name` (never an existing one) in the chain's directory and write
    `data` in chunks, each only while the chain and the name still point at
    what was bound and created.

    Checked before the create, after it, and immediately before every chunk
    (and once after the last). On any change nothing more is written and the
    capture stops: the file this call created is LEFT where it now is, possibly
    empty or partial, and nothing is deleted, because there is no standard way
    to remove a name only if it is still this file. A same-user rename landing
    between a check and the write that follows it cannot be excluded by any
    check; it is bounded to that one chunk (WRITE_CHUNK bytes)."""
    if not chain.verify():
        raise Escape("the output directory moved; nothing more is written")
    fd = os.open(name, NEW_FILE_FLAGS, 0o600, dir_fd=chain.fd)
    try:
        view = memoryview(data)
        while True:
            if not _still_mine(chain, name, fd):
                raise Escape("the output moved; nothing more is written and the file created is left in place")
            if not view:
                return
            written = os.write(fd, view[:WRITE_CHUNK])
            view = view[written:]
    finally:
        os.close(fd)


def _make_owned_dir(chain: Chain, name: str, exist_ok: bool) -> None:
    """Create `name` below the chain's directory (0700), then bind it into the
    chain by its first open. An existing entry is used only when allowed and
    only when it is a real directory owned by this user.

    A directory this call created must, once opened, be empty and have no
    group or other permission bits. That is the most that can be checked:
    `mkdir` returns no identity, so a same-user directory swapped in between
    the `mkdir` and the first `lstat` is indistinguishable from the one created
    (it is still at the owned name, under the bound parent). Nothing that is
    not this script's own is ever removed."""
    created = True
    try:
        os.mkdir(name, 0o700, dir_fd=chain.fd)
    except FileExistsError:
        if not exist_ok:
            raise
        created = False
    try:
        chain.descend(name)
    except Refusal as refusal:
        raise UsageError("%s/%s is not a real directory (%s)" % (chain.base.flag, name, refusal.reason))
    opened = chain.links[-1][2]
    if opened.st_uid != os.geteuid():
        raise UsageError("%s/%s is not owned by this user" % (chain.base.flag, name))
    if created:
        with os.scandir(chain.fd) as entries:
            not_empty = any(True for _ in entries)
        if not_empty or opened.st_mode & 0o077:
            raise UsageError("%s/%s is not the empty private directory just created" % (chain.base.flag, name))


# ── marker ─────────────────────────────────────────────────────────────────


def mark(runner_temp: str, head: str, run_id: str, attempt: str, shard: str,
         now_ns: Callable[[], int] = time.time_ns) -> str:
    """Write the marker. Refuses to reuse an existing diagnostics directory."""
    _validate_identity(head, run_id, attempt, shard)
    base = Base(runner_temp, "--runner-temp")
    chain = Chain(base)
    try:
        _make_owned_dir(chain, DIAG_DIR, exist_ok=False)  # FileExistsError on reuse
        epoch_ns = now_ns()
        body = {
            "schema": SCHEMA_MARKER,
            "github_sha": head,
            "run_id": int(run_id),
            "run_attempt": int(attempt),
            "shard": shard,
            "marker_epoch_ns": epoch_ns,
            "marker_utc": _utc(epoch_ns),
        }
        _write_owned(chain, MARKER_NAME, (json.dumps(body, sort_keys=True) + "\n").encode("utf-8"))
    finally:
        chain.close()
        base.close()
    return os.path.join(runner_temp, DIAG_DIR, MARKER_NAME)


MARKER_KEYS = {"schema", "github_sha", "run_id", "run_attempt", "shard", "marker_epoch_ns", "marker_utc"}


def read_marker(diag_fd: int, head: str, run_id: str, attempt: str, shard: str) -> dict:
    """The marker, if it is exactly the one `mark` wrote for this job.

    Raises Refusal with the reason it is not."""
    try:
        fd, st = open_file_in(diag_fd, MARKER_NAME)
    except Refusal as refusal:
        raise Refusal({"absent": "marker_missing"}.get(refusal.reason, "marker_not_regular"))
    try:
        if st.st_size > MAX_MARKER_BYTES:
            raise Refusal("marker_oversize")
        raw = os.read(fd, MAX_MARKER_BYTES + 1)
    finally:
        os.close(fd)
    try:
        marker = _DECODER.decode(raw.decode("utf-8"))
    except ValueError:
        raise Refusal("marker_malformed")
    if not isinstance(marker, dict) or set(marker) != MARKER_KEYS or marker["schema"] != SCHEMA_MARKER:
        raise Refusal("marker_malformed")
    for key in ("marker_epoch_ns", "run_attempt", "run_id"):
        if _plain_int(marker[key]) is None or marker[key] <= 0:
            raise Refusal("marker_malformed")
    if (marker["github_sha"], marker["run_id"], marker["run_attempt"], marker["shard"]) != \
            (head, int(run_id), int(attempt), shard):
        raise Refusal("marker_binding_mismatch")
    return marker


# ── Mach-O LC_UUID ─────────────────────────────────────────────────────────

MH_MAGIC_64_LE = b"\xcf\xfa\xed\xfe"
FAT_MAGIC = 0xCAFEBABE
FAT_MAGIC_64 = 0xCAFEBABF
CPU_TYPE_ARM64 = 0x0100000C
LC_UUID = 0x1B


def _pread_exact(fd: int, offset: int, length: int) -> bytes:
    data = os.pread(fd, length, offset)
    if len(data) != length:
        raise Refusal("macho_truncated")
    return data


def _thin_uuid(fd: int, offset: int, size: int) -> str:
    header = _pread_exact(fd, offset, 32)
    if header[:4] != MH_MAGIC_64_LE:
        raise Refusal("macho_not_64bit_little_endian")
    _, cputype, _, _, ncmds, sizeofcmds, _, _ = struct.unpack("<IiiIIIII", header)
    if cputype != CPU_TYPE_ARM64:
        raise Refusal("macho_not_arm64")
    if sizeofcmds > MAX_MACHO_LOAD_COMMAND_BYTES or 32 + sizeofcmds > size:
        raise Refusal("macho_load_commands_out_of_bounds")
    commands = _pread_exact(fd, offset + 32, sizeofcmds)
    found = []
    at = 0
    for _ in range(ncmds):
        if at + 8 > sizeofcmds:
            raise Refusal("macho_load_commands_out_of_bounds")
        cmd, cmdsize = struct.unpack_from("<II", commands, at)
        if cmdsize < 8 or at + cmdsize > sizeofcmds:
            raise Refusal("macho_load_commands_out_of_bounds")
        if cmd == LC_UUID:
            if cmdsize != 24:
                raise Refusal("macho_bad_lc_uuid")
            found.append(commands[at + 8:at + 24])
        at += cmdsize
    if len(found) != 1:
        raise Refusal("macho_no_lc_uuid" if not found else "macho_multiple_lc_uuid")
    h = found[0].hex().upper()
    return "%s-%s-%s-%s-%s" % (h[:8], h[8:12], h[12:16], h[16:20], h[20:])


def macho_arm64_uuid_fd(fd: int) -> str:
    """The LC_UUID of the arm64 image in an open thin or fat Mach-O file.
    Reads only the headers and load commands."""
    size = os.fstat(fd).st_size
    if size < 8:
        raise Refusal("macho_truncated")
    first = _pread_exact(fd, 0, 8)
    if first[:4] == MH_MAGIC_64_LE:
        return _thin_uuid(fd, 0, size)
    magic, nfat = struct.unpack(">II", first)
    if magic not in (FAT_MAGIC, FAT_MAGIC_64):
        raise Refusal("not_macho")
    if nfat == 0 or nfat > MAX_FAT_ARCHS:
        raise Refusal("macho_bad_fat_header")
    entry = 20 if magic == FAT_MAGIC else 32
    table = _pread_exact(fd, 8, nfat * entry)
    slices = []
    for k in range(nfat):
        if magic == FAT_MAGIC:
            cputype, _, off, length, _ = struct.unpack_from(">iiIII", table, k * entry)
        else:
            cputype, _, off, length, _, _ = struct.unpack_from(">iiQQII", table, k * entry)
        if cputype == CPU_TYPE_ARM64:
            slices.append((off, length))
    if not slices:
        raise Refusal("macho_no_arm64_slice")
    if len(slices) > 1:
        raise Refusal("macho_ambiguous_arm64_slices")
    off, length = slices[0]
    if off + length > size:
        raise Refusal("macho_truncated")
    return _thin_uuid(fd, off, length)


def macho_arm64_uuid(path: str) -> str:
    """`macho_arm64_uuid_fd` for a path, never following a link at its last component."""
    fd = os.open(path, FILE_FLAGS)
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            raise Refusal("nonregular")
        return macho_arm64_uuid_fd(fd)
    finally:
        os.close(fd)


def built_images(temp: Base, shard: str, clock: Callable[[], float] = time.monotonic,
                 deadline: float = float("inf")) -> List[dict]:
    """The LC_UUIDs of the binaries this job built. Charged to the capture's
    one deadline: nothing is started, and nothing finished late is used,
    once it has passed."""
    out = []
    root = "dd-mac-ui-%s" % shard
    for role, process, parts in BUILT_IMAGES:
        entry = {"role": role, "process": process, "path": "/".join((root,) + parts),
                 "present": False, "uuid": None, "error": None}
        out.append(entry)
        if clock() >= deadline:
            entry["error"] = "deadline"
            continue
        try:
            chain = open_chain(temp, (root,) + parts[:-1])
        except Refusal as refusal:
            entry["error"] = refusal.reason
            continue
        try:
            fd, _ = open_file_in(chain.fd, parts[-1])
        except Refusal as refusal:
            entry["error"] = {"symlink_file": "symlink"}.get(refusal.reason, refusal.reason)
            chain.close()
            continue
        try:
            entry["present"] = True
            uuid = macho_arm64_uuid_fd(fd)
            if clock() >= deadline:
                entry["error"] = "deadline"
            elif chain.verify():
                entry["uuid"] = uuid
            else:
                entry["error"] = "replaced"
        except Refusal as refusal:
            entry["error"] = refusal.reason
        except OSError as err:
            entry["error"] = "os_error_%d" % err.errno
        finally:
            os.close(fd)
            chain.close()
    return out


# ── one report ─────────────────────────────────────────────────────────────


def _read_all(fd: int, size: int) -> bytes:
    chunks = []
    remaining = size + 1  # one byte more than expected, to see growth
    while remaining > 0:
        chunk = os.read(fd, min(remaining, 1024 * 1024))
        if not chunk:
            break
        chunks.append(chunk)
        remaining -= len(chunk)
    return b"".join(chunks)


def read_stable(chain: Chain, name: str, expect, limit: int) -> bytes:
    """The bytes of `name` in the chain's directory, if it is still exactly the
    scan's candidate `expect`, within `limit`, and the directory chain and the
    file are the same, unchanged, before and after the read.

    The read is bounded by the candidate's verified size (at most `limit`, plus
    one byte to see growth) — never by whatever size the file has now."""
    if expect.st_size > limit:
        raise Refusal("oversize")
    if not chain.verify():
        raise Refusal("source_dir_replaced")
    fd, before = open_file_in(chain.fd, name, expect=expect, limit=limit)
    try:
        data = _read_all(fd, expect.st_size)
        after_fd = os.fstat(fd)
    finally:
        os.close(fd)
    try:
        after_name = os.lstat(name, dir_fd=chain.fd)
    except FileNotFoundError:
        raise Refusal("unstable")
    if len(data) != before.st_size or _identity(after_fd) != _identity(before) or _identity(after_name) != _identity(before):
        raise Refusal("unstable")
    if not chain.verify():
        raise Refusal("source_dir_replaced")
    return data


def _header_epoch_ns(value) -> Optional[int]:
    if not isinstance(value, str):
        return None
    m = HEADER_TIME_RE.match(value)
    if not m:
        return None
    year, month, day, hour, minute, second, frac, sign, oh, om = m.groups()
    try:
        offset = datetime.timedelta(hours=int(oh), minutes=int(om))
        tz = datetime.timezone(offset if sign == "+" else -offset)
        moment = datetime.datetime(int(year), int(month), int(day), int(hour), int(minute), int(second), tzinfo=tz)
    except ValueError:
        return None
    fraction_ns = int((frac or "0").ljust(9, "0")[:9])
    return int(moment.timestamp()) * 1_000_000_000 + fraction_ns


def parse_ips(data: bytes) -> Tuple[dict, dict]:
    """The two JSON objects of an `.ips` crash report: a one-line header, then the body."""
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError:
        raise Refusal("malformed_encoding")
    newline = text.find("\n")
    if newline < 0:
        raise Refusal("malformed_header")
    try:
        header = _DECODER.decode(text[:newline])
    except ValueError:
        raise Refusal("malformed_header")
    rest = text[newline + 1:]
    stripped = rest.lstrip()
    try:
        body, end = _DECODER.raw_decode(stripped)
    except ValueError:
        raise Refusal("malformed_body")
    if stripped[end:].strip():
        raise Refusal("trailing_garbage")
    if not isinstance(header, dict):
        raise Refusal("malformed_header")
    if not isinstance(body, dict):
        raise Refusal("malformed_body")
    return header, body


def _frames(body: dict):
    threads = body.get("threads")
    if isinstance(threads, list):
        for thread in threads:
            if isinstance(thread, dict) and isinstance(thread.get("frames"), list):
                for frame in thread["frames"]:
                    if isinstance(frame, dict):
                        yield frame
    backtrace = body.get("lastExceptionBacktrace")
    if isinstance(backtrace, list):
        for frame in backtrace:
            if isinstance(frame, dict):
                yield frame


def matched_image_symbols(body: dict, built: Dict[str, str]) -> List[dict]:
    """Frame counts for the report's images whose UUID is one this job built."""
    images = body.get("usedImages")
    if not isinstance(images, list):
        return []
    counts = {}
    for index, image in enumerate(images):
        if not isinstance(image, dict):
            continue
        uuid = _norm_uuid(image.get("uuid"))
        if uuid is not None and uuid in built:
            counts[index] = {"image_index": index, "role": built[uuid], "uuid": uuid,
                             "name": _short_str(image.get("name")),
                             "frames_total": 0, "frames_with_symbol": 0, "frames_without_symbol": 0}
    for frame in _frames(body):
        index = _plain_int(frame.get("imageIndex"))
        if index in counts:
            entry = counts[index]
            entry["frames_total"] += 1
            symbol = frame.get("symbol")
            if isinstance(symbol, str) and symbol:
                entry["frames_with_symbol"] += 1
            else:
                entry["frames_without_symbol"] += 1
    return [counts[k] for k in sorted(counts)]


def evaluate(name: str, data: bytes, marker_epoch_ns: int, built: List[dict]) -> dict:
    """Validate one report's bytes completely. Raises Refusal; writes nothing."""
    process = REPORT_NAME.match(name).group(1)
    header, body = parse_ips(data)
    if header.get("bug_type") != "309":
        raise Refusal("wrong_bug_type")
    if "bug_type" in body and body.get("bug_type") != "309":
        raise Refusal("wrong_bug_type")
    header_bundle = header.get("bundleID")
    info = body.get("bundleInfo")
    body_bundle = info.get("CFBundleIdentifier") if isinstance(info, dict) else None
    bundles = [b for b in (header_bundle, body_bundle) if b is not None]
    if not bundles or any(b != EXPECTED[process] for b in bundles):
        raise Refusal("wrong_bundle")
    for key in ("app_name", "name"):
        if key in header and header[key] != process:
            raise Refusal("wrong_process_name")
    if "procName" in body and body["procName"] != process:
        raise Refusal("wrong_process_name")
    header_ns = _header_epoch_ns(header.get("timestamp"))
    if header_ns is None:
        raise Refusal("header_time_unparseable")
    # The header carries the time to 1/100 s; the marker's whole second is the
    # one documented allowance (below a second, never more).
    if header_ns < (marker_epoch_ns // 1_000_000_000) * 1_000_000_000:
        raise Refusal("header_time_before_marker")
    pid = body.get("pid")
    if pid is not None and _plain_int(pid) is None:
        raise Refusal("malformed_pid")

    by_uuid = {b["uuid"]: b["role"] for b in built if b.get("uuid")}
    slice_uuid = _norm_uuid(header.get("slice_uuid"))
    own = [b.get("uuid") for b in built if b.get("process") == process and b.get("uuid")]
    if slice_uuid is None or not own:
        provenance = "unknown"
    elif slice_uuid in own:
        provenance = "match"
    else:
        provenance = "mismatch"
    symbols = matched_image_symbols(body, by_uuid)
    exception = body.get("exception") if isinstance(body.get("exception"), dict) else {}
    termination = body.get("termination") if isinstance(body.get("termination"), dict) else {}
    asi = body.get("asi") if isinstance(body.get("asi"), dict) else {}
    threads = body.get("threads") if isinstance(body.get("threads"), list) else []
    return {
        "process": process,
        "header": {
            "bug_type": header.get("bug_type"),
            "bundleID": _short_str(header_bundle),
            "app_name": _short_str(header.get("app_name")),
            "name": _short_str(header.get("name")),
            "app_version": _short_str(header.get("app_version")),
            "build_version": _short_str(header.get("build_version")),
            "slice_uuid": slice_uuid,
            "incident_id": _norm_uuid(header.get("incident_id")),
            "timestamp": _short_str(header.get("timestamp")),
            "os_version": _short_str(header.get("os_version")),
        },
        "body_bundle_identifier": _short_str(body_bundle),
        "pid": _plain_int(pid),
        "capture_time": _short_str(body.get("captureTime")),
        "exception": {"type": _short_str(exception.get("type")), "signal": _short_str(exception.get("signal"))},
        "termination": {"namespace": _short_str(termination.get("namespace")),
                        "indicator": _short_str(termination.get("indicator"))},
        "asi_images": sorted(k for k in asi if isinstance(k, str) and len(k) <= MAX_FIELD_CHARS)[:32],
        "faulting_thread": _plain_int(body.get("faultingThread")),
        "thread_count": len(threads),
        "uuid_provenance": provenance,
        "matched_images": symbols,
        "unsymbolized_frames_in_built_images": sum(s["frames_without_symbol"] for s in symbols),
    }


# ── a scan of both directories ─────────────────────────────────────────────


class Refusals:
    """A bounded record of refusals: the first MAX_RECORDED_REFUSALS, then a count."""

    def __init__(self):
        self.items = []
        self.omitted = 0

    def add(self, label: str, name: str, reason: str) -> None:
        if len(self.items) < MAX_RECORDED_REFUSALS:
            self.items.append({"source_dir": label, "source_name": name, "reason": reason})
        else:
            self.omitted += 1


def scan(home: Base, marker_epoch_ns: int, built: List[dict], clock: Callable[[], float], deadline: float) -> dict:
    """One bounded pass over the two directories. Validates; writes nothing.

    Stops — and says so — at the deadline, at MAX_DIR_ENTRIES entries in a
    directory or at MAX_FRESH_CANDIDATES fresh candidates."""
    dirs = []
    refusals = Refusals()
    candidates = []  # (label, name, lstat, chain)
    chains = []
    ignored = 0
    stopped = None
    try:
        for label, parts in SOURCE_DIRS:
            if stopped:
                dirs.append({"label": label, "status": "not_scanned", "entries_examined": 0})
                continue
            try:
                chain = open_chain(home, parts)
            except Refusal as refusal:
                dirs.append({"label": label, "status": refusal.reason, "entries_examined": 0})
                continue
            chains.append(chain)
            examined = 0
            with os.scandir(chain.fd) as entries:
                for entry in entries:
                    if clock() >= deadline:
                        stopped = "deadline"
                        break
                    if examined >= MAX_DIR_ENTRIES:
                        stopped = "entry_cap"
                        break
                    examined += 1
                    name = entry.name
                    if not REPORT_NAME.match(name):
                        ignored += 1
                        continue
                    try:
                        st = os.lstat(name, dir_fd=chain.fd)
                    except FileNotFoundError:
                        continue
                    if stat.S_ISLNK(st.st_mode):
                        refusals.add(label, name, "symlink_file")
                    elif not stat.S_ISREG(st.st_mode):
                        refusals.add(label, name, "nonregular")
                    elif st.st_mtime_ns < marker_epoch_ns:
                        refusals.add(label, name, "older_than_marker")
                    elif st.st_size > MAX_REPORT_BYTES:
                        refusals.add(label, name, "oversize")
                    elif len(candidates) >= MAX_FRESH_CANDIDATES:
                        stopped = "candidate_cap"
                        break
                    else:
                        candidates.append((label, name, st, chain))
            status = "ok" if chain.verify() else "replaced"
            dirs.append({"label": label, "status": status, "entries_examined": examined})
            if status != "ok":
                candidates = [c for c in candidates if c[3] is not chain]

        accepted = []
        candidates.sort(key=lambda c: (c[2].st_mtime_ns, c[0], c[1]))
        total = 0
        for k, (label, name, st, chain) in enumerate(candidates):
            if k >= MAX_CANDIDATES:
                refusals.add(label, name, "count_cap")
                continue
            if total + st.st_size > MAX_TOTAL_BYTES:
                refusals.add(label, name, "total_cap")
                continue
            if clock() >= deadline:
                refusals.add(label, name, "deadline")
                stopped = stopped or "deadline"
                continue
            try:
                data = read_stable(chain, name, st, min(MAX_REPORT_BYTES, MAX_TOTAL_BYTES - total))
                info = evaluate(name, data, marker_epoch_ns, built)
            except Refusal as refusal:
                refusals.add(label, name, refusal.reason)
                continue
            if clock() >= deadline:  # finished late: not used
                refusals.add(label, name, "deadline")
                stopped = stopped or "deadline"
                continue
            total += len(data)
            accepted.append({"source_dir": label, "source_name": name, "data": data, "info": info,
                             "mtime_ns": st.st_mtime_ns})
    finally:
        for chain in chains:
            chain.close()
    return {"dirs": dirs, "accepted": accepted, "refused": refusals.items, "refused_omitted": refusals.omitted,
            "ignored_non_matching_names": ignored, "complete": stopped is None, "stopped": stopped}


def poll(home: Base, marker_epoch_ns: int, built: List[dict], find_by: float, hard: float, settle_seconds: int,
         clock: Callable[[], float] = time.monotonic, sleep: Callable[[float], None] = time.sleep) -> Tuple[dict, dict]:
    """Scan once a second while nothing is found (until `find_by`), then wait
    once and rescan. `hard` is the capture's one work deadline, fixed before
    any preparation began: scanning, reading and parsing are charged to it, the
    settle wait and rescan get only what is left, and nothing resets it."""
    scans = 0
    settle = 0
    settle_skipped = None
    while True:
        result = scan(home, marker_epoch_ns, built, clock, hard)
        scans += 1
        if result["accepted"] or clock() >= find_by:
            break
        sleep(min(1.0, max(0.0, find_by - clock())))
    if result["accepted"] and settle_seconds > 0:
        left = hard - clock()
        if left <= 0:
            settle_skipped = "budget_spent"
        else:
            sleep(min(float(settle_seconds), left))
            if clock() < hard:
                again = scan(home, marker_epoch_ns, built, clock, hard)
                scans += 1
                settle = 1
                # A rescan that found less (a directory replaced, the deadline hit)
                # does not discard what was already validated.
                if len(again["accepted"]) >= len(result["accepted"]):
                    result = again
                else:
                    result["refused"] = result["refused"] + again["refused"]
                    result["complete"] = False
                    result["stopped"] = result["stopped"] or again["stopped"] or "settle_rescan_found_less"
            else:
                settle_skipped = "budget_spent"
    stats = {"settle_seconds": settle_seconds, "scans": scans, "settle_rescans": settle,
             "settle_skipped": settle_skipped}
    return result, stats


# ── capture ────────────────────────────────────────────────────────────────


def _arm_watchdog(seconds: float) -> Callable[[], None]:
    """A real-time alarm that raises DeadlineExceeded after `seconds`, also out
    of a blocking read (PEP 475 retries an interrupted call only when the
    handler returns). Main thread only; returns the disarm function."""

    def fire(signum, frame):
        raise DeadlineExceeded("the capture's %.0f s budget is spent" % seconds)

    previous = signal.signal(signal.SIGALRM, fire)
    signal.setitimer(signal.ITIMER_REAL, max(0.001, seconds))

    def disarm() -> None:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, previous)

    return disarm



def capture(runner_temp: str, home: str, head: str, run_id: str, attempt: str, shard: str,
            poll_seconds: int = POLL_SECONDS_MAX, settle_seconds: int = SETTLE_SECONDS_MAX,
            clock: Callable[[], float] = time.monotonic, sleep: Callable[[float], None] = time.sleep,
            now_ns: Callable[[], int] = time.time_ns, watchdog: bool = False) -> Tuple[int, dict]:
    """Capture; returns (exit status, manifest). Writes only inside
    `<runner_temp>/macos-crash-diagnostics/capture`, created here, through its
    own descriptor; that directory must not exist yet.

    ONE budget, `poll_seconds + settle_seconds` (at least 1 s), starts here,
    before any preparation. Work (marker, built binaries, scanning, reading,
    parsing, the settle) must finish by `start + budget - reserve`, the reserve
    being at most WRITE_RESERVE_SECONDS for the manifest; anything that
    finishes later is refused, and nothing resets the budget. That deadline is
    COOPERATIVE: it is checked between and after operations. With `watchdog`
    (the command line), a real-time alarm also ends the capture at
    `start + budget` even inside a blocking read; the workflow step's own
    2-minute timeout remains the outer bound."""
    _validate_identity(head, run_id, attempt, shard)
    if not 0 <= poll_seconds <= POLL_SECONDS_MAX:
        raise UsageError("--poll-seconds must be 0..%d" % POLL_SECONDS_MAX)
    if not 0 <= settle_seconds <= SETTLE_SECONDS_MAX:
        raise UsageError("--settle-seconds must be 0..%d" % SETTLE_SECONDS_MAX)
    start = clock()
    budget = max(1, poll_seconds + settle_seconds)
    reserve = min(WRITE_RESERVE_SECONDS, budget / 4.0)
    work_deadline = start + budget - reserve
    find_by = min(start + poll_seconds, work_deadline)
    disarm = _arm_watchdog(budget) if watchdog else None
    temp = None
    homes = None
    out = None
    try:
        temp = Base(runner_temp, "--runner-temp")
        out = Chain(temp)
        homes = Base(home, "--home")
        _make_owned_dir(out, DIAG_DIR, exist_ok=True)  # the marker step may have failed
        diag_fd = out.fd
        _make_owned_dir(out, CAPTURE_DIR, exist_ok=False)  # FileExistsError if anything is there
        timing = {"budget_seconds": budget, "work_deadline_seconds": round(budget - reserve, 3),
                  "poll_limit_seconds": poll_seconds, "watchdog": "armed" if watchdog else "not_armed"}
        manifest = {
            "schema": SCHEMA_MANIFEST,
            "github_sha": head,
            "run_id": int(run_id),
            "run_attempt": int(attempt),
            "shard": shard,
            "capture_started_utc": _utc(now_ns()),
            "limitations": LIMITATIONS,
            "caps": {"candidates": MAX_CANDIDATES, "file_bytes": MAX_REPORT_BYTES, "total_bytes": MAX_TOTAL_BYTES,
                     "dir_entries": MAX_DIR_ENTRIES, "fresh_candidates": MAX_FRESH_CANDIDATES},
        }

        def finish(status_code: int) -> Tuple[int, dict]:
            manifest["capture_finished_utc"] = _utc(now_ns())
            elapsed = clock() - start
            # Recorded as measured, never clamped: a late finish says so.
            timing["elapsed_seconds"] = round(elapsed, 3)
            timing["overrun_seconds"] = round(max(0.0, elapsed - budget), 3)
            manifest["timing"] = timing
            _write_owned(out, MANIFEST_NAME, (json.dumps(manifest, indent=2, sort_keys=True) + "\n").encode("utf-8"))
            return status_code, manifest

        try:
            marker = read_marker(diag_fd, head, run_id, attempt, shard)
        except Refusal as refusal:
            manifest.update({"status": refusal.reason, "reports": [], "refused": []})
            return finish(3)
        manifest["marker_utc"] = marker["marker_utc"]
        built = built_images(temp, shard, clock, work_deadline)
        manifest["built_images"] = built
        result, stats = poll(homes, marker["marker_epoch_ns"], built, find_by, work_deadline, settle_seconds,
                             clock, sleep)
        manifest["poll"] = stats
        manifest["source_dirs"] = result["dirs"]
        manifest["scan"] = {"complete": result["complete"], "stopped": result["stopped"]}
        manifest["ignored_non_matching_names" if result["complete"] else "ignored_non_matching_names_at_least"] = \
            result["ignored_non_matching_names"]
        manifest["refused"] = result["refused"]
        manifest["refused_omitted"] = result["refused_omitted"]
        reports = []
        if result["accepted"]:
            if not out.verify():
                raise Escape("the capture directory moved; nothing more is written")
            _make_owned_dir(out, REPORTS_SUBDIR, exist_ok=False)  # bound into the chain
            try:
                for item in result["accepted"]:
                    stored = "%s__%s" % (item["source_dir"], item["source_name"])
                    _write_owned(out, stored, item["data"])
                    entry = {"source_dir": item["source_dir"], "source_name": item["source_name"],
                             "stored_as": "%s/%s" % (REPORTS_SUBDIR, stored), "size": len(item["data"]),
                             "sha256": hashlib.sha256(item["data"]).hexdigest(),
                             "mtime_utc": _utc(item["mtime_ns"])}
                    entry.update(item["info"])
                    reports.append(entry)
            finally:
                out.pop()
        manifest["reports"] = reports
        if reports:
            manifest["status"] = "captured"
        elif result["refused"] or result["refused_omitted"]:
            manifest["status"] = "refused_only"
        else:
            manifest["status"] = "no_report"
        return finish(0)
    finally:
        if disarm is not None:
            disarm()
        if out is not None:
            out.close()
        if homes is not None:
            homes.close()
        if temp is not None:
            temp.close()


# ── command line ───────────────────────────────────────────────────────────


def main(argv: List[str]) -> int:
    parser = argparse.ArgumentParser(prog="macos-ui-crash-diagnostics.py")
    sub = parser.add_subparsers(dest="command")
    for name in ("mark", "capture"):
        p = sub.add_parser(name)
        p.add_argument("--runner-temp", required=True)
        p.add_argument("--head", required=True)
        p.add_argument("--run-id", required=True)
        p.add_argument("--attempt", required=True)
        p.add_argument("--shard", required=True)
        if name == "capture":
            p.add_argument("--home", required=True)
            p.add_argument("--poll-seconds", type=int, default=POLL_SECONDS_MAX)
            p.add_argument("--settle-seconds", type=int, default=SETTLE_SECONDS_MAX)
    args = parser.parse_args(argv)
    try:
        if args.command == "mark":
            path = mark(args.runner_temp, args.head, args.run_id, args.attempt, args.shard)
            print("crash diagnostics marker: %s" % path)
            return 0
        if args.command == "capture":
            status, manifest = capture(args.runner_temp, args.home, args.head, args.run_id, args.attempt, args.shard,
                                       args.poll_seconds, args.settle_seconds, watchdog=True)
            print("crash diagnostics: %s, %d report(s) kept, %d refused%s"
                  % (manifest["status"], len(manifest.get("reports", [])), len(manifest.get("refused", [])),
                     "" if manifest.get("scan", {}).get("complete", True) else " (scan incomplete)"))
            for report in manifest.get("reports", []):
                print("  kept %s/%s sha256=%s uuid_provenance=%s pid=%s"
                      % (report["source_dir"], report["source_name"], report["sha256"],
                         report["uuid_provenance"], report["pid"]))
            for refusal in manifest.get("refused", []):
                print("  refused %s/%s: %s" % (refusal["source_dir"], refusal["source_name"], refusal["reason"]))
            return status
        parser.print_usage(sys.stderr)
        return 2
    except UsageError as err:
        print("macos-ui-crash-diagnostics: %s" % err, file=sys.stderr)
        return 2
    except FileExistsError as err:
        print("macos-ui-crash-diagnostics: already exists: %s" % err.filename, file=sys.stderr)
        return 4
    except Escape as err:
        print("macos-ui-crash-diagnostics: %s" % err, file=sys.stderr)
        return 4
    except DeadlineExceeded as err:
        print("macos-ui-crash-diagnostics: %s; stopped, no manifest" % err, file=sys.stderr)
        return 5


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

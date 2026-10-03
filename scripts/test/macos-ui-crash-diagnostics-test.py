#!/usr/bin/env python3
"""scripts/test/macos-ui-crash-diagnostics-test.py — the failure-only crash
report capture in `macos.yml` keeps only what it may, and is wired the way it
claims.

The helper (`scripts/ci/macos-ui-crash-diagnostics.py`) runs on a hosted macOS
runner only after a UI smoke step has FAILED, so a hosted run proves nothing
about what it refuses. Everything here is hermetic: synthetic `.ips` reports and
synthetic Mach-O files in a temporary directory, the REAL helper module, a fake
clock for the polling bounds, and the real workflow text for the wiring. No
Apple tooling, no network, no file outside the temporary directory is written.

Each refusal case is the positive report with exactly one thing changed, and
asserts the one reason it was refused, so a guard that stops working turns its
own case red rather than some other one.

Python 3.9 standard library only. Run: python3 scripts/test/macos-ui-crash-diagnostics-test.py
"""

import hashlib
import importlib.util
import io
import json
import os
import re
import shutil
import signal
import struct
import subprocess
import sys
import tempfile
import time
import unittest

ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))
HELPER_PATH = os.path.join(ROOT, "scripts", "ci", "macos-ui-crash-diagnostics.py")
MACOS_YML = os.path.join(ROOT, ".github", "workflows", "macos.yml")
HYGIENE_YML = os.path.join(ROOT, ".github", "workflows", "repo-hygiene.yml")

_spec = importlib.util.spec_from_file_location("macos_ui_crash_diagnostics", HELPER_PATH)
H = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(H)

SHA = "c681ce602c6936d5250b68552d973bd9b5e6aa5c"
RUN_ID = "37072256451"
ATTEMPT = "1"
SHARD = "device-inbox"
T0 = 1790980877_000_000_000  # 2026-10-02T22:41:17Z, the original test's start
SECOND = 1_000_000_000
APP_UUID = "0A1B2C3D-4E5F-6071-8293-A4B5C6D7E8F9"
DYLIB_UUID = "11111111-2222-3333-4444-555555555555"
RUNNER_UUID = "99999999-8888-7777-6666-555555555555"
OTHER_UUID = "DEADBEEF-0000-1111-2222-333333333333"
REPORT = "Relayium-2026-10-02-224143.ips"


# ── fixtures ───────────────────────────────────────────────────────────────


def uuid_bytes(text):
    return bytes.fromhex(text.replace("-", ""))


def macho_thin(uuid, cputype=0x0100000C, lc_uuids=1):
    """A minimal 64-bit little-endian Mach-O: one LC_SYMTAB-shaped command and LC_UUID."""
    commands = struct.pack("<II", 0x2, 24) + b"\0" * 16
    for _ in range(lc_uuids):
        commands += struct.pack("<II", 0x1B, 24) + uuid_bytes(uuid)
    ncmds = 1 + lc_uuids
    header = struct.pack("<IiiIIIII", 0xFEEDFACF, cputype, 0, 0x2, ncmds, len(commands), 0, 0)
    return header + commands + b"\0" * 64


def macho_fat(slices, wide=False):
    """A fat file holding `slices`: [(cputype, thin bytes)], each aligned to 4096."""
    magic = 0xCAFEBABF if wide else 0xCAFEBABE
    entry = 32 if wide else 20
    table_end = 8 + entry * len(slices)
    offset = (table_end + 4095) // 4096 * 4096
    table = b""
    body = b""
    for cputype, thin in slices:
        if wide:
            table += struct.pack(">iiQQII", cputype, 0, offset + len(body), len(thin), 12, 0)
        else:
            table += struct.pack(">iiIII", cputype, 0, offset + len(body), len(thin), 12)
        body += thin + b"\0" * ((4096 - len(thin) % 4096) % 4096)
    head = struct.pack(">II", magic, len(slices)) + table
    return head + b"\0" * (offset - len(head)) + body


def header_time(epoch_ns):
    seconds = epoch_ns // SECOND
    stamp = time.strftime("%Y-%m-%d %H:%M:%S", time.gmtime(seconds))
    return "%s.%02d +0000" % (stamp, (epoch_ns % SECOND) // 10_000_000)


def ips(process="Relayium", bundle="com.relayium.mac", when=T0 + 26 * SECOND, slice_uuid=APP_UUID,
        pid=9374, header_extra=None, body_extra=None, drop_header=(), drop_body=()):
    header = {"app_name": process, "timestamp": header_time(when), "app_version": "1.4.5",
              "slice_uuid": slice_uuid.lower() if slice_uuid else None, "build_version": "42",
              "platform": 1, "bundleID": bundle, "bug_type": "309", "os_version": "macOS 15.7.9 (24G830)",
              "name": process, "incident_id": "6B1E5D52-6A2D-4E0B-9F0B-7C9C1E2A3B4C"}
    if slice_uuid is None:
        del header["slice_uuid"]
    header.update(header_extra or {})
    body = {"pid": pid, "procName": process, "procPath": "/Users/USER/*/%s.app/Contents/MacOS/%s" % (process, process),
            "bundleInfo": {"CFBundleIdentifier": bundle, "CFBundleShortVersionString": "1.4.5", "CFBundleVersion": "42"},
            "captureTime": "2026-10-02 22:41:25.3914 +0000", "bug_type": "309",
            "exception": {"type": "EXC_CRASH", "signal": "SIGABRT"},
            "termination": {"namespace": "SIGNAL", "indicator": "Abort trap: 6"},
            "asi": {"libsystem_platform.dylib": ["BUG IN CLIENT OF LIBPLATFORM: os_unfair_lock is corrupt", "Abort Cause 258"]},
            "faultingThread": 0,
            "threads": [{"triggered": True, "frames": [
                {"imageOffset": 4096, "symbol": "_os_unfair_lock_corruption_abort", "symbolLocation": 88, "imageIndex": 0},
                {"imageOffset": 8192, "imageIndex": 1},
                {"imageOffset": 9000, "symbol": "$s8Relayium4mainyyF", "symbolLocation": 12, "imageIndex": 1},
                {"imageOffset": 777, "imageIndex": 2}]}],
            "usedImages": [
                {"uuid": "ab12cd34-0000-0000-0000-000000000001", "name": "libsystem_platform.dylib", "arch": "arm64e"},
                {"uuid": APP_UUID.lower(), "name": process, "arch": "arm64"},
                {"uuid": DYLIB_UUID.lower(), "name": "Relayium.debug.dylib", "arch": "arm64"}]}
    for key in drop_header:
        header.pop(key, None)
    for key in drop_body:
        body.pop(key, None)
    body.update(body_extra or {})
    return (json.dumps(header) + "\n" + json.dumps(body, indent=2)).encode("utf-8")


class World:
    """A runner temp directory, a runner home and the binaries this job built."""

    def __init__(self, base, app_uuid=APP_UUID, dylib=True, runner=True, marker=True):
        self.base = base
        self.temp = os.path.join(base, "runner-temp")
        self.home = os.path.join(base, "home")
        self.reports = os.path.join(self.home, "Library", "Logs", "DiagnosticReports")
        self.retired = os.path.join(self.reports, "Retired")
        os.makedirs(self.temp)
        os.makedirs(self.retired)
        macos = os.path.join(self.temp, "dd-mac-ui-%s" % SHARD, "Build", "Products", "Debug", "Relayium.app",
                             "Contents", "MacOS")
        os.makedirs(macos)
        if app_uuid:
            self.write(os.path.join(macos, "Relayium"), macho_thin(app_uuid))
        if dylib:
            self.write(os.path.join(macos, "Relayium.debug.dylib"), macho_thin(DYLIB_UUID))
        if runner:
            rmacos = os.path.join(self.temp, "dd-mac-ui-%s" % SHARD, "Build", "Products", "Debug",
                                  "RelayiumUITests-Runner.app", "Contents", "MacOS")
            os.makedirs(rmacos)
            self.write(os.path.join(rmacos, "RelayiumUITests-Runner"), macho_thin(RUNNER_UUID))
        if marker:
            H.mark(self.temp, SHA, RUN_ID, ATTEMPT, SHARD, now_ns=lambda: T0)

    @staticmethod
    def write(path, data, mtime_ns=None):
        with open(path, "wb") as f:
            f.write(data)
        if mtime_ns is not None:
            os.utime(path, ns=(mtime_ns, mtime_ns))

    def report(self, data, name=REPORT, where=None, mtime_ns=T0 + 26 * SECOND):
        path = os.path.join(where or self.reports, name)
        self.write(path, data, mtime_ns)
        return path

    def capture(self, **kw):
        kw.setdefault("poll_seconds", 0)
        kw.setdefault("settle_seconds", 0)
        return H.capture(self.temp, self.home, SHA, RUN_ID, ATTEMPT, SHARD, **kw)

    def out(self, *parts):
        return os.path.join(self.temp, H.DIAG_DIR, H.CAPTURE_DIR, *parts)


def snapshot(root):
    """Every path under `root` with its bytes' hash, size and mtime."""
    seen = {}
    for dirpath, dirnames, filenames in os.walk(root):
        for name in dirnames + filenames:
            path = os.path.join(dirpath, name)
            st = os.lstat(path)
            digest = None
            if os.path.isfile(path) and not os.path.islink(path):
                with open(path, "rb") as f:
                    digest = hashlib.sha256(f.read()).hexdigest()
            seen[os.path.relpath(path, root)] = (st.st_mode, st.st_size, st.st_mtime_ns, digest)
    return seen


class Case(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="mucd-")
        self.addCleanup(shutil.rmtree, self.tmp, True)

    def world(self, **kw):
        return World(os.path.join(self.tmp, "w"), **kw)

    def refused_one(self, world, reason, **kw):
        """Capture, and require the ONE candidate be refused for `reason` and nothing kept."""
        status, manifest = world.capture(**kw)
        self.assertEqual(status, 0)
        self.assertEqual(manifest["reports"], [], manifest)
        self.assertEqual([r["reason"] for r in manifest["refused"]], [reason], manifest["refused"])
        self.assertEqual(manifest["status"], "refused_only")
        self.assertFalse(os.path.exists(world.out(H.REPORTS_SUBDIR)), "a refused report was written")
        return manifest


# ── the positive report ────────────────────────────────────────────────────


class Positive(Case):
    def test_a_crash_report_after_the_marker_is_kept_byte_for_byte(self):
        w = self.world()
        data = ips()
        src = w.report(data)
        before_sources = snapshot(w.home)
        before_temp = snapshot(w.temp)
        status, m = w.capture()
        self.assertEqual(status, 0)
        self.assertEqual(m["status"], "captured")
        self.assertEqual(len(m["reports"]), 1)
        r = m["reports"][0]
        self.assertEqual(r["sha256"], hashlib.sha256(data).hexdigest())
        self.assertEqual(r["size"], len(data))
        with open(w.out(r["stored_as"]), "rb") as f:
            self.assertEqual(f.read(), data)
        self.assertEqual(r["source_dir"], "DiagnosticReports")
        self.assertEqual(r["source_name"], REPORT)
        self.assertEqual(r["uuid_provenance"], "match")
        self.assertEqual(r["header"]["slice_uuid"], APP_UUID)
        self.assertEqual(r["pid"], 9374)
        self.assertEqual(r["exception"], {"type": "EXC_CRASH", "signal": "SIGABRT"})
        self.assertEqual(r["asi_images"], ["libsystem_platform.dylib"])
        self.assertEqual(m["github_sha"], SHA)
        self.assertEqual(m["run_id"], int(RUN_ID))
        self.assertEqual(m["run_attempt"], 1)
        self.assertEqual(m["shard"], SHARD)
        self.assertEqual(m["marker_utc"], "2026-10-02T22:41:17.000000Z")
        # Frames of the images this job built, counted with and without a symbol.
        by_role = {i["role"]: i for i in r["matched_images"]}
        self.assertEqual(by_role["app_main"]["frames_total"], 2)
        self.assertEqual(by_role["app_main"]["frames_with_symbol"], 1)
        self.assertEqual(by_role["app_main"]["frames_without_symbol"], 1)
        self.assertEqual(by_role["app_debug_dylib"]["frames_without_symbol"], 1)
        self.assertEqual(r["unsymbolized_frames_in_built_images"], 2)
        # The source is untouched, and nothing outside the capture directory changed.
        self.assertEqual(snapshot(w.home), before_sources)
        after_temp = snapshot(w.temp)
        changed = {k for k in set(before_temp) | set(after_temp) if before_temp.get(k) != after_temp.get(k)}
        self.assertTrue(changed, "the capture wrote nothing")
        capture_rel = os.path.join(H.DIAG_DIR, H.CAPTURE_DIR)
        for path in changed:
            if path == H.DIAG_DIR:  # its own metadata moves when `capture/` is created in it
                self.assertEqual(before_temp[path][0], after_temp[path][0])
                continue
            self.assertTrue(path == capture_rel or path.startswith(capture_rel + os.sep), path)
        with open(src, "rb") as f:
            self.assertEqual(f.read(), data)

    def test_the_manifest_holds_only_allowlisted_fields(self):
        w = self.world()
        w.report(ips(body_extra={"environment": {"SECRET": "x"}, "vmSummary": "memory"}))
        _, m = w.capture()
        text = json.dumps(m["reports"])
        for leaked in ("SECRET", "vmSummary", "procPath", "/Users/USER", "os_unfair_lock is corrupt",
                       "_os_unfair_lock_corruption_abort", "Abort Cause"):
            self.assertNotIn(leaked, text)
        self.assertEqual(set(m["reports"][0]), {
            "source_dir", "source_name", "stored_as", "size", "sha256", "mtime_utc", "process", "header",
            "body_bundle_identifier", "pid", "capture_time", "exception", "termination", "asi_images",
            "faulting_thread", "thread_count", "uuid_provenance", "matched_images",
            "unsymbolized_frames_in_built_images"})

    def test_the_retired_directory_is_read_too(self):
        w = self.world()
        w.report(ips(), where=w.retired)
        _, m = w.capture()
        self.assertEqual([(r["source_dir"], r["source_name"]) for r in m["reports"]], [("Retired", REPORT)])

    def test_the_ui_test_runner_report_is_matched_to_the_runner_binary(self):
        w = self.world()
        name = "RelayiumUITests-Runner-2026-10-02-224143.ips"
        w.report(ips(process="RelayiumUITests-Runner", bundle="com.relayium.mac.UITests.xctrunner",
                     slice_uuid=RUNNER_UUID), name=name)
        _, m = w.capture()
        self.assertEqual(m["reports"][0]["uuid_provenance"], "match")
        self.assertEqual(m["reports"][0]["process"], "RelayiumUITests-Runner")

    def test_a_header_only_bundle_and_a_body_only_bundle_are_both_accepted(self):
        for drop_header, drop_body in ((("bundleID",), ()), ((), ("bundleInfo",))):
            w = World(os.path.join(self.tmp, "w%d" % len(drop_header)))
            w.report(ips(drop_header=drop_header, drop_body=drop_body))
            _, m = w.capture()
            self.assertEqual(m["status"], "captured", (drop_header, drop_body, m["refused"]))


class Provenance(Case):
    def test_mismatch_is_kept_and_labelled_not_matched(self):
        w = self.world(app_uuid=OTHER_UUID)
        w.report(ips())
        _, m = w.capture()
        self.assertEqual(m["reports"][0]["uuid_provenance"], "mismatch")
        self.assertEqual(m["status"], "captured")

    def test_no_built_binary_is_unknown_not_a_match(self):
        w = self.world(app_uuid=None)
        w.report(ips())
        _, m = w.capture()
        self.assertEqual(m["reports"][0]["uuid_provenance"], "unknown")
        app = [b for b in m["built_images"] if b["role"] == "app_main"][0]
        self.assertEqual((app["present"], app["error"]), (False, "absent"))

    def test_a_report_without_slice_uuid_is_unknown(self):
        w = self.world()
        w.report(ips(slice_uuid=None))
        _, m = w.capture()
        self.assertEqual(m["reports"][0]["uuid_provenance"], "unknown")

    def test_an_absent_debug_dylib_is_recorded_not_an_error(self):
        w = self.world(dylib=False)
        w.report(ips())
        status, m = w.capture()
        self.assertEqual(status, 0)
        dylib = [b for b in m["built_images"] if b["role"] == "app_debug_dylib"][0]
        self.assertEqual((dylib["present"], dylib["uuid"], dylib["error"]), (False, None, "absent"))
        self.assertEqual(m["reports"][0]["uuid_provenance"], "match")

    def test_no_binary_is_ever_copied_into_the_capture(self):
        w = self.world()
        w.report(ips())
        w.capture()
        for dirpath, _, filenames in os.walk(w.out()):
            for name in filenames:
                with open(os.path.join(dirpath, name), "rb") as f:
                    self.assertNotEqual(f.read(4), b"\xcf\xfa\xed\xfe", name)


class MachO(Case):
    def path(self, data):
        p = os.path.join(self.tmp, "bin")
        with open(p, "wb") as f:
            f.write(data)
        return p

    def test_thin_arm64(self):
        self.assertEqual(H.macho_arm64_uuid(self.path(macho_thin(APP_UUID))), APP_UUID)

    def test_fat_selects_the_arm64_slice_not_the_first(self):
        data = macho_fat([(0x01000007, macho_thin(OTHER_UUID, cputype=0x01000007)), (0x0100000C, macho_thin(APP_UUID))])
        self.assertEqual(H.macho_arm64_uuid(self.path(data)), APP_UUID)

    def test_fat64(self):
        data = macho_fat([(0x01000007, macho_thin(OTHER_UUID, cputype=0x01000007)), (0x0100000C, macho_thin(APP_UUID))],
                         wide=True)
        self.assertEqual(H.macho_arm64_uuid(self.path(data)), APP_UUID)

    def refuse(self, data, reason):
        with self.assertRaises(H.Refusal) as ctx:
            H.macho_arm64_uuid(self.path(data))
        self.assertEqual(ctx.exception.reason, reason)

    def test_refusals(self):
        self.refuse(macho_thin(APP_UUID, cputype=0x01000007), "macho_not_arm64")
        self.refuse(macho_fat([(0x01000007, macho_thin(OTHER_UUID, cputype=0x01000007))]), "macho_no_arm64_slice")
        self.refuse(macho_fat([(0x0100000C, macho_thin(APP_UUID)), (0x0100000C, macho_thin(OTHER_UUID))]),
                    "macho_ambiguous_arm64_slices")
        self.refuse(macho_thin(APP_UUID, lc_uuids=0), "macho_no_lc_uuid")
        self.refuse(macho_thin(APP_UUID, lc_uuids=2), "macho_multiple_lc_uuid")
        self.refuse(b"#!/bin/sh\necho no\n", "not_macho")
        self.refuse(macho_thin(APP_UUID)[:40], "macho_load_commands_out_of_bounds")
        self.refuse(b"\xcf\xfa", "macho_truncated")

    def test_a_symlinked_binary_is_not_followed(self):
        w = self.world()
        exe = os.path.join(w.temp, "dd-mac-ui-%s" % SHARD, "Build", "Products", "Debug", "Relayium.app",
                           "Contents", "MacOS", "Relayium")
        os.remove(exe)
        target = os.path.join(self.tmp, "elsewhere")
        with open(target, "wb") as f:
            f.write(macho_thin(APP_UUID))
        os.symlink(target, exe)
        base = H.Base(w.temp, "--runner-temp")
        try:
            app = [b for b in H.built_images(base, SHARD) if b["role"] == "app_main"][0]
        finally:
            base.close()
        self.assertEqual((app["present"], app["uuid"], app["error"]), (False, None, "symlink"))


# ── refusals, one cause each ───────────────────────────────────────────────


class Refusals(Case):
    def test_malformed_header(self):
        w = self.world()
        w.report(b"not json\n" + ips().split(b"\n", 1)[1])
        self.refused_one(w, "malformed_header")

    def test_header_not_an_object(self):
        w = self.world()
        w.report(b"[1, 2]\n" + ips().split(b"\n", 1)[1])
        self.refused_one(w, "malformed_header")

    def test_malformed_body(self):
        w = self.world()
        w.report(ips().split(b"\n", 1)[0] + b"\n{\"pid\": 9374,")
        self.refused_one(w, "malformed_body")

    def test_a_single_object_is_not_a_report(self):
        w = self.world()
        w.report(ips().split(b"\n", 1)[0])
        self.refused_one(w, "malformed_header")

    def test_trailing_garbage(self):
        w = self.world()
        w.report(ips() + b"\n{\"third\": 1}")
        self.refused_one(w, "trailing_garbage")

    def test_duplicate_keys(self):
        w = self.world()
        head, body = ips().split(b"\n", 1)
        w.report(head + b"\n" + body.replace(b"{", b"{\"pid\": 1, ", 1))
        self.refused_one(w, "malformed_body")

    def test_not_utf8(self):
        w = self.world()
        w.report(ips() + b"\xff")
        self.refused_one(w, "malformed_encoding")

    def test_wrong_bug_type(self):
        w = self.world()
        w.report(ips(header_extra={"bug_type": "288"}))
        self.refused_one(w, "wrong_bug_type")

    def test_wrong_bug_type_in_body(self):
        w = self.world()
        w.report(ips(body_extra={"bug_type": "211"}))
        self.refused_one(w, "wrong_bug_type")

    def test_wrong_bundle_in_header(self):
        w = self.world()
        w.report(ips(header_extra={"bundleID": "com.example.other"}))
        self.refused_one(w, "wrong_bundle")

    def test_wrong_bundle_in_body(self):
        w = self.world()
        w.report(ips(body_extra={"bundleInfo": {"CFBundleIdentifier": "com.example.other"}}))
        self.refused_one(w, "wrong_bundle")

    def test_no_bundle_at_all(self):
        w = self.world()
        w.report(ips(drop_header=("bundleID",), drop_body=("bundleInfo",)))
        self.refused_one(w, "wrong_bundle")

    def test_wrong_process_name(self):
        w = self.world()
        w.report(ips(header_extra={"name": "Finder"}))
        self.refused_one(w, "wrong_process_name")

    def test_header_time_unparseable(self):
        w = self.world()
        w.report(ips(header_extra={"timestamp": "yesterday"}))
        self.refused_one(w, "header_time_unparseable")

    def test_header_time_before_marker(self):
        w = self.world()
        w.report(ips(when=T0 - 3600 * SECOND))
        self.refused_one(w, "header_time_before_marker")

    def test_file_older_than_marker(self):
        w = self.world()
        w.report(ips(), mtime_ns=T0 - SECOND)
        self.refused_one(w, "older_than_marker")

    def test_malformed_pid(self):
        w = self.world()
        w.report(ips(pid="9374"))
        self.refused_one(w, "malformed_pid")

    def test_symlinked_report(self):
        w = self.world()
        target = os.path.join(self.tmp, "real.ips")
        World.write(target, ips(), T0 + 26 * SECOND)
        os.symlink(target, os.path.join(w.reports, REPORT))
        self.refused_one(w, "symlink_file")

    def test_nonregular_report(self):
        w = self.world()
        os.mkfifo(os.path.join(w.reports, REPORT))
        os.utime(os.path.join(w.reports, REPORT), ns=(T0 + SECOND, T0 + SECOND))
        self.refused_one(w, "nonregular")

    def test_oversize_report_is_not_read(self):
        w = self.world()
        w.report(ips() + b" " * H.MAX_REPORT_BYTES)
        m = self.refused_one(w, "oversize")
        self.assertEqual(m["reports"], [])

    def test_unstable_report(self):
        w = self.world()
        path = w.report(ips())
        original = H._read_all

        def growing(fd, size):
            data = original(fd, size)
            with open(path, "ab") as f:
                f.write(b" ")
            return data

        H._read_all = growing
        try:
            self.refused_one(w, "unstable")
        finally:
            H._read_all = original

    def test_symlinked_retired_directory_is_not_followed(self):
        w = self.world()
        shutil.rmtree(w.retired)
        elsewhere = os.path.join(self.tmp, "elsewhere")
        os.makedirs(elsewhere)
        World.write(os.path.join(elsewhere, REPORT), ips(), T0 + 26 * SECOND)
        os.symlink(elsewhere, w.retired)
        status, m = w.capture()
        self.assertEqual(status, 0)
        self.assertEqual(m["reports"], [])
        self.assertEqual({d["label"]: d["status"] for d in m["source_dirs"]},
                         {"DiagnosticReports": "ok", "Retired": "symlink"})
        self.assertEqual(m["status"], "no_report")

    def test_symlinked_reports_directory_is_not_followed(self):
        w = self.world()
        shutil.rmtree(w.reports)
        elsewhere = os.path.join(self.tmp, "elsewhere")
        os.makedirs(os.path.join(elsewhere, "Retired"))
        World.write(os.path.join(elsewhere, REPORT), ips(), T0 + 26 * SECOND)
        os.symlink(elsewhere, w.reports)
        _, m = w.capture()
        self.assertEqual(m["reports"], [])
        self.assertEqual(m["source_dirs"][0]["status"], "symlink")
        self.assertEqual(m["source_dirs"][1]["status"], "symlink")

    def test_names_outside_the_allowlist_and_nested_reports_are_not_read(self):
        w = self.world()
        for name in ("RelayiumShare-2026-10-02-224143.ips", "Relayium-2026-10-02-224143.ips.bak",
                     "relayium-2026-10-02-224143.ips", "Relayium-2026-10-02-2241.ips", "Finder-2026-10-02-224143.ips"):
            w.report(ips(), name=name)
        nested = os.path.join(w.reports, "nested")
        os.makedirs(nested)
        w.report(ips(), where=nested)
        status, m = w.capture()
        self.assertEqual(status, 0)
        self.assertEqual((m["reports"], m["refused"], m["status"]), ([], [], "no_report"))
        # Five names, the `nested` directory and `Retired` itself: counted, never read.
        self.assertEqual(m["ignored_non_matching_names"], 7)

    def test_count_cap_refuses_the_ninth_newest_report(self):
        w = self.world()
        for k in range(H.MAX_CANDIDATES + 1):
            w.report(ips(), name="Relayium-2026-10-02-2241%02d.ips" % (20 + k), mtime_ns=T0 + (10 + k) * SECOND)
        status, m = w.capture()
        self.assertEqual(status, 0)
        self.assertEqual(len(m["reports"]), H.MAX_CANDIDATES)
        self.assertEqual([(r["source_name"], r["reason"]) for r in m["refused"]],
                         [("Relayium-2026-10-02-224128.ips", "count_cap")])

    def test_total_cap_refuses_what_would_exceed_it(self):
        w = self.world()
        big = ips() + b" " * (H.MAX_REPORT_BYTES - len(ips()) - 16)
        for k in range(5):
            w.report(big, name="Relayium-2026-10-02-2241%02d.ips" % (20 + k), mtime_ns=T0 + (10 + k) * SECOND)
        _, m = w.capture()
        self.assertEqual(len(m["reports"]), 4)
        self.assertEqual([(r["source_name"], r["reason"]) for r in m["refused"]],
                         [("Relayium-2026-10-02-224124.ips", "total_cap")])
        self.assertLessEqual(sum(r["size"] for r in m["reports"]), H.MAX_TOTAL_BYTES)


# ── the marker, the arguments and where it may write ───────────────────────


class MarkerAndOutput(Case):
    def test_no_marker_writes_a_manifest_that_says_so(self):
        w = self.world(marker=False)
        w.report(ips())
        status, m = w.capture()
        self.assertEqual((status, m["status"], m["reports"]), (3, "marker_missing", []))
        with open(w.out(H.MANIFEST_NAME)) as f:
            self.assertEqual(json.load(f)["status"], "marker_missing")
        self.assertFalse(os.path.exists(w.out(H.REPORTS_SUBDIR)))

    def test_a_marker_for_another_shard_is_refused(self):
        w = self.world(marker=False)
        H.mark(w.temp, SHA, RUN_ID, ATTEMPT, "app-shell", now_ns=lambda: T0)
        w.report(ips())
        status, m = w.capture()
        self.assertEqual((status, m["status"]), (3, "marker_binding_mismatch"))

    def test_a_marker_for_another_run_attempt_or_commit_is_refused(self):
        for sha, run_id, attempt in ((SHA, RUN_ID, "2"), ("0" * 40, RUN_ID, ATTEMPT), (SHA, "37072256452", ATTEMPT)):
            w = World(os.path.join(self.tmp, "w-%s-%s-%s" % (sha[:4], run_id, attempt)), marker=False)
            H.mark(w.temp, sha, run_id, attempt, SHARD, now_ns=lambda: T0)
            status, m = w.capture()
            self.assertEqual(m["status"], "marker_binding_mismatch")

    def test_a_symlinked_marker_is_refused(self):
        w = self.world(marker=False)
        os.mkdir(os.path.join(w.temp, H.DIAG_DIR), 0o700)
        H.mark(w.base, SHA, RUN_ID, ATTEMPT, SHARD, now_ns=lambda: T0)  # a genuine marker, elsewhere
        os.symlink(os.path.join(w.base, H.DIAG_DIR, H.MARKER_NAME), os.path.join(w.temp, H.DIAG_DIR, H.MARKER_NAME))
        _, m = w.capture()
        self.assertEqual(m["status"], "marker_not_regular")

    def test_a_malformed_marker_is_refused(self):
        w = self.world(marker=False)
        os.mkdir(os.path.join(w.temp, H.DIAG_DIR), 0o700)
        with open(os.path.join(w.temp, H.DIAG_DIR, H.MARKER_NAME), "w") as f:
            f.write('{"schema": "%s"}' % H.SCHEMA_MARKER)
        _, m = w.capture()
        self.assertEqual(m["status"], "marker_malformed")

    def test_the_marker_is_written_once(self):
        w = self.world()
        with self.assertRaises(FileExistsError):
            H.mark(w.temp, SHA, RUN_ID, ATTEMPT, SHARD)

    def test_identity_arguments_cannot_escape_the_runner_temp_directory(self):
        w = self.world()
        for sha, run_id, attempt, shard in (
                (SHA, RUN_ID, ATTEMPT, "../escape"), (SHA, RUN_ID, ATTEMPT, "a/b"), (SHA, RUN_ID, ATTEMPT, ".."),
                ("../" + SHA[3:], RUN_ID, ATTEMPT, SHARD), (SHA, RUN_ID, "1/..", SHARD), (SHA, RUN_ID, "0", SHARD),
                (SHA.upper(), RUN_ID, ATTEMPT, SHARD), (SHA, "0", ATTEMPT, SHARD), (SHA, "-1", ATTEMPT, SHARD),
                (SHA, "True", ATTEMPT, SHARD), (SHA, "1e9", ATTEMPT, SHARD), (SHA, "../1", ATTEMPT, SHARD)):
            with self.assertRaises(H.UsageError):
                H.capture(w.temp, w.home, sha, run_id, attempt, shard)
            with self.assertRaises(H.UsageError):
                H.mark(w.temp, sha, run_id, attempt, shard)
        self.assertFalse(os.path.exists(os.path.join(w.base, "escape")))
        self.assertFalse(os.path.exists(w.out()))

    def test_a_pre_existing_capture_path_is_never_written_through(self):
        w = self.world()
        w.report(ips())
        elsewhere = os.path.join(self.tmp, "elsewhere")
        os.makedirs(elsewhere)
        os.symlink(elsewhere, w.out())
        with self.assertRaises(FileExistsError):
            w.capture()
        self.assertEqual(os.listdir(elsewhere), [])

    def test_a_symlinked_diagnostics_directory_is_refused(self):
        w = self.world(marker=False)
        elsewhere = os.path.join(self.tmp, "elsewhere")
        os.makedirs(elsewhere)
        os.symlink(elsewhere, os.path.join(w.temp, H.DIAG_DIR))
        with self.assertRaises(H.UsageError):
            w.capture()
        self.assertEqual(os.listdir(elsewhere), [])

    def test_relative_paths_and_poll_bounds_are_refused(self):
        w = self.world()
        with self.assertRaises(H.UsageError):
            H.capture("relative", w.home, SHA, RUN_ID, ATTEMPT, SHARD)
        with self.assertRaises(H.UsageError):
            H.capture(w.temp, w.home, SHA, RUN_ID, ATTEMPT, SHARD, poll_seconds=61)
        with self.assertRaises(H.UsageError):
            H.capture(w.temp, w.home, SHA, RUN_ID, ATTEMPT, SHARD, poll_seconds=0, settle_seconds=6)


# ── polling: finite, quiet when found, honest when nothing came ────────────


class FakeClock:
    def __init__(self):
        self.now = 1000.0
        self.sleeps = []
        self.on_sleep = []

    def clock(self):
        return self.now

    def sleep(self, seconds):
        self.sleeps.append(seconds)
        self.now += seconds
        for hook in list(self.on_sleep):
            hook(self.now)


class Polling(Case):
    def test_no_report_stops_at_sixty_seconds_and_says_so(self):
        w = self.world()
        c = FakeClock()
        started = time.monotonic()
        status, m = w.capture(poll_seconds=60, settle_seconds=5, clock=c.clock, sleep=c.sleep)
        self.assertLess(time.monotonic() - started, 10)
        self.assertEqual((status, m["status"]), (0, "no_report"))
        self.assertLessEqual(sum(c.sleeps), 60)
        self.assertTrue(all(s <= 1.0 for s in c.sleeps))
        self.assertEqual(m["poll"]["settle_rescans"], 0)
        self.assertEqual(m["poll"]["scans"], 61)
        self.assertLessEqual(m["timing"]["elapsed_seconds"], 60)
        self.assertEqual(m["timing"]["overrun_seconds"], 0)

    def test_a_report_present_at_once_stops_polling_after_one_settle(self):
        w = self.world()
        w.report(ips())
        c = FakeClock()
        _, m = w.capture(poll_seconds=60, settle_seconds=5, clock=c.clock, sleep=c.sleep)
        self.assertEqual(c.sleeps, [5])
        self.assertEqual((m["poll"]["scans"], m["poll"]["settle_rescans"]), (2, 1))

    def test_a_report_that_arrives_during_the_settle_is_kept(self):
        w = self.world()
        w.report(ips())
        c = FakeClock()
        b_name = "Relayium-2026-10-02-224150.ips"
        c.on_sleep.append(lambda now: os.path.exists(os.path.join(w.reports, b_name))
                          or w.report(ips(), name=b_name, mtime_ns=T0 + 33 * SECOND))
        _, m = w.capture(poll_seconds=60, settle_seconds=5, clock=c.clock, sleep=c.sleep)
        self.assertEqual(sorted(r["source_name"] for r in m["reports"]), [REPORT, b_name])

    def test_a_report_that_arrives_after_the_settle_is_not_waited_for(self):
        w = self.world()
        w.report(ips())
        c = FakeClock()
        _, m = w.capture(poll_seconds=60, settle_seconds=5, clock=c.clock, sleep=c.sleep)
        w.report(ips(), name="Relayium-2026-10-02-224150.ips", mtime_ns=T0 + 33 * SECOND)
        self.assertEqual([r["source_name"] for r in m["reports"]], [REPORT])
        self.assertEqual(m["poll"]["settle_rescans"], 1)

    def test_a_report_that_arrives_while_polling_is_found_then_settled(self):
        w = self.world()
        c = FakeClock()
        start = c.now
        c.on_sleep.append(lambda now: now - start >= 10 and not os.path.exists(os.path.join(w.reports, REPORT))
                          and w.report(ips()))
        _, m = w.capture(poll_seconds=60, settle_seconds=5, clock=c.clock, sleep=c.sleep)
        self.assertEqual(m["status"], "captured")
        self.assertEqual(c.sleeps, [1.0] * 10 + [5])
        self.assertEqual(m["poll"]["scans"], 12)


# ── races at every boundary: nothing outside the allowed directories is read ─


class Interpose:
    """Run `action` once, at an exact boundary inside the real helper: just
    after `os.lstat` of a name, or just before `os.open` of a name."""

    def __init__(self, case, when, name, action):
        self.fired = False
        real = getattr(os, when)

        def hooked(path, *args, **kwargs):
            base = os.path.basename(path) if isinstance(path, str) else None
            if when == "open" and not self.fired and base == name:
                self.fired = True
                action()
                return real(path, *args, **kwargs)
            result = real(path, *args, **kwargs)
            if when == "lstat" and not self.fired and base == name:
                self.fired = True
                action()
            return result

        setattr(os, when, hooked)
        case.addCleanup(setattr, os, when, real)


class ReadSpy:
    """Every (device, inode) whose bytes the helper read."""

    def __init__(self, case):
        self.read = []
        real = H._read_all

        def spy(fd, size):
            st = os.fstat(fd)
            self.read.append((st.st_dev, st.st_ino))
            return real(fd, size)

        H._read_all = spy
        case.addCleanup(setattr, H, "_read_all", real)


class Races(Case):
    def outside(self):
        """A valid, fresh report outside the allowed home, and its identity."""
        root = os.path.join(self.tmp, "outside")
        os.makedirs(os.path.join(root, "Retired"))
        path = os.path.join(root, REPORT)
        World.write(path, ips(), T0 + 26 * SECOND)
        st = os.stat(path)
        return root, path, (st.st_dev, st.st_ino), snapshot(root)

    def assert_nothing_outside(self, m, spy, ident, root, before):
        self.assertEqual(m["reports"], [], m)
        self.assertNotIn(ident, spy.read, "bytes outside the allowed directories were read")
        self.assertEqual(snapshot(root), before)

    def test_reports_directory_swapped_for_a_link_between_lstat_and_open(self):
        w = self.world()
        root, _, ident, before = self.outside()
        spy = ReadSpy(self)

        def swap():
            os.rename(w.reports, w.reports + "-original")
            os.symlink(root, w.reports)

        hook = Interpose(self, "open", "DiagnosticReports", swap)
        status, m = w.capture()
        self.assertTrue(hook.fired)
        self.assertEqual(status, 0)
        self.assert_nothing_outside(m, spy, ident, root, before)
        self.assertEqual([d["status"] for d in m["source_dirs"]], ["replaced", "symlink"])

    def test_reports_directory_swapped_for_another_real_directory_between_lstat_and_open(self):
        w = self.world()
        root, _, ident, before = self.outside()
        spy = ReadSpy(self)
        moved = os.path.join(self.tmp, "moved-in")

        def swap():
            os.rename(w.reports, w.reports + "-original")
            shutil.copytree(root, moved)
            os.rename(moved, w.reports)

        Interpose(self, "open", "DiagnosticReports", swap)
        _, m = w.capture()
        self.assertEqual(m["reports"], [])
        self.assertEqual(m["source_dirs"][0]["status"], "replaced")
        moved_ident = os.stat(os.path.join(w.reports, REPORT))
        self.assertNotIn((moved_ident.st_dev, moved_ident.st_ino), spy.read)
        self.assertEqual(snapshot(root), before)
        self.assertNotIn(ident, spy.read)

    def test_reports_directory_swapped_right_after_its_lstat(self):
        w = self.world()
        root, _, ident, before = self.outside()
        spy = ReadSpy(self)

        def swap():
            os.rename(w.reports, w.reports + "-original")
            os.symlink(root, w.reports)

        hook = Interpose(self, "lstat", "DiagnosticReports", swap)
        _, m = w.capture()
        self.assertTrue(hook.fired)
        self.assert_nothing_outside(m, spy, ident, root, before)

    def test_an_ancestor_swapped_right_after_its_lstat(self):
        w = self.world()
        root, _, ident, before = self.outside()
        logs = os.path.join(self.tmp, "outside-logs")
        os.makedirs(logs)
        os.symlink(root, os.path.join(logs, "DiagnosticReports"))
        real_logs = os.path.dirname(w.reports)
        spy = ReadSpy(self)

        def swap():
            os.rename(real_logs, real_logs + "-original")
            os.symlink(logs, real_logs)

        hook = Interpose(self, "lstat", "Logs", swap)
        _, m = w.capture()
        self.assertTrue(hook.fired)
        self.assert_nothing_outside(m, spy, ident, root, before)
        # Swapped at the first walk's open; the `Retired` walk then meets the link itself.
        self.assertEqual([d["status"] for d in m["source_dirs"]], ["replaced", "symlink"])

    def test_an_ancestor_renamed_away_while_a_report_is_being_read_fails_closed(self):
        w = self.world()
        w.report(ips())
        library = os.path.join(w.home, "Library")

        def move():
            os.rename(library, os.path.join(self.tmp, "Library-moved"))
            os.makedirs(os.path.join(library, "Logs", "DiagnosticReports", "Retired"))

        hook = Interpose(self, "open", REPORT, move)
        _, m = w.capture()
        self.assertTrue(hook.fired)
        self.assertEqual(m["reports"], [])
        self.assertEqual([r["reason"] for r in m["refused"]], ["source_dir_replaced"])

    def test_a_report_swapped_for_a_link_between_lstat_and_open(self):
        w = self.world()
        root, outside_path, ident, before = self.outside()
        path = w.report(ips())
        spy = ReadSpy(self)

        def swap():
            os.remove(path)
            os.symlink(outside_path, path)

        Interpose(self, "open", REPORT, swap)
        _, m = w.capture()
        self.assert_nothing_outside(m, spy, ident, root, before)
        self.assertEqual([r["reason"] for r in m["refused"]], ["unstable"])

    def test_a_report_replaced_by_another_file_between_lstat_and_open(self):
        w = self.world()
        path = w.report(ips())
        replacement = os.path.join(self.tmp, "replacement.ips")
        spy = ReadSpy(self)

        def swap():
            World.write(replacement, ips(pid=1), T0 + 26 * SECOND)
            os.replace(replacement, path)

        Interpose(self, "open", REPORT, swap)
        _, m = w.capture()
        self.assertEqual(m["reports"], [])
        self.assertEqual([r["reason"] for r in m["refused"]], ["unstable"])
        self.assertEqual(spy.read, [])

    def test_the_output_directory_cannot_be_redirected_after_it_is_bound(self):
        w = self.world()
        w.report(ips())
        diag = os.path.join(w.temp, H.DIAG_DIR)
        elsewhere = os.path.join(self.tmp, "elsewhere")
        os.makedirs(os.path.join(elsewhere, H.CAPTURE_DIR))

        def redirect():
            os.rename(diag, diag + "-moved")
            os.symlink(elsewhere, diag)

        hook = Interpose(self, "lstat", "Library", redirect)
        with self.assertRaises(H.Escape):
            w.capture()
        self.assertTrue(hook.fired)
        self.assertEqual(os.listdir(os.path.join(elsewhere, H.CAPTURE_DIR)), [])
        self.assertEqual(os.listdir(os.path.join(diag + "-moved", H.CAPTURE_DIR)), [])

    def test_the_output_directory_cannot_be_redirected_after_it_is_bound_even_with_no_report(self):
        w = self.world()
        diag = os.path.join(w.temp, H.DIAG_DIR)
        elsewhere = os.path.join(self.tmp, "elsewhere")
        os.makedirs(os.path.join(elsewhere, H.CAPTURE_DIR))

        def redirect():
            os.rename(diag, diag + "-moved")
            os.symlink(elsewhere, diag)

        Interpose(self, "lstat", "Library", redirect)
        with self.assertRaises(H.Escape):
            w.capture()
        self.assertEqual(os.listdir(os.path.join(elsewhere, H.CAPTURE_DIR)), [])
        self.assertEqual(os.listdir(os.path.join(diag + "-moved", H.CAPTURE_DIR)), [])

    def test_a_pre_existing_diagnostics_link_is_never_written_through_by_mark(self):
        w = self.world(marker=False)
        elsewhere = os.path.join(self.tmp, "elsewhere")
        os.makedirs(elsewhere)
        os.symlink(elsewhere, os.path.join(w.temp, H.DIAG_DIR))
        with self.assertRaises(FileExistsError):
            H.mark(w.temp, SHA, RUN_ID, ATTEMPT, SHARD)
        self.assertEqual(os.listdir(elsewhere), [])

    def test_a_built_binary_directory_swapped_after_its_lstat_gives_no_uuid(self):
        w = self.world()
        w.report(ips())
        macos = os.path.join(w.temp, "dd-mac-ui-%s" % SHARD, "Build", "Products", "Debug", "Relayium.app",
                             "Contents", "MacOS")
        decoy = os.path.join(self.tmp, "decoy")
        os.makedirs(decoy)
        World.write(os.path.join(decoy, "Relayium"), macho_thin(APP_UUID))

        def swap():
            os.rename(macos, macos + "-original")
            os.symlink(decoy, macos)

        Interpose(self, "lstat", "MacOS", swap)
        _, m = w.capture()
        app = [b for b in m["built_images"] if b["role"] == "app_main"][0]
        self.assertEqual((app["uuid"], app["error"]), (None, "replaced"))
        self.assertEqual(m["reports"][0]["uuid_provenance"], "unknown")

    def test_the_trusted_base_may_sit_behind_a_system_alias(self):
        w = self.world()
        w.report(ips())
        alias = os.path.join(self.tmp, "alias")
        os.symlink(w.base, alias)
        status, m = H.capture(os.path.join(alias, "runner-temp"), os.path.join(alias, "home"), SHA, RUN_ID,
                              ATTEMPT, SHARD, poll_seconds=0, settle_seconds=0)
        self.assertEqual((status, m["status"]), (0, "captured"))


class CandidateBinding(Case):
    """B1: what is read is the file the scan chose, within the caps, or nothing."""

    def replace_before_read(self, data):
        path = os.path.join(self.w.reports, REPORT)
        real = H.read_stable

        def swap_then_read(*a, **k):
            repl = os.path.join(self.tmp, "repl.ips")
            World.write(repl, data, T0 + 26 * SECOND)
            os.replace(repl, path)
            return real(*a, **k)

        H.read_stable = swap_then_read
        self.addCleanup(setattr, H, "read_stable", real)

    def test_a_report_replaced_after_the_scan_by_an_oversized_one_is_refused_unread(self):
        self.w = self.world()
        self.w.report(ips())
        big = ips() + b" " * (2100152 - len(ips()))
        self.replace_before_read(big)
        spy = ReadSpy(self)
        m = self.refused_one(self.w, "changed_since_scan")
        self.assertEqual(spy.read, [])
        self.assertEqual(os.path.getsize(os.path.join(self.w.reports, REPORT)), 2100152)
        self.assertEqual(m["reports"], [])

    def test_a_report_replaced_after_the_scan_by_one_that_would_fit_is_still_refused(self):
        self.w = self.world()
        self.w.report(ips())
        self.replace_before_read(ips(pid=1))
        spy = ReadSpy(self)
        self.refused_one(self.w, "changed_since_scan")
        self.assertEqual(spy.read, [])

    def test_a_report_that_grows_between_lstat_and_open_is_refused_before_reading(self):
        w = self.world()
        path = w.report(ips())
        spy = ReadSpy(self)

        def grow():
            with open(path, "ab") as f:
                f.write(b" " * H.MAX_REPORT_BYTES)

        Interpose(self, "open", REPORT, grow)
        self.refused_one(w, "unstable")
        self.assertEqual(spy.read, [])

    def test_the_opened_size_is_checked_against_the_remaining_limit_before_reading(self):
        w = self.world()
        path = w.report(ips())
        st = os.lstat(path)
        fd = os.open(w.reports, os.O_RDONLY | os.O_DIRECTORY)
        self.addCleanup(os.close, fd)
        with self.assertRaises(H.Refusal) as ctx:
            H.open_file_in(fd, REPORT, expect=st, limit=st.st_size - 1)
        self.assertEqual(ctx.exception.reason, "oversize")
        got, _ = H.open_file_in(fd, REPORT, expect=st, limit=st.st_size)
        os.close(got)


class OutputBinding(Case):
    """B2: every output write lands in the owned directory or nowhere."""

    def test_reports_directory_moved_after_its_open_before_the_first_write(self):
        w = self.world()
        w.report(ips())
        outside = os.path.join(self.tmp, "outside-output")
        real_open = os.open
        fired = []

        def hooked(path, flags, *a, **k):
            fd = real_open(path, flags, *a, **k)
            if not fired and path == H.REPORTS_SUBDIR and flags & os.O_DIRECTORY and k.get("dir_fd") is not None:
                fired.append(1)
                os.rename(w.out(H.REPORTS_SUBDIR), outside)
            return fd

        os.open = hooked
        self.addCleanup(setattr, os, "open", real_open)
        sources = snapshot(w.home)
        with self.assertRaises(H.Escape):
            w.capture()
        self.assertTrue(fired)
        self.assertEqual(os.listdir(outside), [])
        self.assertFalse(os.path.exists(w.out(H.MANIFEST_NAME)))
        self.assertEqual(snapshot(w.home), sources)

    def test_reports_directory_replaced_after_mkdir_before_its_open(self):
        w = self.world()
        w.report(ips())
        outside = os.path.join(self.tmp, "outside-output")

        def replace():
            os.rename(w.out(H.REPORTS_SUBDIR), outside)
            os.mkdir(w.out(H.REPORTS_SUBDIR), 0o700)

        hook = Interpose(self, "open", H.REPORTS_SUBDIR, replace)
        with self.assertRaises((H.Escape, H.UsageError)):
            w.capture()
        self.assertTrue(hook.fired)
        self.assertEqual(os.listdir(outside), [])
        self.assertEqual(os.listdir(w.out(H.REPORTS_SUBDIR)), [])
        self.assertFalse(os.path.exists(w.out(H.MANIFEST_NAME)))

    def spies(self):
        """Every os.write (bytes, and whether it came after the fixture's move)
        and every os.unlink the helper makes."""
        self.moved = False
        self.writes = []
        self.unlinks = []
        real_write, real_unlink = os.write, os.unlink

        def write(fd, data):
            n = real_write(fd, data)
            self.writes.append((n, self.moved))
            return n

        def unlink(path, *a, **k):
            self.unlinks.append(path)
            return real_unlink(path, *a, **k)

        os.write, os.unlink = write, unlink
        self.addCleanup(setattr, os, "write", real_write)
        self.addCleanup(setattr, os, "unlink", real_unlink)

    def after_open_of(self, name, action):
        """Run `action` once, right AFTER the helper's os.open of `name` succeeds."""
        real_open = os.open
        fired = []

        def hooked(path, flags, *a, **k):
            fd = real_open(path, flags, *a, **k)
            if not fired and path == name:
                fired.append(1)
                action()
                self.moved = True
            return fd

        os.open = hooked
        self.addCleanup(setattr, os, "open", real_open)
        return fired

    def bytes_after_move(self):
        return sum(n for n, after in self.writes if after)

    def test_reports_directory_moved_after_the_report_file_opened_before_its_first_write(self):
        w = self.world()
        w.report(ips())
        outside = os.path.join(self.tmp, "outside-output")
        self.spies()
        fired = self.after_open_of("DiagnosticReports__" + REPORT,
                                   lambda: os.rename(w.out(H.REPORTS_SUBDIR), outside))
        with self.assertRaises(H.Escape):
            w.capture()
        self.assertTrue(fired)
        self.assertEqual(self.bytes_after_move(), 0, "bytes were written after the move")
        self.assertEqual(self.unlinks, [])
        # The helper's own just-created file went with the directory, empty; it is left, not deleted.
        self.assertEqual(os.path.getsize(os.path.join(outside, "DiagnosticReports__" + REPORT)), 0)
        self.assertFalse(os.path.exists(w.out(H.MANIFEST_NAME)))

    def test_reports_directory_moved_between_two_chunks(self):
        w = self.world()
        w.report(ips())
        outside = os.path.join(self.tmp, "outside-output")
        self.addCleanup(setattr, H, "WRITE_CHUNK", H.WRITE_CHUNK)
        H.WRITE_CHUNK = 256
        self.spies()
        real_write = os.write

        def write_then_move(fd, data):
            n = real_write(fd, data)
            if not self.moved and os.fstat(fd).st_size == 256 and os.path.isdir(w.out(H.REPORTS_SUBDIR)):
                os.rename(w.out(H.REPORTS_SUBDIR), outside)
                self.moved = True
            return n

        os.write = write_then_move
        with self.assertRaises(H.Escape):
            w.capture()
        self.assertTrue(self.moved)
        self.assertEqual(self.bytes_after_move(), 0)
        self.assertEqual(self.unlinks, [])
        self.assertEqual(os.path.getsize(os.path.join(outside, "DiagnosticReports__" + REPORT)), 256)

    def test_reports_directory_moved_between_two_report_writes(self):
        w = self.world()
        w.report(ips())
        second = "Relayium-2026-10-02-224150.ips"
        w.report(ips(), name=second, mtime_ns=T0 + 33 * SECOND)
        outside = os.path.join(self.tmp, "outside-output")
        self.spies()
        fired = self.after_open_of("DiagnosticReports__" + second,
                                   lambda: os.rename(w.out(H.REPORTS_SUBDIR), outside))
        with self.assertRaises(H.Escape):
            w.capture()
        self.assertTrue(fired)
        self.assertEqual(self.bytes_after_move(), 0)
        self.assertEqual(self.unlinks, [])
        # The first report was complete before the move; the second is the helper's own empty file.
        self.assertEqual(os.path.getsize(os.path.join(outside, "DiagnosticReports__" + REPORT)), len(ips()))
        self.assertEqual(os.path.getsize(os.path.join(outside, "DiagnosticReports__" + second)), 0)

    def test_an_unowned_replacement_of_the_report_name_is_never_deleted(self):
        w = self.world()
        w.report(ips())
        stored = "DiagnosticReports__" + REPORT
        fake = b"not written by the helper"
        self.spies()

        def swap():
            os.rename(w.out(H.REPORTS_SUBDIR, stored), w.out(H.REPORTS_SUBDIR, "own-created-report-preserved"))
            World.write(w.out(H.REPORTS_SUBDIR, stored), fake)

        fired = self.after_open_of(stored, swap)
        with self.assertRaises(H.Escape):
            w.capture()
        self.assertTrue(fired)
        self.assertEqual(self.unlinks, [])
        self.assertEqual(self.bytes_after_move(), 0)
        with open(w.out(H.REPORTS_SUBDIR, stored), "rb") as f:
            self.assertEqual(f.read(), fake)
        self.assertEqual(os.path.getsize(w.out(H.REPORTS_SUBDIR, "own-created-report-preserved")), 0)

    def test_a_just_created_directory_that_is_not_empty_is_not_adopted(self):
        w = self.world()
        w.report(ips())
        real_mkdir = os.mkdir

        def mkdir(path, *a, **k):
            real_mkdir(path, *a, **k)
            if path == H.CAPTURE_DIR:
                World.write(os.path.join(w.out(), "planted"), b"x")

        os.mkdir = mkdir
        self.addCleanup(setattr, os, "mkdir", real_mkdir)
        with self.assertRaises(H.UsageError):
            w.capture()
        self.assertEqual(os.listdir(w.out()), ["planted"])

    def test_the_diagnostics_directory_replaced_before_marks_open_gets_no_marker(self):
        w = self.world(marker=False)
        diag = os.path.join(w.temp, H.DIAG_DIR)
        outside = os.path.join(self.tmp, "outside-diag")

        def replace():
            os.rename(diag, outside)
            os.mkdir(diag, 0o700)

        hook = Interpose(self, "open", H.DIAG_DIR, replace)
        with self.assertRaises(H.UsageError):
            H.mark(w.temp, SHA, RUN_ID, ATTEMPT, SHARD)
        self.assertTrue(hook.fired)
        self.assertEqual(os.listdir(outside), [])
        self.assertEqual(os.listdir(diag), [])


# ── one deadline, and bounded listing ──────────────────────────────────────


class Budget(Case):
    def slow_reads(self, clock, seconds):
        real = H._read_all
        self.reads = 0

        def slow(fd, size):
            self.reads += 1
            clock.now += seconds
            return real(fd, size)

        H._read_all = slow
        self.addCleanup(setattr, H, "_read_all", real)

    def test_a_read_that_finishes_after_the_deadline_is_not_used_and_the_overrun_is_recorded(self):
        w = self.world()
        w.report(ips())
        w.report(ips(), name="Relayium-2026-10-02-224150.ips", mtime_ns=T0 + 33 * SECOND)
        c = FakeClock()
        self.slow_reads(c, 70)
        status, m = w.capture(poll_seconds=60, settle_seconds=5, clock=c.clock, sleep=c.sleep)
        self.assertEqual((status, m["status"], m["reports"]), (0, "refused_only", []))
        # The first read finished late (refused), the second was never started.
        self.assertEqual([r["reason"] for r in m["refused"]], ["deadline", "deadline"])
        self.assertEqual(self.reads, 1)
        self.assertEqual(m["scan"], {"complete": False, "stopped": "deadline"})
        self.assertEqual((m["poll"]["scans"], m["poll"]["settle_rescans"]), (1, 0))
        self.assertEqual(c.sleeps, [])
        # Measured, never clamped: the fake read jumped 70 s past a 65 s budget.
        self.assertEqual((m["timing"]["elapsed_seconds"], m["timing"]["overrun_seconds"]), (70.0, 5.0))

    def test_parsing_is_charged_to_the_deadline(self):
        w = self.world()
        w.report(ips())
        c = FakeClock()
        real = H.evaluate

        def slow(*a, **k):
            c.now += 70
            return real(*a, **k)

        H.evaluate = slow
        self.addCleanup(setattr, H, "evaluate", real)
        _, m = w.capture(poll_seconds=60, settle_seconds=5, clock=c.clock, sleep=c.sleep)
        self.assertEqual((m["status"], m["reports"]), ("refused_only", []))
        self.assertEqual([r["reason"] for r in m["refused"]], ["deadline"])

    def test_preparation_is_charged_to_the_same_deadline(self):
        w = self.world()
        w.report(ips())
        c = FakeClock()
        real = H.macho_arm64_uuid_fd

        def slow(fd):
            c.now += 70
            return real(fd)

        H.macho_arm64_uuid_fd = slow
        self.addCleanup(setattr, H, "macho_arm64_uuid_fd", real)
        _, m = w.capture(poll_seconds=60, settle_seconds=5, clock=c.clock, sleep=c.sleep)
        self.assertEqual([b["error"] for b in m["built_images"]], ["deadline", "deadline", "deadline"])
        self.assertEqual([b["uuid"] for b in m["built_images"]], [None, None, None])
        self.assertEqual(m["reports"], [])
        self.assertEqual(m["scan"], {"complete": False, "stopped": "deadline"})
        self.assertEqual(c.sleeps, [])
        self.assertEqual(m["timing"]["overrun_seconds"], 5.0)

    def test_the_settle_gets_only_what_is_left_of_the_one_deadline(self):
        w = self.world()
        c = FakeClock()
        start = c.now
        c.on_sleep.append(lambda now: now - start >= 55 and not os.path.exists(os.path.join(w.reports, REPORT))
                          and w.report(ips()))
        self.slow_reads(c, 4)
        _, m = w.capture(poll_seconds=60, settle_seconds=5, clock=c.clock, sleep=c.sleep)
        self.assertEqual(m["status"], "captured")
        # Found and read by 59 s; the work deadline is 62 s, so the settle gets 3 s and no rescan.
        self.assertEqual(c.sleeps[-1], 3.0)
        self.assertEqual((m["poll"]["settle_rescans"], m["poll"]["settle_skipped"]), (0, "budget_spent"))
        self.assertLessEqual(c.now - start, 62)
        self.assertEqual(m["timing"]["overrun_seconds"], 0)

    def test_a_late_find_still_settles_within_the_deadline(self):
        w = self.world()
        c = FakeClock()
        start = c.now
        c.on_sleep.append(lambda now: now - start >= 55 and not os.path.exists(os.path.join(w.reports, REPORT))
                          and w.report(ips()))
        _, m = w.capture(poll_seconds=60, settle_seconds=5, clock=c.clock, sleep=c.sleep)
        self.assertEqual((m["status"], m["poll"]["settle_rescans"]), ("captured", 1))
        self.assertLessEqual(c.now - start, 62)

    def test_the_watchdog_ends_a_blocking_operation_in_real_time(self):
        """Not a fake clock: a read that blocks for 30 s is ended by the alarm."""
        w = self.world()
        w.report(ips())
        real = H._read_all
        H._read_all = lambda fd, size: time.sleep(30)
        self.addCleanup(setattr, H, "_read_all", real)
        started = time.monotonic()
        with self.assertRaises(H.DeadlineExceeded):
            H.capture(w.temp, w.home, SHA, RUN_ID, ATTEMPT, SHARD, poll_seconds=0, settle_seconds=1, watchdog=True)
        elapsed = time.monotonic() - started
        self.assertLess(elapsed, 3)
        self.assertGreaterEqual(elapsed, 0.9)
        self.assertEqual(signal.getitimer(signal.ITIMER_REAL), (0.0, 0.0))
        self.assertEqual(signal.getsignal(signal.SIGALRM), signal.SIG_DFL)
        self.assertFalse(os.path.exists(w.out(H.MANIFEST_NAME)), "no manifest after the watchdog")

    def test_listing_stops_at_the_entry_cap_and_says_the_count_is_a_lower_bound(self):
        w = self.world()
        for k in range(20):
            w.report(b"x", name="note-%02d.txt" % k)
        self.addCleanup(setattr, H, "MAX_DIR_ENTRIES", H.MAX_DIR_ENTRIES)
        H.MAX_DIR_ENTRIES = 10
        _, m = w.capture()
        self.assertEqual(m["scan"], {"complete": False, "stopped": "entry_cap"})
        self.assertEqual(m["ignored_non_matching_names_at_least"], 10)
        self.assertNotIn("ignored_non_matching_names", m)
        self.assertEqual(m["source_dirs"][1]["status"], "not_scanned")

    def test_collection_stops_at_the_candidate_cap(self):
        w = self.world()
        for k in range(5):
            w.report(ips(), name="Relayium-2026-10-02-2241%02d.ips" % (20 + k), mtime_ns=T0 + (10 + k) * SECOND)
        self.addCleanup(setattr, H, "MAX_FRESH_CANDIDATES", H.MAX_FRESH_CANDIDATES)
        H.MAX_FRESH_CANDIDATES = 3
        _, m = w.capture()
        self.assertEqual(m["scan"], {"complete": False, "stopped": "candidate_cap"})
        self.assertEqual(len(m["reports"]), 3)

    def test_recorded_refusals_are_bounded_and_the_rest_counted(self):
        w = self.world()
        for k in range(4):
            w.report(ips(), name="Relayium-2026-10-02-2240%02d.ips" % k, mtime_ns=T0 - (k + 1) * SECOND)
        self.addCleanup(setattr, H, "MAX_RECORDED_REFUSALS", H.MAX_RECORDED_REFUSALS)
        H.MAX_RECORDED_REFUSALS = 2
        _, m = w.capture()
        self.assertEqual((len(m["refused"]), m["refused_omitted"], m["status"]), (2, 2, "refused_only"))


class RunBinding(Case):
    def test_the_marker_and_manifest_carry_the_run_id(self):
        w = self.world()
        with open(os.path.join(w.temp, H.DIAG_DIR, H.MARKER_NAME)) as f:
            self.assertEqual(json.load(f)["run_id"], int(RUN_ID))
        w.report(ips())
        _, m = w.capture()
        self.assertEqual(m["run_id"], int(RUN_ID))

    def test_a_boolean_or_zero_run_id_in_the_marker_is_malformed(self):
        for bad in (True, 0, "37072256451"):
            w = World(os.path.join(self.tmp, "w-%r" % (bad,)), marker=False)
            os.mkdir(os.path.join(w.temp, H.DIAG_DIR), 0o700)
            body = {"schema": H.SCHEMA_MARKER, "github_sha": SHA, "run_id": bad, "run_attempt": 1,
                    "shard": SHARD, "marker_epoch_ns": T0, "marker_utc": "x"}
            with open(os.path.join(w.temp, H.DIAG_DIR, H.MARKER_NAME), "w") as f:
                json.dump(body, f)
            _, m = w.capture()
            self.assertEqual(m["status"], "marker_malformed", bad)


# ── the real process ───────────────────────────────────────────────────────


class Process(Case):
    def run_helper(self, *args, timeout=30):
        started = time.monotonic()
        done = subprocess.run([sys.executable, "-B", HELPER_PATH] + list(args), stdout=subprocess.PIPE,
                              stderr=subprocess.PIPE, timeout=timeout, universal_newlines=True)
        return done, time.monotonic() - started

    def test_the_command_line_is_finite_and_honest_with_no_report(self):
        w = self.world()
        done, elapsed = self.run_helper("capture", "--runner-temp", w.temp, "--home", w.home, "--head", SHA, "--run-id", RUN_ID,
                                        "--attempt", ATTEMPT, "--shard", SHARD, "--poll-seconds", "2")
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertLess(elapsed, 15)
        self.assertIn("crash diagnostics: no_report, 0 report(s) kept, 0 refused", done.stdout)

    def test_bad_arguments_exit_two_and_write_nothing(self):
        w = self.world()
        done, _ = self.run_helper("capture", "--runner-temp", w.temp, "--home", w.home, "--head", "nothex", "--run-id", RUN_ID,
                                  "--attempt", ATTEMPT, "--shard", SHARD)
        self.assertEqual(done.returncode, 2)
        self.assertFalse(os.path.exists(w.out()))
        done, _ = self.run_helper("capture", "--runner-temp", w.temp, "--home", w.home, "--head", SHA, "--run-id", RUN_ID,
                                  "--attempt", ATTEMPT, "--shard", SHARD, "--poll-seconds", "600")
        self.assertEqual(done.returncode, 2)

    def test_a_second_capture_refuses_the_existing_output(self):
        w = self.world()
        w.capture()
        done, _ = self.run_helper("capture", "--runner-temp", w.temp, "--home", w.home, "--head", SHA, "--run-id", RUN_ID,
                                  "--attempt", ATTEMPT, "--shard", SHARD, "--poll-seconds", "0")
        self.assertEqual(done.returncode, 4)


# ── the workflow wiring ────────────────────────────────────────────────────

# The `ui-smoke` job and its original steps, frozen as their bytes at
# c681ce602c6936d5250b68552d973bd9b5e6aa5c (the adopted `macos.yml`). The
# diagnostics steps are added AROUND them; none of these may change with them.
FROZEN_JOB_WITHOUT_DIAGNOSTICS = "ce6db9d902c1914716afae447aa57716ba8d6a4fb10b7c9c00d95c1186db2ad5"
FROZEN_STEPS = {
    "Import UI signing certificate": "82c7c02f28f3b7954b3fe18d324be7e195ab300e3e522963d20a5f67cef88cba",
    "Install UI provisioning profiles": "ef8faeae887afa1318ab56b97afc364abcb82421426c62c1402189bdd3f4b27c",
    "Run macOS product-flow UI smoke (${{ matrix.shard }})": "f611f742c8eef8748d7dcc5cb2b78f859ccc7910233a58bf3d6a560003154f0a",
    "Upload macOS UI smoke result evidence": "df3fc8e35c60d8901dee14963e49f9d26c60aaec1a963efa5c01ac75cf222d6b",
    "Remove UI signing keychain": "870c8d59e0c57c5a33a72a0b6579eec3c599f4352b468bb026d63f193aedcee4",
    "Certify this job's toolchain": "263b9a770eb6dba64b929da9b7e911116806e22a86c132f6f48970d4a1092ee6",
    "Keep this job's toolchain certificate": "12f666ae909252e2d7d864bff988af54d0c2534447c454ab0a6618a92d02d289",
}
MARK_STEP = "Mark the UI smoke start for crash diagnostics"
CAPTURE_STEP = "Capture crash reports after a failed UI smoke"
UPLOAD_STEP = "Upload crash diagnostics after a failed UI smoke"
FULL = "needs.evidence.outputs.reuse != 'true'"
FAILED = "always() && %s && (contains(fromJSON('[\"failure\",\"cancelled\"]'), steps.ui_smoke.outcome))" % FULL
UPLOAD_PIN = "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7.0.1"
ENV = {"CRASH_DIAG_SHA": "${{ github.sha }}", "CRASH_DIAG_RUN_ID": "${{ github.run_id }}",
       "CRASH_DIAG_ATTEMPT": "${{ github.run_attempt }}", "CRASH_DIAG_SHARD": "${{ matrix.shard }}"}
MARK_RUN = ('/usr/bin/python3 scripts/ci/macos-ui-crash-diagnostics.py mark --runner-temp "$RUNNER_TEMP" '
            '--head "$CRASH_DIAG_SHA" --run-id "$CRASH_DIAG_RUN_ID" --attempt "$CRASH_DIAG_ATTEMPT" '
            '--shard "$CRASH_DIAG_SHARD"')
CAPTURE_RUN = ('/usr/bin/python3 scripts/ci/macos-ui-crash-diagnostics.py capture --runner-temp "$RUNNER_TEMP" '
               '--home "$HOME" --head "$CRASH_DIAG_SHA" --run-id "$CRASH_DIAG_RUN_ID" '
               '--attempt "$CRASH_DIAG_ATTEMPT" --shard "$CRASH_DIAG_SHARD"')
TEST_RUN = "python3 scripts/test/macos-ui-crash-diagnostics-test.py"


def job_block(lines, job):
    start = lines.index("  %s:" % job)
    end = next((i for i in range(start + 1, len(lines)) if re.match(r"^  [A-Za-z0-9_-]+:\s*$", lines[i])), len(lines))
    return lines[start:end]


def steps_of(job):
    """The steps of one job: name, line range (blank lines inside a step kept,
    trailing ones not) and the comment lines directly above it."""
    out = []
    at = job.index("    steps:") + 1
    pending = []
    current = None
    for i in range(at, len(job)):
        line = job[i]
        if line.startswith("      #"):
            pending.append(i)
        elif line.startswith("      - "):
            if current:
                out.append(current)
            current = {"start": i, "end": i + 1, "comments": pending}
            pending = []
        elif line.strip() == "":
            continue
        elif current is not None and line.startswith("        "):
            current["end"] = i + 1
        else:
            break
    if current:
        out.append(current)
    for step in out:
        step["lines"] = job[step["start"]:step["end"]]
        named = [l for l in step["lines"] if l.startswith("      - name: ") or l.startswith("        name: ")]
        step["name"] = named[0].split("name: ", 1)[1] if named else step["lines"][0][len("      - "):]
    return out


def step_keys(step):
    keys = {}
    current = None
    for line in step["lines"]:
        body = line[len("      - "):] if line.startswith("      - ") else line
        m = re.match(r"^ {8}([A-Za-z0-9_-]+):(?: (.*))?$", "        " + body if line.startswith("      - ") else line)
        if m:
            current = m.group(1)
            keys[current] = m.group(2) if m.group(2) is not None else {}
            continue
        m = re.match(r"^ {10}([A-Za-z0-9_-]+): (.*)$", line)
        if m and isinstance(keys.get(current), dict):
            keys[current][m.group(1)] = m.group(2)
    return keys


def step_bytes(job, step):
    return "\n".join(job[step["start"]:step["end"]])


def without_diagnostics(job):
    """The job with the three diagnostics steps and their comments removed."""
    steps = {s["name"]: s for s in steps_of(job)}
    drop = set()
    for name in (MARK_STEP, CAPTURE_STEP, UPLOAD_STEP):
        s = steps[name]
        drop.update(s["comments"])
        drop.update(range(s["start"], s["end"]))
    return [l for i, l in enumerate(job) if i not in drop]


class Workflow(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        with open(MACOS_YML) as f:
            cls.text = f.read()
        cls.lines = cls.text.split("\n")
        cls.job = job_block(cls.lines, "ui-smoke")
        cls.steps = steps_of(cls.job)
        cls.by_name = {s["name"]: s for s in cls.steps}
        cls.order = [s["name"] for s in cls.steps]

    def test_every_original_step_and_the_rest_of_the_job_are_byte_unchanged(self):
        for name, digest in FROZEN_STEPS.items():
            self.assertIn(name, self.by_name, name)
            got = hashlib.sha256(step_bytes(self.job, self.by_name[name]).encode()).hexdigest()
            self.assertEqual(got, digest, "%s changed" % name)
        got = hashlib.sha256("\n".join(without_diagnostics(self.job)).encode()).hexdigest()
        self.assertEqual(got, FROZEN_JOB_WITHOUT_DIAGNOSTICS, "the ui-smoke job changed outside the diagnostics steps")

    def test_the_marker_is_immediately_before_the_smoke_step(self):
        smoke = self.order.index("Run macOS product-flow UI smoke (${{ matrix.shard }})")
        self.assertEqual(self.order[smoke - 1], MARK_STEP)
        keys = step_keys(self.by_name[MARK_STEP])
        self.assertEqual(keys.get("if"), FULL)
        self.assertEqual(keys.get("continue-on-error"), "true")
        self.assertEqual(keys.get("timeout-minutes"), "1")
        self.assertEqual(keys.get("env"), ENV)
        self.assertEqual(keys.get("run"), MARK_RUN)
        self.assertNotIn("id", keys)

    def test_capture_and_upload_follow_the_keychain_cleanup_only_after_a_failed_smoke(self):
        cleanup = self.order.index("Remove UI signing keychain")
        self.assertEqual(self.order[cleanup + 1:cleanup + 3], [CAPTURE_STEP, UPLOAD_STEP])
        self.assertEqual(self.order[cleanup + 3], "Certify this job's toolchain")
        capture = step_keys(self.by_name[CAPTURE_STEP])
        upload = step_keys(self.by_name[UPLOAD_STEP])
        for keys in (capture, upload):
            self.assertEqual(keys.get("if"), FAILED)
            self.assertEqual(keys.get("continue-on-error"), "true")
            self.assertTrue(keys.get("timeout-minutes", "").isdigit())
            self.assertLessEqual(int(keys["timeout-minutes"]), 2)
        self.assertEqual(capture.get("env"), ENV)
        self.assertEqual(capture.get("run"), CAPTURE_RUN)
        self.assertNotIn("--poll-seconds", capture["run"])
        self.assertNotIn("--settle-seconds", capture["run"])
        self.assertEqual(upload.get("uses"), UPLOAD_PIN)
        self.assertEqual(upload.get("with"), {
            "name": "relayium-macos-crash-diagnostics-${{ matrix.shard }}-${{ github.sha }}-attempt-${{ github.run_attempt }}",
            "path": "${{ runner.temp }}/macos-crash-diagnostics/capture",
            "if-no-files-found": "ignore",
            "retention-days": "7"})

    def test_the_helper_selects_this_lane(self):
        on = self.text.split("\njobs:\n", 1)[0]
        self.assertIn("\n      - 'scripts/ci/macos-ui-crash-diagnostics.py'\n", on)

    def test_this_suite_runs_unconditionally_in_repository_policy(self):
        with open(HYGIENE_YML) as f:
            lines = f.read().split("\n")
        self.assertFalse(any(re.match(r"^ {4}paths(-ignore)?:", l) for l in lines[:lines.index("jobs:")]))
        job = job_block(lines, "repository-policy")
        self.assertFalse(any(re.match(r"^    if:", l) for l in job))
        runs = [s for s in steps_of(job) if step_keys(s).get("run") == TEST_RUN]
        self.assertEqual(len(runs), 1)
        keys = step_keys(runs[0])
        self.assertNotIn("if", keys)
        self.assertNotIn("continue-on-error", keys)
        self.assertTrue(keys.get("timeout-minutes", "").isdigit())
        job_timeout = int([l for l in job if l.startswith("    timeout-minutes:")][0].split(":")[1])
        self.assertLessEqual(int(keys["timeout-minutes"]), job_timeout)

    def test_the_extracted_steps_run_as_written(self):
        """The marker and capture commands, exactly as the workflow writes them,
        run in a fixture world; only `/usr/bin/python3` becomes this interpreter."""
        tmp = tempfile.mkdtemp(prefix="mucd-wf-")
        self.addCleanup(shutil.rmtree, tmp, True)
        w = World(tmp, marker=False)
        env = dict(os.environ, RUNNER_TEMP=w.temp, HOME=w.home, CRASH_DIAG_SHA=SHA, CRASH_DIAG_RUN_ID=RUN_ID, CRASH_DIAG_ATTEMPT=ATTEMPT,
                   CRASH_DIAG_SHARD=SHARD, PYTHONDONTWRITEBYTECODE="1")

        def run(name):
            command = step_keys(self.by_name[name])["run"]
            self.assertTrue(command.startswith("/usr/bin/python3 "))
            command = command.replace("/usr/bin/python3", '"%s"' % sys.executable, 1)
            return subprocess.run(["bash", "-c", command], cwd=ROOT, env=env, stdout=subprocess.PIPE,
                                  stderr=subprocess.PIPE, timeout=90, universal_newlines=True)

        done = run(MARK_STEP)
        self.assertEqual(done.returncode, 0, done.stderr)
        time.sleep(0.05)
        now = time.time_ns()
        w.report(ips(when=now + SECOND), mtime_ns=now + SECOND)
        started = time.monotonic()
        done = run(CAPTURE_STEP)
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertLess(time.monotonic() - started, 30)
        with open(w.out(H.MANIFEST_NAME)) as f:
            m = json.load(f)
        self.assertEqual((m["status"], m["shard"], m["run_attempt"], m["github_sha"]), ("captured", SHARD, 1, SHA))
        self.assertEqual(m["run_id"], int(RUN_ID))
        self.assertEqual(m["reports"][0]["uuid_provenance"], "match")
        self.assertEqual(m["poll"]["settle_rescans"], 1)


def main():
    for attr in ("O_NOFOLLOW", "O_DIRECTORY", "pread"):
        if not hasattr(os, attr):
            print("macos-ui-crash-diagnostics-test: os.%s is unavailable here" % attr, file=sys.stderr)
            return 1
    if sys.version_info < (3, 9):
        print("macos-ui-crash-diagnostics-test: needs Python 3.9+", file=sys.stderr)
        return 1
    stream = io.StringIO()
    suite = unittest.defaultTestLoader.loadTestsFromModule(sys.modules[__name__])
    result = unittest.TextTestRunner(stream=stream, verbosity=2).run(suite)
    sys.stdout.write(stream.getvalue())
    if not result.wasSuccessful() or result.testsRun == 0:
        print("macos-ui-crash-diagnostics-test: FAILED (%d run, %d failures, %d errors)"
              % (result.testsRun, len(result.failures), len(result.errors)))
        return 1
    print("macos-ui-crash-diagnostics-test: OK (%d cases, Python %s)" % (result.testsRun, sys.version.split()[0]))
    return 0


if __name__ == "__main__":
    sys.exit(main())

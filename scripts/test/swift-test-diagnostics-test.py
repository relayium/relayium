#!/usr/bin/env python3
"""Fixture tests for scripts/ci/swift-test-diagnostics.py.

Pure fixtures: no build, no test bundle executed, no real crash report read. The
fixed `/usr/bin/dwarfdump` is replaced, in-process only, by a small fixture
script; everything else runs the real helper code, including its command-line
entry point and its SIGALRM watchdog. Python 3.9 standard library only, and
runs on Linux (repo-hygiene) as well as macOS.
"""

import datetime
import importlib.util
import json
import os
import shutil
import stat
import subprocess
import sys
import tempfile
import time
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
HELPER = os.path.normpath(os.path.join(HERE, "..", "ci", "swift-test-diagnostics.py"))

spec = importlib.util.spec_from_file_location("swift_test_diagnostics", HELPER)
diag = importlib.util.module_from_spec(spec)
spec.loader.exec_module(diag)

HEAD = "3ce8c93934361a9580e8479731bdbb75733beb9d"
RUN = "37175317336"
ATTEMPT = "1"
BUNDLE_UUID = "0a1b2c3d-4e5f-4061-8293-a4b5c6d7e8f9"
OTHER_UUID = "ffffffff-0000-4000-8000-000000000000"
EXE_REL = os.path.join("apps", "RelayiumKit", ".build", "arm64-apple-macosx", "debug",
                       "RelayiumKitPackageTests.xctest", "Contents", "MacOS", "RelayiumKitPackageTests")


def ips_time(epoch, digits=4):
    scaled = int(round(epoch * 10 ** digits))
    whole, frac = divmod(scaled, 10 ** digits)
    dt = datetime.datetime.fromtimestamp(whole, datetime.timezone.utc)
    return dt.strftime("%Y-%m-%d %H:%M:%S") + "." + str(frac).zfill(digits) + " +0000"


def ips_bytes(capture_epoch, proc="xctest", uuid=BUNDLE_UUID, bug_type="309", home="/Users/runner"):
    # The header is the write time: ReportCrash writes it after the crash it records.
    header = {"app_name": proc, "timestamp": ips_time(capture_epoch + 0.3, 2), "bug_type": bug_type,
              "os_version": "macOS 15.7.9 (24G999)", "incident_id": "0000", "name": proc}
    body = {
        "procName": proc, "pid": 4242, "parentProc": "swift-test", "parentPid": 4000,
        "procPath": home + "/work/relayium/.build/xctest", "userID": 501,
        "captureTime": ips_time(capture_epoch),
        "exception": {"type": "EXC_BAD_ACCESS", "signal": "SIGSEGV", "subtype": "KERN_INVALID_ADDRESS at 0x0",
                      "codes": "0x1, 0x0"},
        "termination": {"namespace": "SIGNAL", "code": 11, "indicator": "Segmentation fault: 11",
                        "byProc": "exc handler", "byPid": 4242},
        "faultingThread": 1,
        "asi": {"libsystem_c.dylib": ["SECRET_TOKEN=abc " + home]},
        "environment": {"SECRET_TOKEN": "abc"},
        "threads": [
            {"id": 1, "queue": "com.apple.main-thread", "threadState": {"x": [{"value": 1}]},
             "frames": [{"imageIndex": 0, "imageOffset": 10, "symbol": "main"}]},
            {"id": 2, "triggered": True, "threadState": {"x": [{"value": 99}], "pc": {"value": 7}},
             "frames": [{"imageIndex": 1, "imageOffset": 1234, "symbol": "XCTestRunner.crash()",
                         "symbolLocation": 8, "sourceFile": home + "/work/relayium/apps/X.swift", "sourceLine": 9},
                        {"imageIndex": 0, "imageOffset": 20}]},
        ],
        "usedImages": [
            {"uuid": "11111111-2222-4333-8444-555555555555", "name": "xctest", "path": "/usr/bin/xctest",
             "arch": "arm64", "base": 1},
            {"uuid": uuid.upper(), "name": "RelayiumKitPackageTests",
             "path": home + "/work/relayium/" + EXE_REL, "arch": "arm64", "base": 2},
        ],
    }
    return (json.dumps(header) + "\n" + json.dumps(body, indent=2)).encode()


class Fixture:
    """A checkout, a runner temp and a home directory, each private to one test."""

    def __init__(self):
        self.root = tempfile.mkdtemp(prefix="swift-diag-test-")
        self.repo = os.path.join(self.root, "repo")
        self.rt = os.path.join(self.root, "runner-temp")
        self.home = os.path.join(self.root, "home")
        self.reports = os.path.join(self.home, "Library", "Logs", "DiagnosticReports")
        os.makedirs(os.path.join(self.repo, ".git"))
        with open(os.path.join(self.repo, ".git", "HEAD"), "w") as f:
            f.write(HEAD + "\n")
        exe = os.path.join(self.repo, EXE_REL)
        os.makedirs(os.path.dirname(exe))
        with open(exe, "wb") as f:
            f.write(b"\xcf\xfa\xed\xfe fixture")
        os.makedirs(self.rt)
        os.makedirs(self.reports)
        self.fake_bin = os.path.join(self.root, "fake-dwarfdump")
        self.set_dwarfdump("UUID: %s (arm64) %s\n" % (BUNDLE_UUID.upper(), EXE_REL))

    def set_dwarfdump(self, stdout=None, script=None):
        with open(self.fake_bin, "w") as f:
            if script is not None:
                f.write("#!/bin/sh\n" + script)
            else:
                f.write("#!/bin/sh\ncat <<'EOF'\n%sEOF\n" % stdout)
        os.chmod(self.fake_bin, 0o755)

    def write_log(self, data=b"Test Suite 'All tests' started\nerror: Exited with unexpected signal code 11\n"):
        with open(os.path.join(self.rt, "swift-test.log"), "wb") as f:
            f.write(data)
        return data

    def write_report(self, name, data, subdir=None):
        d = self.reports if subdir is None else os.path.join(self.reports, subdir)
        os.makedirs(d, exist_ok=True)
        p = os.path.join(d, name)
        with open(p, "wb") as f:
            f.write(data)
        return p

    def write_mark(self, window_start, head=HEAD, run=RUN, attempt=ATTEMPT, checkout=HEAD, matches=True):
        d = os.path.join(self.rt, diag.DIAG_DIR)
        os.makedirs(d, mode=0o700, exist_ok=True)
        rec = {"schema": diag.SCHEMA_MARK, "window_start": window_start, "head": head,
               "run_id": run, "attempt": attempt, "checkout_head": checkout, "checkout_matches_head": matches}
        if matches is None:
            del rec["checkout_matches_head"]
        with open(os.path.join(d, diag.MARK_NAME), "w") as f:
            json.dump(rec, f)

    def write_finish(self, test_end, head=HEAD, run=RUN, attempt=ATTEMPT):
        d = os.path.join(self.rt, diag.DIAG_DIR)
        os.makedirs(d, mode=0o700, exist_ok=True)
        with open(os.path.join(d, diag.FINISH_NAME), "w") as f:
            json.dump({"schema": diag.SCHEMA_FINISH, "test_end": test_end, "head": head,
                       "run_id": run, "attempt": attempt}, f)

    def outside_files(self):
        """Every file under the fixture root that is NOT inside runner-temp, home, repo or the fake tool."""
        found = []
        for top in os.listdir(self.root):
            if top in ("runner-temp", "home", "repo", "fake-dwarfdump"):
                continue
            for dirpath, _, files in os.walk(os.path.join(self.root, top)):
                found += [os.path.join(dirpath, f) for f in files]
        return found

    def args(self, cmd="capture", head=HEAD, run=RUN, attempt=ATTEMPT):
        a = [cmd, "--runner-temp", self.rt, "--head", head, "--run-id", run, "--attempt", attempt]
        if cmd == "capture":
            a += ["--home", self.home]
        return a

    def summary(self):
        with open(os.path.join(self.rt, diag.DIAG_DIR, diag.CAPTURE_DIR, diag.SUMMARY_NAME)) as f:
            return json.load(f)

    def capture_files(self):
        return sorted(os.listdir(os.path.join(self.rt, diag.DIAG_DIR, diag.CAPTURE_DIR)))

    def cleanup(self):
        shutil.rmtree(self.root, ignore_errors=True)


class Base(unittest.TestCase):
    def setUp(self):
        self.fx = Fixture()
        self.cwd = os.getcwd()
        os.chdir(self.fx.repo)
        self.saved = {k: getattr(diag, k) for k in ("DWARFDUMP", "MAX_REPORT_BYTES", "MAX_DIR_ENTRIES",
                                                     "MAX_OUTPUT_BYTES", "_read_chunk", "VERSION_PROBES")}
        diag.DWARFDUMP = self.fx.fake_bin
        diag.VERSION_PROBES = (("swift", (sys.executable, "-c", "print('Swift version 6.1.2')")),)

    def tearDown(self):
        for k, v in self.saved.items():
            setattr(diag, k, v)
        os.chdir(self.cwd)
        self.fx.cleanup()

    def run_capture(self, budget=8.0, poll=0.2, args=None):
        t0 = time.monotonic()
        code = diag.main(args or self.fx.args(), budget_s=budget, poll_interval=poll)
        return code, time.monotonic() - t0

    def mark_now(self, offset=-5.0, end=None):
        """A mark 5 s ago and a test end now (or `end`); reports dated after `end` are not this test's."""
        start = time.time() + offset
        self.fx.write_mark(start)
        self.fx.write_finish(time.time() if end is None else end)
        return start


class MarkTests(Base):
    def test_mark_records_identity_window_head_and_toolchain(self):
        before = time.time()
        self.assertEqual(diag.main(self.fx.args("mark")), 0)
        with open(os.path.join(self.fx.rt, diag.DIAG_DIR, diag.MARK_NAME)) as f:
            m = json.load(f)
        self.assertEqual((m["schema"], m["head"], m["run_id"], m["attempt"]), (diag.SCHEMA_MARK, HEAD, RUN, ATTEMPT))
        self.assertGreaterEqual(m["window_start"], before - 1)
        self.assertEqual(m["checkout_head"], HEAD)
        self.assertTrue(m["checkout_matches_head"])
        self.assertEqual(m["toolchain"]["swift"]["status"], "ok")

    def test_mark_reports_a_checkout_that_is_not_the_run_head(self):
        other = "1" * 40
        self.assertEqual(diag.main(self.fx.args("mark", head=other)), 0)
        with open(os.path.join(self.fx.rt, diag.DIAG_DIR, diag.MARK_NAME)) as f:
            m = json.load(f)
        self.assertFalse(m["checkout_matches_head"])

    def test_mark_never_fails_the_job_when_it_cannot_write(self):
        os.chmod(self.fx.rt, 0o500)
        try:
            if os.access(self.fx.rt, os.W_OK):
                self.skipTest("running as a user that ignores directory permissions")
            self.assertEqual(diag.main(self.fx.args("mark")), 0)
        finally:
            os.chmod(self.fx.rt, 0o700)

    def test_mark_refuses_invalid_identity_with_a_usage_exit(self):
        self.assertEqual(diag.main(self.fx.args("mark", head="main")), 2)
        self.assertEqual(diag.main(self.fx.args("mark", attempt="1; rm")), 2)


class CaptureSelectionTests(Base):
    def test_a_report_bound_to_this_window_process_and_bundle_is_selected_and_sanitized(self):
        start = self.mark_now()
        log = self.fx.write_log()
        self.fx.write_report("xctest-2026-10-04-035852.ips", ips_bytes(time.time() - 1))
        code, _ = self.run_capture()
        self.assertEqual(code, 0)
        s = self.fx.summary()
        self.assertEqual(s["status"], "MATCHED")
        self.assertEqual(s["mark"]["status"], "ok")
        self.assertEqual(s["log_signals"], [11])
        self.assertEqual(s["log"]["status"], "copied")
        self.assertEqual(s["test_bundles"][0]["uuid"], BUNDLE_UUID)
        self.assertEqual(self.fx.capture_files(), ["report-1.json", "summary.json", "swift-test.log"])
        with open(os.path.join(self.fx.rt, diag.DIAG_DIR, diag.CAPTURE_DIR, "swift-test.log"), "rb") as f:
            self.assertEqual(f.read(), log)
        with open(os.path.join(self.fx.rt, diag.DIAG_DIR, diag.CAPTURE_DIR, "report-1.json")) as f:
            raw = f.read()
        rep = json.loads(raw)
        self.assertEqual(rep["exception"]["signal"], "SIGSEGV")
        self.assertEqual(rep["termination"]["code"], 11)
        self.assertEqual(rep["triggeredThread"]["index"], 1)
        self.assertEqual(rep["triggeredThread"]["frames"][0]["symbol"], "XCTestRunner.crash()")
        self.assertEqual(rep["triggeredThread"]["frames"][0]["sourceFile"], "X.swift")
        self.assertTrue(any(i["testBundle"] and i["uuid"] == BUNDLE_UUID for i in rep["images"]))
        for forbidden in ("threadState", "SECRET_TOKEN", "procPath", "\"environment\"", "/Users/runner",
                          "\"asi\"", "userID", "\"path\"", "\"base\"", "byPid", self.fx.home):
            self.assertNotIn(forbidden, raw)
        self.assertNotIn(self.fx.home, json.dumps(s))
        self.assertGreater(start, 0)

    def test_a_report_from_before_the_window_is_old(self):
        start = self.mark_now()
        self.fx.write_report("xctest-2026-10-04-035000.ips", ips_bytes(start - 60))
        self.run_capture(budget=2.0)
        s = self.fx.summary()
        self.assertEqual(s["status"], "UNAVAILABLE")
        self.assertIn("old", s["rejected_counts"])
        self.assertEqual(s["selected"], [])

    def test_a_file_older_than_the_window_is_never_read(self):
        start = self.mark_now()
        p = self.fx.write_report("xctest-2026-10-04-030000.ips", ips_bytes(time.time()))
        os.utime(p, (start - 3600, start - 3600))
        self.run_capture(budget=2.0)
        s = self.fx.summary()
        self.assertEqual(s["reports_read"], 0)
        self.assertEqual(s["rejected_counts"], {"old": 1})

    def test_a_matching_crash_after_the_recorded_test_end_is_never_selected(self):
        # R1 moved the window end to "now" on every poll, so a crash of the SAME bundle during the
        # diagnostics themselves was accepted. The window now ends at the recorded test end.
        self.mark_now(end=time.time() - 3)
        self.fx.write_report("xctest-2026-10-04-040000.ips", ips_bytes(time.time() - 1))
        self.run_capture(budget=2.0)
        s = self.fx.summary()
        self.assertEqual(s["status"], "UNAVAILABLE")
        self.assertEqual(s["rejected_counts"], {"after-test-end": 1})

    def test_a_header_written_in_the_future_is_inconsistent(self):
        self.mark_now()
        data = ips_bytes(time.time() - 1)
        hdr, rest = data.split(b"\n", 1)
        h = json.loads(hdr)
        h["timestamp"] = ips_time(time.time() + 3600, 2)
        self.fx.write_report("xctest-2026-10-04-035852.ips", json.dumps(h).encode() + b"\n" + rest)
        self.run_capture(budget=2.0)
        self.assertEqual(self.fx.summary()["rejected_counts"], {"inconsistent-header-time": 1})

    def test_another_bundles_uuid_is_a_mismatch(self):
        self.mark_now()
        self.fx.write_report("xctest-2026-10-04-035852.ips", ips_bytes(time.time() - 1, uuid=OTHER_UUID))
        self.run_capture(budget=2.0)
        s = self.fx.summary()
        self.assertEqual(s["status"], "UNAVAILABLE")
        self.assertIn("uuid-mismatch", s["rejected_counts"])

    def test_another_process_in_the_same_window_is_not_selected(self):
        self.mark_now()
        # Named like an XCTest runner but written by another process that loaded the bundle.
        self.fx.write_report("xctest-2026-10-04-035853.ips", ips_bytes(time.time() - 1, proc="lldb-rpc-server"))
        # Not a runner name at all: never read.
        self.fx.write_report("go-2026-10-04-035853.ips", ips_bytes(time.time() - 1, proc="go"))
        self.run_capture(budget=2.0)
        s = self.fx.summary()
        self.assertEqual(s["rejected_counts"], {"other-process": 1})
        self.assertEqual(s["reports_read"], 1)

    def test_no_bundle_uuid_means_nothing_can_be_bound(self):
        self.mark_now()
        self.fx.set_dwarfdump("no uuid here\n")
        self.fx.write_report("xctest-2026-10-04-035852.ips", ips_bytes(time.time() - 1))
        self.run_capture(budget=2.0)
        s = self.fx.summary()
        self.assertEqual(s["test_bundles"], [])
        self.assertEqual(s["status"], "UNAVAILABLE")
        self.assertIn("no-bundle-uuid", s["rejected_counts"])

    def test_no_reports_at_all_is_unavailable_not_a_cause(self):
        self.mark_now()
        code, took = self.run_capture(budget=3.0, poll=0.2)
        s = self.fx.summary()
        self.assertEqual(code, 0)
        self.assertEqual(s["status"], "UNAVAILABLE")
        self.assertIn("not a cause", s["reason"])
        self.assertLess(took, 3.0)
        self.assertEqual(self.fx.capture_files(), ["summary.json"])
        self.assertEqual(s["log"], {"status": "absent"})

    def test_a_report_in_retired_is_found_and_nothing_deeper(self):
        self.mark_now()
        self.fx.write_report("xctest-2026-10-04-035852.ips", ips_bytes(time.time() - 1), subdir="Retired")
        self.fx.write_report("xctest-2026-10-04-035853.ips", ips_bytes(time.time() - 1),
                             subdir=os.path.join("Retired", "deeper"))
        self.run_capture()
        s = self.fx.summary()
        self.assertEqual(s["status"], "MATCHED")
        self.assertEqual(s["reports_read"], 1)

    def test_a_report_appearing_while_polling_is_found(self):
        self.mark_now()
        calls = {"n": 0}
        real = diag.scan_reports

        def late(*a, **k):
            calls["n"] += 1
            if calls["n"] == 3:
                self.fx.write_report("xctest-2026-10-04-035852.ips", ips_bytes(time.time() - 0.5))
            return real(*a, **k)

        diag.scan_reports = late
        try:
            self.run_capture(budget=8.0, poll=0.1)
        finally:
            diag.scan_reports = real
        self.assertEqual(self.fx.summary()["status"], "MATCHED")


class CaptureFormatTests(Base):
    def test_truncated_report(self):
        self.mark_now()
        data = ips_bytes(time.time() - 1)
        self.fx.write_report("xctest-2026-10-04-035852.ips", data[: len(data) - 200])
        self.run_capture(budget=2.0)
        self.assertIn("truncated", self.fx.summary()["rejected_counts"])

    def test_header_only_report_is_truncated(self):
        self.mark_now()
        self.fx.write_report("xctest-2026-10-04-035852.ips", b'{"bug_type":"309"}')
        self.run_capture(budget=2.0)
        self.assertIn("truncated", self.fx.summary()["rejected_counts"])

    def test_malformed_two_json(self):
        self.mark_now()
        self.fx.write_report("xctest-2026-10-04-035852.ips", b'{"bug_type":"309"}\nnot json at all')
        self.fx.write_report("xctest-2026-10-04-035853.ips", b'[1,2]\n{"threads":[],"usedImages":[]}')
        self.fx.write_report("xctest-2026-10-04-035854.ips", b'\xff\xfe\n{}')
        self.run_capture(budget=2.0)
        self.assertEqual(self.fx.summary()["rejected_counts"], {"malformed": 3})

    def test_unsupported_bug_type_or_shape(self):
        self.mark_now()
        self.fx.write_report("xctest-2026-10-04-035852.ips", ips_bytes(time.time() - 1, bug_type="288"))
        self.fx.write_report("xctest-2026-10-04-035853.ips",
                             b'{"bug_type":"309"}\n{"threads":{},"usedImages":[]}')
        self.run_capture(budget=2.0)
        self.assertEqual(self.fx.summary()["rejected_counts"], {"unsupported-format": 2})

    def test_unparseable_capture_time(self):
        self.mark_now()
        data = ips_bytes(time.time() - 1).replace(b"+0000", b"UTC")
        self.fx.write_report("xctest-2026-10-04-035852.ips", data)
        self.run_capture(budget=2.0)
        self.assertIn("malformed", self.fx.summary()["rejected_counts"])

    def test_ips_time_offsets(self):
        self.assertEqual(diag.parse_ips_time("2026-10-04 03:58:52.00 +0000"),
                         datetime.datetime(2026, 10, 4, 3, 58, 52, tzinfo=datetime.timezone.utc).timestamp())
        self.assertEqual(diag.parse_ips_time("2026-10-04 07:58:52.5 +0400"),
                         datetime.datetime(2026, 10, 4, 3, 58, 52, tzinfo=datetime.timezone.utc).timestamp() + 0.5)
        self.assertIsNone(diag.parse_ips_time("2026-10-04T03:58:52Z"))


class CaptureBindingTests(Base):
    def _refused(self, **mark):
        start = time.time() - 5
        self.fx.write_mark(start, **mark)
        self.fx.write_finish(time.time())
        self.fx.write_report("xctest-2026-10-04-035852.ips", ips_bytes(time.time() - 1))
        code, _ = self.run_capture(budget=2.0)
        s = self.fx.summary()
        self.assertEqual(s["status"], "REFUSED-MARK")
        self.assertEqual(s["reports_read"], 0)
        self.assertEqual(s["selected"], [])
        return s["mark"]["status"]

    def test_wrong_source_head(self):
        self.assertEqual(self._refused(head="2" * 40), "wrong-head")

    def test_wrong_run(self):
        self.assertEqual(self._refused(run="1"), "wrong-run")

    def test_wrong_attempt(self):
        self.assertEqual(self._refused(attempt="2"), "wrong-attempt")

    def test_mark_that_saw_another_checkout_is_refused(self):
        self.assertEqual(self._refused(checkout="3" * 40, matches=False), "checkout-mismatch")

    def test_mark_claiming_a_match_for_another_checkout_is_refused(self):
        self.assertEqual(self._refused(checkout="3" * 40, matches=True), "checkout-mismatch")

    def test_mark_without_a_checkout_verdict_is_refused(self):
        self.assertEqual(self._refused(matches=None), "checkout-mismatch")

    def test_mark_with_a_non_boolean_checkout_verdict_is_refused(self):
        self.assertEqual(self._refused(matches="true"), "checkout-mismatch")

    def test_current_checkout_that_moved_is_refused(self):
        self.mark_now()
        with open(os.path.join(self.fx.repo, ".git", "HEAD"), "w") as f:
            f.write("4" * 40 + "\n")
        self.fx.write_report("xctest-2026-10-04-035852.ips", ips_bytes(time.time() - 1))
        self.run_capture(budget=2.0)
        s = self.fx.summary()
        self.assertEqual((s["status"], s["reports_read"]), ("REFUSED-CHECKOUT", 0))

    def test_missing_test_end_is_refused(self):
        self.fx.write_mark(time.time() - 5)
        self.fx.write_report("xctest-2026-10-04-035852.ips", ips_bytes(time.time() - 1))
        self.run_capture(budget=2.0)
        s = self.fx.summary()
        self.assertEqual((s["status"], s["finish"]["status"], s["reports_read"]), ("REFUSED-WINDOW", "absent", 0))

    def test_test_end_of_another_attempt_is_refused(self):
        self.fx.write_mark(time.time() - 5)
        self.fx.write_finish(time.time(), attempt="2")
        self.run_capture(budget=2.0)
        self.assertEqual(self.fx.summary()["finish"]["status"], "wrong-attempt")

    def test_test_end_before_the_mark_is_refused(self):
        self.fx.write_mark(time.time() - 5)
        self.fx.write_finish(time.time() - 50)
        self.run_capture(budget=2.0)
        self.assertEqual(self.fx.summary()["finish"]["status"], "malformed")

    def test_missing_mark_is_unavailable(self):
        self.fx.write_report("xctest-2026-10-04-035852.ips", ips_bytes(time.time() - 1))
        self.run_capture(budget=2.0)
        s = self.fx.summary()
        self.assertEqual((s["status"], s["mark"]["status"], s["reports_read"]), ("UNAVAILABLE", "absent", 0))

    def test_malformed_mark_is_refused(self):
        d = os.path.join(self.fx.rt, diag.DIAG_DIR)
        os.makedirs(d)
        with open(os.path.join(d, diag.MARK_NAME), "w") as f:
            f.write("{not json")
        self.run_capture(budget=2.0)
        self.assertEqual(self.fx.summary()["status"], "REFUSED-MARK")


class CaptureSafetyTests(Base):
    def test_symlinked_report_is_not_read(self):
        self.mark_now()
        target = os.path.join(self.fx.root, "elsewhere.ips")
        with open(target, "wb") as f:
            f.write(ips_bytes(time.time() - 1))
        os.symlink(target, os.path.join(self.fx.reports, "xctest-2026-10-04-035852.ips"))
        self.run_capture(budget=2.0)
        s = self.fx.summary()
        self.assertEqual(s["rejected_counts"], {"not-regular": 1})
        self.assertEqual(s["reports_read"], 0)

    def test_symlinked_report_directory_is_unsafe(self):
        self.mark_now()
        real = os.path.join(self.fx.root, "real-reports")
        os.makedirs(real)
        with open(os.path.join(real, "xctest-2026-10-04-035852.ips"), "wb") as f:
            f.write(ips_bytes(time.time() - 1))
        shutil.rmtree(self.fx.reports)
        os.symlink(real, self.fx.reports)
        self.run_capture(budget=2.0)
        s = self.fx.summary()
        self.assertTrue(s["report_dirs"][os.path.join("Library", "Logs", "DiagnosticReports")].startswith("unsafe"))
        self.assertEqual(s["reports_read"], 0)

    def test_symlinked_build_directory_yields_no_uuid(self):
        self.mark_now()
        build = os.path.join(self.fx.repo, "apps", "RelayiumKit", ".build")
        moved = os.path.join(self.fx.root, "build-elsewhere")
        shutil.move(build, moved)
        os.symlink(moved, build)
        self.run_capture(budget=2.0)
        s = self.fx.summary()
        self.assertEqual(s["test_bundles"], [])
        self.assertTrue(any(n.startswith("build-directory-unsafe") for n in s["test_bundle_notes"]))

    def test_symlinked_test_executable_is_skipped(self):
        self.mark_now()
        exe = os.path.join(self.fx.repo, EXE_REL)
        real = os.path.join(self.fx.root, "real-executable")
        os.rename(exe, real)
        os.symlink(real, exe)
        self.run_capture(budget=2.0)
        s = self.fx.summary()
        self.assertEqual(s["test_bundles"], [])
        self.assertIn("executable-not-regular", s["test_bundle_notes"])

    def test_report_replaced_during_read(self):
        self.mark_now()
        p = self.fx.write_report("xctest-2026-10-04-035852.ips", ips_bytes(time.time() - 1))
        real = diag._read_chunk
        swapped = {"done": False}

        def swap(fd, n):
            if not swapped["done"] and n > 1000:  # the report, not the small mark
                swapped["done"] = True
                other = p + ".new"
                with open(other, "wb") as f:
                    f.write(ips_bytes(time.time() - 1))
                os.rename(other, p)
            return real(fd, n)

        diag._read_chunk = swap
        self.run_capture(budget=2.0)
        self.assertIn("replaced", self.fx.summary()["rejected_counts"])

    def test_report_growing_during_read_is_unstable(self):
        self.mark_now()
        p = self.fx.write_report("xctest-2026-10-04-035852.ips", ips_bytes(time.time() - 1))
        real = diag._read_chunk

        def grow(fd, n):
            with open(p, "ab") as f:
                f.write(b" ")
            return real(fd, n)

        diag._read_chunk = grow
        self.run_capture(budget=3.0, poll=0.5)
        s = self.fx.summary()
        self.assertEqual(s["status"], "UNAVAILABLE")
        self.assertIn("unstable", s["rejected_counts"])

    def test_report_over_the_byte_cap_is_not_read(self):
        self.mark_now()
        diag.MAX_REPORT_BYTES = 1024
        self.fx.write_report("xctest-2026-10-04-035852.ips", ips_bytes(time.time() - 1))
        self.run_capture(budget=2.0)
        s = self.fx.summary()
        self.assertEqual(s["rejected_counts"], {"too-large": 1})
        self.assertEqual(s["reports_read"], 0)

    def test_directory_listing_is_bounded(self):
        self.mark_now()
        diag.MAX_DIR_ENTRIES = 3
        for i in range(6):
            self.fx.write_report("aaa-%d.txt" % i, b"x")
        self.run_capture(budget=3.0)
        dirs = self.fx.summary()["report_dirs"]
        self.assertEqual(dirs[os.path.join("Library", "Logs", "DiagnosticReports")], "incomplete")

    def test_read_hang_ends_at_the_watchdog_with_a_deadline_summary(self):
        self.mark_now()
        self.fx.write_report("xctest-2026-10-04-035852.ips", ips_bytes(time.time() - 1))

        def hang(fd, n):
            if n > 1000:  # the report, not the small mark
                time.sleep(30)
            return real(fd, n)

        real = diag._read_chunk

        diag._read_chunk = hang
        code, took = self.run_capture(budget=1.5, poll=0.1)
        self.assertEqual(code, 5)
        self.assertLess(took, 3.0)
        # At the deadline nothing more is written: no summary, so nothing is marked complete.
        self.assertEqual([f for f in self.fx.capture_files() if f.startswith("summary")], [])

    def test_budget_spent_while_polling_still_writes_the_summary(self):
        # R2 raised the watchdog's Deadline from the cooperative budget check, so a poll that woke
        # just under the write reserve lost the whole summary (intermittent large-log failure).
        self.mark_now()
        real = diag.scan_reports

        def spent(*a, **k):
            raise diag.BudgetSpent()

        diag.scan_reports = spent
        try:
            code, _ = self.run_capture(budget=3.0)
        finally:
            diag.scan_reports = real
        s = self.fx.summary()
        self.assertEqual((code, s["budget_spent"], s["status"]), (0, True, "UNAVAILABLE"))
        self.assertIn("summary.json", self.fx.capture_files())

    def test_hanging_dwarfdump_is_killed_at_its_timeout(self):
        self.mark_now()
        self.fx.set_dwarfdump(script="sleep 30\n")
        saved = diag.DWARFDUMP_TIMEOUT_S
        diag.DWARFDUMP_TIMEOUT_S = 0.5
        try:
            code, took = self.run_capture(budget=2.0, poll=0.2)
        finally:
            diag.DWARFDUMP_TIMEOUT_S = saved
        s = self.fx.summary()
        self.assertIn("dwarfdump-timeout", s["test_bundle_notes"])
        self.assertLess(took, 8.0)

    def test_tool_output_cap_bounds_what_is_read_and_kills_the_tool(self):
        # The tool records how much it managed to write. R1's communicate() drained all 32 MiB into
        # memory before slicing; the cap must stop the READ and kill the writer.
        counter = os.path.join(self.fx.root, "written")
        flood = ("import os,sys\nn=0\nb=b'x'*65536\n"
                 "for _ in range(512):\n os.write(1,b); n+=len(b)\n"
                 " open(%r,'w').write(str(n))\n" % counter)
        t0 = time.monotonic()
        res = diag.run_tool((sys.executable, "-c", flood), 20)
        self.assertLess(time.monotonic() - t0, 5)
        self.assertEqual(res["status"], "over-cap")
        self.assertLessEqual(res["bytes_read"], diag.TOOL_STDOUT_MAX + 4096)
        self.assertLessEqual(len(res["stdout"]), diag.TOOL_STDOUT_MAX)
        with open(counter) as f:
            self.assertLess(int(f.read() or 0), 4 * 1024 * 1024)
        self.assertIsNotNone(res["exit"])  # reaped

    def test_tool_that_keeps_running_after_output_is_killed_at_its_timeout(self):
        t0 = time.monotonic()
        res = diag.run_tool((sys.executable, "-c", "import time; print('UUID'); time.sleep(30)"), 0.5)
        self.assertEqual(res["status"], "timeout")
        self.assertLess(time.monotonic() - t0, 4)

    def test_output_file_limit(self):
        diag.MAX_OUTPUT_BYTES = 200
        d = os.path.join(self.fx.root, "out")
        os.makedirs(d)
        out = diag.open_outputs(self.fx.rt)
        try:
            out.write_json("big.json", {"schema": "s", "blob": "y" * 5000})
        finally:
            out.close()
        with open(os.path.join(self.fx.rt, diag.DIAG_DIR, "big.json")) as f:
            self.assertEqual(json.load(f)["status"], "OUTPUT-LIMIT")

    def test_large_log_keeps_its_tail_and_finds_a_signal_across_chunks(self):
        self.mark_now()
        saved = diag.MAX_LOG_BYTES
        diag.MAX_LOG_BYTES = 200000
        try:
            filler = b"x" * (diag.CHUNK - 10)
            data = b"head" * 50000 + filler + b"error: Exited with unexpected signal code 11\n"
            self.fx.write_log(data)
            self.run_capture(budget=3.0)
        finally:
            diag.MAX_LOG_BYTES = saved
        s = self.fx.summary()
        self.assertEqual(s["log"]["status"], "truncated-head")
        self.assertEqual(s["log"]["bytes"], 200000)
        self.assertEqual(s["log_signals"], [11])

    def test_existing_capture_directory_is_refused(self):
        self.mark_now()
        os.makedirs(os.path.join(self.fx.rt, diag.DIAG_DIR, diag.CAPTURE_DIR))
        self.assertEqual(diag.main(self.fx.args()), 3)

    def test_symlinked_diagnostics_directory_writes_nothing_outside(self):
        # R1 followed this link and wrote capture/summary.json outside runner-temp (root replay).
        outside = os.path.join(self.fx.root, "outside")
        os.makedirs(outside)
        os.symlink(outside, os.path.join(self.fx.rt, diag.DIAG_DIR))
        self.assertEqual(diag.main(self.fx.args(), budget_s=2.0), 4)
        self.assertEqual(diag.main(self.fx.args("mark")), 0)
        self.assertEqual(diag.main(self.fx.args("finish")), 0)
        self.assertEqual(self.fx.outside_files(), [])

    def test_symlinked_capture_directory_writes_nothing_outside(self):
        self.mark_now()
        outside = os.path.join(self.fx.root, "outside")
        os.makedirs(outside)
        os.symlink(outside, os.path.join(self.fx.rt, diag.DIAG_DIR, diag.CAPTURE_DIR))
        self.assertEqual(diag.main(self.fx.args(), budget_s=2.0), 3)
        self.assertEqual(self.fx.outside_files(), [])

    def test_mark_refuses_a_pre_existing_diagnostics_directory(self):
        os.makedirs(os.path.join(self.fx.rt, diag.DIAG_DIR))
        self.assertEqual(diag.main(self.fx.args("mark")), 0)
        self.assertFalse(os.path.exists(os.path.join(self.fx.rt, diag.DIAG_DIR, diag.MARK_NAME)))

    def test_a_foreign_writable_diagnostics_directory_is_refused(self):
        self.mark_now()
        os.chmod(os.path.join(self.fx.rt, diag.DIAG_DIR), 0o777)
        self.assertEqual(diag.main(self.fx.args(), budget_s=2.0), 4)
        self.assertFalse(os.path.exists(os.path.join(self.fx.rt, diag.DIAG_DIR, diag.CAPTURE_DIR)))

    def test_a_build_prefix_swapped_during_dwarfdump_cannot_bind_another_binary(self):
        # R1 handed dwarfdump a PATHNAME and re-checked only the bundle chain below `debug`; a swap of
        # `.build` around the tool made it read another binary. The tool now reads the opened fd.
        self.mark_now()
        build = os.path.join(self.fx.repo, "apps", "RelayiumKit", ".build")
        evil = os.path.join(self.fx.root, "evil-build")
        shutil.copytree(build, evil)
        with open(os.path.join(evil, os.path.relpath(os.path.join(self.fx.repo, EXE_REL), build)), "wb") as f:
            f.write(OTHER_UUID.encode())
        with open(os.path.join(self.fx.repo, EXE_REL), "wb") as f:
            f.write(BUNDLE_UUID.encode())
        hold = os.path.join(self.fx.root, "held-build")
        # The fake swaps the prefix, reads its argument, prints that content as the UUID, swaps back.
        self.fx.set_dwarfdump(script=(
            'mv "%s" "%s" && mv "%s" "%s"\n' % (build, hold, evil, build)
            + 'u=$(cat "$2")\n'
            + 'mv "%s" "%s" && mv "%s" "%s"\n' % (build, evil, hold, build)
            + 'echo "UUID: $u (arm64) $2"\n'))
        self.fx.write_report("xctest-2026-10-04-035852.ips", ips_bytes(time.time() - 1, uuid=OTHER_UUID))
        self.run_capture(budget=3.0)
        s = self.fx.summary()
        self.assertNotIn(OTHER_UUID, [u["uuid"] for u in s["test_bundles"]])
        self.assertNotEqual(s["status"], "MATCHED")


class OutputRaceTests(unittest.TestCase):
    """The exact open/write/lstat boundaries of an output file, interposed deterministically.

    A spy records every byte written per target inode, so a transient write that a later cleanup
    removed still counts, and a competing file's bytes are checked for identity, not mere presence.
    """

    def setUp(self):
        self.fx = Fixture()
        self.out = diag.open_outputs(self.fx.rt, diag.CAPTURE_DIR)
        self.cap = os.path.join(self.fx.rt, diag.DIAG_DIR, diag.CAPTURE_DIR)
        self.outside = os.path.join(self.fx.root, "outside")
        os.makedirs(self.outside, mode=0o700)
        self.writes = {}
        self.real = (os.open, os.write, os.lstat)

    def tearDown(self):
        diag.os.open, diag.os.write, diag.os.lstat = self.real
        os.open, os.write, os.lstat = self.real
        self.out.close()
        self.fx.cleanup()

    def spy_write(self, hook=None):
        real_write = self.real[1]

        def wr(fd, data):
            if hook:
                hook()
            n = real_write(fd, data)
            ino = os.fstat(fd).st_ino
            self.writes[ino] = self.writes.get(ino, 0) + n
            return n

        os.write = wr

    def test_ordinary_output_is_complete_read_only_and_listed(self):
        self.spy_write()
        n = self.out.write_bytes_new("summary.json", [b"ACTUAL-DIAGNOSTIC-BYTES"])
        os.write = self.real[1]
        p = os.path.join(self.cap, "summary.json")
        self.assertEqual((n, open(p, "rb").read()), (23, b"ACTUAL-DIAGNOSTIC-BYTES"))
        self.assertEqual(stat.S_IMODE(os.stat(p).st_mode), 0o400)
        self.assertEqual(self.out.written["summary.json"]["sha256"],
                         __import__("hashlib").sha256(b"ACTUAL-DIAGNOSTIC-BYTES").hexdigest())
        self.assertEqual(sorted(os.listdir(self.cap)), ["summary.json"])

    def test_capture_directory_moved_right_after_open_gets_no_byte(self):
        real_open = self.real[0]
        moved = os.path.join(self.outside, "capture")

        def op(path, flags, mode=0o777, *, dir_fd=None):
            fd = real_open(path, flags, mode, dir_fd=dir_fd)
            if path == "summary.json":
                os.rename(self.cap, moved)
            return fd

        os.open = op
        self.spy_write()
        with self.assertRaises(diag.Unsafe):
            self.out.write_bytes_new("summary.json", [b"ACTUAL-DIAGNOSTIC-BYTES"])
        os.open, os.write = self.real[0], self.real[1]
        self.assertEqual(sum(self.writes.values()), 0)  # not merely an empty directory afterwards
        self.assertEqual(os.path.getsize(os.path.join(moved, "summary.json")), 0)

    def test_name_replaced_before_a_write_is_not_written_and_not_deleted(self):
        p = os.path.join(self.cap, "summary.json")
        state = {"done": False}
        real_lstat = self.real[2]

        def ls(path, *, dir_fd=None):
            if path == "summary.json" and not state["done"]:
                state["done"] = True
                os.rename(p, os.path.join(self.cap, "owned-renamed"))
                with open(p, "wb") as f:
                    f.write(b"UNOWNED-REPLACEMENT")
            return real_lstat(path, dir_fd=dir_fd)

        os.lstat = ls
        self.spy_write()
        with self.assertRaises(diag.Unsafe):
            self.out.write_bytes_new("summary.json", [b"ACTUAL-DIAGNOSTIC-BYTES"])
        os.lstat, os.write = self.real[2], self.real[1]
        self.assertEqual(sum(self.writes.values()), 0)
        self.assertEqual(open(p, "rb").read(), b"UNOWNED-REPLACEMENT")  # byte identity, still there

    def test_competing_final_inserted_before_create_is_never_overwritten(self):
        real_open = self.real[0]
        p = os.path.join(self.cap, "summary.json")

        def op(path, flags, mode=0o777, *, dir_fd=None):
            if path == "summary.json" and not os.path.exists(p):
                with open(p, "wb") as f:
                    f.write(b"UNOWNED-FINAL")
            return real_open(path, flags, mode, dir_fd=dir_fd)

        os.open = op
        self.spy_write()
        with self.assertRaises(FileExistsError):
            self.out.write_bytes_new("summary.json", [b"ACTUAL-DIAGNOSTIC-BYTES"])
        os.open, os.write = self.real[0], self.real[1]
        self.assertEqual(sum(self.writes.values()), 0)
        self.assertEqual(open(p, "rb").read(), b"UNOWNED-FINAL")

    def test_replacement_between_chunks_stops_before_the_next_write(self):
        p = os.path.join(self.cap, "swift-test.log")
        calls = {"n": 0}

        def swap():
            calls["n"] += 1
            if calls["n"] == 2:
                os.rename(p, os.path.join(self.cap, "owned-renamed"))
                with open(p, "wb") as f:
                    f.write(b"UNOWNED-REPLACEMENT")

        state = {"first": True}
        real_write = self.real[1]

        def wr(fd, data):
            n = real_write(fd, data)
            self.writes[os.fstat(fd).st_ino] = self.writes.get(os.fstat(fd).st_ino, 0) + n
            swap()
            return n

        os.write = wr
        with self.assertRaises(diag.Unsafe):
            self.out.write_bytes_new("swift-test.log", [b"a" * diag.CHUNK, b"b" * diag.CHUNK, b"c" * diag.CHUNK])
        os.write = self.real[1]
        self.assertEqual(sum(self.writes.values()), 2 * diag.CHUNK)  # the residual: no write after detection
        self.assertEqual(open(p, "rb").read(), b"UNOWNED-REPLACEMENT")


class EntryPointTests(unittest.TestCase):
    """The real command line, as the workflow runs it."""

    def setUp(self):
        self.fx = Fixture()

    def tearDown(self):
        self.fx.cleanup()

    def cli(self, argv, timeout=120):
        return subprocess.run([sys.executable, "-B", HELPER] + argv, cwd=self.fx.repo, stdin=subprocess.DEVNULL,
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout)

    def test_mark_then_capture_with_no_report_is_unavailable_and_exits_zero(self):
        r = self.cli(self.fx.args("mark"))
        self.assertEqual(r.returncode, 0, r.stderr)
        self.fx.write_log()
        r = self.cli(self.fx.args("finish"))
        self.assertEqual(r.returncode, 0, r.stderr)
        t0 = time.monotonic()
        r = self.cli(self.fx.args())
        took = time.monotonic() - t0
        self.assertEqual(r.returncode, 0, r.stderr)
        s = self.fx.summary()
        self.assertEqual(s["status"], "UNAVAILABLE")
        self.assertEqual(s["mark"]["status"], "ok")
        self.assertEqual(s["log_signals"], [11])
        self.assertLess(took, diag.CAPTURE_BUDGET_S + 5)

    def test_usage_errors_exit_two(self):
        self.assertEqual(self.cli([]).returncode, 2)
        self.assertEqual(self.cli(["capture", "--runner-temp", self.fx.rt]).returncode, 2)
        self.assertEqual(self.cli(self.fx.args("capture", attempt="x")).returncode, 2)
        rel = self.fx.args("mark")
        rel[2] = "relative/temp"
        self.assertEqual(self.cli(rel).returncode, 2)


WORKFLOW = os.path.normpath(os.path.join(HERE, "..", "..", ".github", "workflows", "swift-package.yml"))


def swift_test_run_script():
    """The exact `run: |` body of the `swift test` step in swift-package.yml."""
    lines = open(WORKFLOW).read().split("\n")
    at = lines.index("      - name: swift test")
    run = lines.index("        run: |", at)
    body = []
    for line in lines[run + 1:]:
        if not line.startswith("          "):
            break
        body.append(line[10:])
    return "\n".join(body) + "\n"


@unittest.skipUnless(os.path.exists("/usr/bin/perl") and os.path.exists("/usr/bin/python3"), "needs /usr/bin tools")
class PipelineExitTests(unittest.TestCase):
    """The real step body under GitHub's `bash --noprofile --norc -eo pipefail`, with a fake `swift`."""

    def setUp(self):
        self.fx = Fixture()
        self.bin = os.path.join(self.fx.root, "bin")
        os.makedirs(self.bin)
        self.pkg = os.path.join(self.fx.repo, "apps", "RelayiumKit")
        os.makedirs(os.path.join(self.fx.repo, "scripts", "ci"))
        os.makedirs(os.path.join(self.fx.rt, diag.DIAG_DIR), mode=0o700)

    def tearDown(self):
        self.fx.cleanup()

    def helper(self, body=None):
        dst = os.path.join(self.fx.repo, "scripts", "ci", "swift-test-diagnostics.py")
        if body is None:
            shutil.copy(HELPER, dst)
        else:
            with open(dst, "w") as f:
                f.write(body)

    def swift(self, body):
        p = os.path.join(self.bin, "swift")
        with open(p, "w") as f:
            f.write("#!/bin/sh\necho 'Test Suite started'\n" + body)
        os.chmod(p, 0o755)

    def run_step(self, script):
        path = os.path.join(self.fx.root, "step.sh")
        with open(path, "w") as f:
            f.write(script)
        env = {"PATH": self.bin + ":/usr/bin:/bin", "RUNNER_TEMP": self.fx.rt, "GITHUB_WORKSPACE": self.fx.repo,
               "SWIFT_DIAG_SHA": HEAD, "SWIFT_DIAG_RUN_ID": RUN, "SWIFT_DIAG_ATTEMPT": ATTEMPT,
               "RELAYIUM_SWIFT_INTEROP": "1"}
        t0 = time.monotonic()
        r = subprocess.run(["bash", "--noprofile", "--norc", "-eo", "pipefail", path], cwd=self.pkg, env=env,
                           stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=60)
        return r.returncode, time.monotonic() - t0

    def baseline(self):
        script = swift_test_run_script()
        return "\n".join(l for l in script.split("\n") if not l.startswith("trap "))

    def check(self, swift_body, helper_body=None, want=None):
        self.swift(swift_body)
        self.helper(helper_body)
        script = swift_test_run_script()
        self.assertIn("trap 'rc=$?; set +e; /usr/bin/perl", script)
        base, _ = self.run_step(self.baseline())
        got, took = self.run_step(script)
        self.assertEqual(got, base, "the EXIT trap changed the pipeline's own status")
        if want is not None:
            self.assertEqual(got, want)
        return took

    def finish_record(self):
        p = os.path.join(self.fx.rt, diag.DIAG_DIR, diag.FINISH_NAME)
        return json.load(open(p)) if os.path.exists(p) else None

    def test_green_suite_stays_green_and_records_the_end(self):
        self.check("exit 0\n", want=0)
        self.assertEqual(self.finish_record()["attempt"], ATTEMPT)

    def test_red_suite_stays_red_with_its_own_status(self):
        self.check("exit 7\n", want=7)
        self.assertIsNotNone(self.finish_record())

    def test_signal_killed_suite_keeps_its_signal_status(self):
        self.check("kill -SEGV $$\n", want=139)

    def test_a_failing_finish_changes_nothing(self):
        self.check("exit 0\n", helper_body="import sys\nsys.exit(9)\n", want=0)
        self.check("exit 7\n", helper_body="import sys\nsys.exit(9)\n", want=7)

    def test_a_hanging_finish_is_ended_by_the_trap_bound_and_changes_nothing(self):
        took = self.check("exit 7\n", helper_body="import time\ntime.sleep(60)\n", want=7)
        self.assertLess(took, 15)


if __name__ == "__main__":
    unittest.main(verbosity=2)

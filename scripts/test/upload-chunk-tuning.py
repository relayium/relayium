#!/usr/bin/env python3
"""Opt-in local native upload measurement; never contacts a deployed service."""
import argparse
import json
import hashlib
import os
from pathlib import Path
import shutil
import signal
import subprocess
import time
import urllib.request


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True, help="new private output directory")
    parser.add_argument("--mode", choices=["matrix", "faults", "smoke"], default="matrix")
    parser.add_argument("--experimental", action="store_true", help="compare test-only 8/16/32 MiB caps")
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[2]
    out = args.output.expanduser().absolute()
    out.mkdir(mode=0o700, parents=True, exist_ok=False)
    os.chmod(out, 0o700)
    tmp = out / "tmp"
    tmp.mkdir(mode=0o700)
    probe = out / "probe"
    probe.mkdir()
    package = root / "apps/RelayiumKit"
    shutil.copytree(package / "Sources", probe / "Sources")
    shutil.copy2(package / "Package.resolved", probe / "Package.resolved")
    tests = probe / "Tests"
    tests.mkdir()
    names = ["UploadChunkTuningTests.swift", "UploadChunkNegotiationTests.swift", "CloudUploaderPipelineTests.swift"]
    for name in names:
        shutil.copy2(package / "Tests/RelayiumKitTests" / name, tests / name)
    # Preserve every shipping target and pinned dependency. Only select the
    # owning tests: unrelated DEBUG-only test APIs do not compile in release.
    manifest = (package / "Package.swift").read_text()
    start = manifest.index("        .testTarget(")
    end = manifest.index("\n        ),", start) + len("\n        ),")
    selected = '''        .testTarget(name: "RelayiumKitTests",
            dependencies: ["RelayiumKit", "RelayiumAppKit", "RelayiumShareKit",
                           "RelayiumLocalPeerKit", "RelayiumStoreKit"],
            path: "Tests", sources: %s),''' % json.dumps(names)
    (probe / "Package.swift").write_text(manifest[:start] + selected + manifest[end:])
    binding = {str(p.relative_to(probe)): hashlib.sha256(p.read_bytes()).hexdigest()
               for p in sorted((probe / "Sources").rglob("*")) if p.is_file()}
    binding["Package.resolved"] = hashlib.sha256((probe / "Package.resolved").read_bytes()).hexdigest()
    (out / "source-binding.json").write_text(json.dumps(binding, indent=2) + "\n")
    env = dict(os.environ, TMPDIR=str(tmp) + "/")
    for key in list(env):
        if key.startswith("RELAYIUM_CHUNK_"):
            del env[key]
    swift = ["swift", "test", "--package-path", str(probe), "--scratch-path", str(out / "swift-build"),
             "--cache-path", str(out / "swift-cache"), "--disable-automatic-resolution", "--jobs", "4", "-c", "release"]

    def run(command, logfile, child_env):
        with (out / logfile).open("wb") as log:
            child = subprocess.Popen(command, cwd=root / "server", env=child_env,
                                     stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
            try:
                if child.wait(timeout=1200):
                    raise RuntimeError("command failed; see " + str(out / logfile))
            finally:
                stop(child)

    run(swift + ["--filter", "UploadChunkNegotiationTests|CloudUploaderPipelineTests"], "build-and-owning.log", env)
    fixture = out / "server"
    fixture.mkdir()
    server_env = dict(env, RELAYIUM_CHUNK_TUNING_HOME=str(fixture), GOMAXPROCS="2")
    with (out / "server.log").open("wb") as log:
        server = subprocess.Popen(["go", "test", "./account", "-run", "^TestUploadChunkTuningFixture$",
                                   "-count=1", "-timeout=25m"], cwd=root / "server", env=server_env,
                                  stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
        url = None
        try:
            port = fixture / "PORT.json"
            deadline = time.monotonic() + 120
            while not port.exists():
                if server.poll() is not None or time.monotonic() > deadline:
                    raise RuntimeError("fixture did not become ready; see server.log")
                time.sleep(0.1)
            url = json.loads(port.read_text())["url"]
            if not url.startswith("http://127.0.0.1:") or not url.rsplit(":", 1)[1].isdigit():
                raise RuntimeError("fixture origin is not loopback")
            client_env = dict(env, RELAYIUM_CHUNK_TUNING_HOME=str(out), RELAYIUM_CHUNK_PORT=str(port),
                              RELAYIUM_CHUNK_NEGOTIATED="0" if args.experimental else "1",
                              RELAYIUM_CHUNK_REPS="6", RELAYIUM_CHUNK_BYTES="70000000")
            if args.mode == "smoke":
                client_env.update(RELAYIUM_CHUNK_SMOKE="1", RELAYIUM_CHUNK_REPS="0")
            method = "testNativeLargeShareFaultControls" if args.mode == "faults" else "testNativeChunkMatrix"
            run(swift + ["--skip-build", "--filter", "UploadChunkTuningTests." + method], "native.log", client_env)
        finally:
            try:
                if url and url.startswith("http://127.0.0.1:"):
                    urllib.request.urlopen(urllib.request.Request(url + "/bench/stop", method="POST"), timeout=5).close()
                server.wait(timeout=10)
            finally:
                stop(server)
        if server.returncode:
            raise RuntimeError("fixture failed; see server.log")
    print("Local qualification passed. Evidence: " + str(out))


def stop(child):
    """Terminate only the private process group created by this runner."""
    if child.poll() is None:
        os.killpg(child.pid, signal.SIGTERM)
        try:
            child.wait(timeout=10)
        except subprocess.TimeoutExpired:
            os.killpg(child.pid, signal.SIGKILL)
            child.wait()


if __name__ == "__main__":
    main()

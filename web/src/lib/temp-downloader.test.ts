// The generated terminal commands, and the guarantees the download page makes
// about them. Three groups:
//
//   1. quoting — the capability link is one argv element, whatever is in it;
//   2. secrecy — nothing the page or the script fetches carries the `#k=` key;
//   3. the script itself, RUN, against a local fixture release: happy path,
//      tampered checksum, tampered signature, missing verifier — and a temp
//      directory that is gone afterwards in every one of those cases.
//
// Group 3 is the one that matters most and is the easiest to fake: a string
// assertion would pass on a script that never verifies anything. So it builds a
// real signed release with openssl, serves it over file://, and executes the
// exact text the page puts on the clipboard.
import { describe, it, expect } from "vitest";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync, chmodSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  RELEASE_BASE_URL,
  RELEASE_PAGE_URL,
  RELEASE_PUBKEY_PEM,
  TEMP_DOWNLOADER_ASSETS,
  downCommand,
  psArg,
  psQuote,
  shArg,
  shQuote,
  storedLink,
  tempDownloaderScript,
  windowsDownCommand,
  windowsTempDownloaderScript,
  WINDOWS_RELEASE,
  WINDOWS_SHA256,
} from "./temp-downloader";

const KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const LINK = `https://relayium.com/d/abc123#k=${KEY}`;

// Resolved from the vitest working directory (web/), like i18n-pairing-ttl.test.ts:
// Vite rewrites `new URL(..., import.meta.url)` into an asset import.
const repoFile = (p: string) => readFileSync(resolve(process.cwd(), "..", p), "utf8");

describe("shell quoting", () => {
  it("keeps a link with a fragment as a single argument", () => {
    expect(shQuote(LINK)).toBe(`'${LINK}'`);
    // Unquoted, `#` opens a comment and the key is silently dropped — the
    // failure mode that made this a function instead of a template literal.
    expect(downCommand(LINK, ".")).toBe(`relayium down '${LINK}' .`);
  });

  it("neutralises a quote smuggled into a hand-crafted link", () => {
    const hostile = "https://relayium.com/d/x#k=a';rm -rf ~;'";
    const quoted = shQuote(hostile);
    // The closing quote is escaped, so the whole thing is still one word.
    expect(quoted).toBe(`'https://relayium.com/d/x#k=a'\\'';rm -rf ~;'\\'''`);
    expect(wordsOf(quoted)).toEqual([hostile]);
    expect(wordsOf(shQuote("a'b"))).toEqual(["a'b"]);
    expect(wordsOf(shQuote("$(id) `id` && echo pwned"))).toEqual(["$(id) `id` && echo pwned"]);
  });

  it("quotes a destination only when the shell would mangle it", () => {
    expect(shArg("."), "the common case stays readable").toBe(".");
    expect(shArg("")).toBe(".");
    expect(shArg("   ")).toBe(".");
    expect(shArg("./incoming")).toBe("./incoming");
    expect(shArg("/srv/data")).toBe("/srv/data");
    expect(shArg("my files")).toBe("'my files'");
    expect(wordsOf(shArg("~/a b/$HOME"))).toEqual(["~/a b/$HOME"]);
    expect(wordsOf(shArg("it's here"))).toEqual(["it's here"]);
  });

  it("quotes the Windows form the way PowerShell escapes, not the way sh does", () => {
    expect(windowsDownCommand(LINK, ".")).toBe(`.\\relayium.exe down '${LINK}' .`);
    // PowerShell doubles the quote; sh's '\'' would leave a stray backslash
    // inside the argument — for a capability link, a key that quietly fails.
    expect(psQuote("a'b")).toBe("'a''b'");
    expect(shQuote("a'b")).toBe("'a'\\''b'");
    // A Windows path keeps its backslashes and stays unquoted when it can.
    expect(psArg("C:\\Users\\me\\Downloads")).toBe("C:\\Users\\me\\Downloads");
    expect(psArg("C:\\my files")).toBe("'C:\\my files'");
    expect(psArg("")).toBe(".");
    expect(windowsDownCommand(LINK, "C:\\it's here")).toBe(`.\\relayium.exe down '${LINK}' 'C:\\it''s here'`);
  });

  it("rebuilds the capability link from the parts the page still holds", () => {
    expect(storedLink("https://relayium.com", "abc123", KEY)).toBe(LINK);
    // Self-hosted deployments get their own origin, not a hard-coded one.
    expect(storedLink("https://files.example.org", "id", "k")).toBe("https://files.example.org/d/id#k=k");
  });

  it("builds a fail-closed Windows temporary run from pinned official hashes", () => {
    const script = windowsTempDownloaderScript(LINK, "C:\\it's here");
    // These independent literals deliberately do not import their expected
    // values from the implementation: an accidental pin edit must fail here.
    expect(WINDOWS_RELEASE).toBe("v0.18.0");
    expect(WINDOWS_SHA256).toEqual({
      amd64: "8e8a3e807fcfc2883e69b807a874b8e05311c2f4db157961b0e82c7a0e392a33",
      arm64: "d303b6501a875e9466e89731ea5b8f50183af4db2ce567968dfa054b5f648574",
    });
    expect(script).toContain("releases/download/v0.18.0/$asset");
    expect(script).toContain(WINDOWS_SHA256.amd64);
    expect(script).toContain(WINDOWS_SHA256.arm64);
    expect(script).toMatch(/^& \{\n/);
    expect(script).toContain("[Net.SecurityProtocolType]::Tls12");
    expect(script).toContain("[Net.ServicePointManager]::SecurityProtocol = $oldSecurityProtocol");
    expect(script).toContain("[Security.Cryptography.SHA256]::Create()");
    expect(script).toContain("$sha.ComputeHash($stream)");
    expect(script).toContain("$stream.Dispose()");
    expect(script).toContain("if ($actual -ne $expected)");
    expect(script).toContain("finally {");
    expect(script).toContain("Remove-Item -LiteralPath $root -Recurse -Force");
    expect(script).toContain(`down '${LINK}' 'C:\\it''s here'`);
    expect(script).not.toMatch(/Invoke-WebRequest[^\n]*#k=/);
    expect(script).not.toMatch(/\bsudo\b|\/usr\/local|relayium login|--config-dir/);
  });
});

/** Ask a real shell how it splits a command line — the only authority on
 *  whether our quoting held. Returns the argv the shell produced. */
function wordsOf(quoted: string): string[] {
  const out = execFileSync("sh", ["-c", `printf '%s\\n' ${quoted}`], { encoding: "utf8" });
  return out.split("\n").slice(0, -1);
}

describe("the fragment key never becomes a URL", () => {
  it("puts no part of the link into any address the script fetches", () => {
    const script = tempDownloaderScript({ link: LINK, dest: "." });
    // The link's one legitimate appearance is as a quoted argument to the local
    // binary. Blank it out, then every URL still standing is one the script
    // hands to curl — and none of them may carry any part of the secret.
    const elsewhere = script.split(shQuote(LINK)).join("<LINK-ARGUMENT>");
    const urls = elsewhere.match(/\b[a-z]+:\/\/[^\s"']*/g) ?? [];
    expect(urls.length, "the script does fetch release assets").toBeGreaterThan(0);
    for (const u of urls) {
      expect(u, "a release URL carries the decryption key").not.toContain(KEY);
      expect(u, "a release URL carries the link").not.toContain("#k=");
      expect(u.startsWith(RELEASE_BASE_URL), `unexpected fetch target: ${u}`).toBe(true);
    }
    // The link appears exactly once, single-quoted, as an argument to the
    // local binary — never after a `curl`, and never with a `?` before it.
    expect(script).toContain(`"$d/relayium" down '${LINK}' .`);
    expect(script.match(new RegExp(KEY, "g"))?.length, "the key appears once").toBe(1);
    expect(/curl[^\n]*#k=/.test(script), "the key is on a curl line").toBe(false);
  });

  it("fetches only from the published release, over https", () => {
    const script = tempDownloaderScript({ link: LINK, dest: "." });
    expect(RELEASE_BASE_URL.startsWith("https://github.com/relayium/relayium/releases/")).toBe(true);
    expect(RELEASE_PAGE_URL.startsWith("https://github.com/relayium/relayium/releases/")).toBe(true);
    expect(script).toContain(`base='${RELEASE_BASE_URL}'`);
  });
});

describe("the embedded release key", () => {
  // A rotation that lands in two of the three places is the failure this
  // catches: the page would hand out a script that rejects every real release.
  it("is the same key install.sh and the CLI verify with", () => {
    const body = RELEASE_PUBKEY_PEM.replace(/-----(BEGIN|END) PUBLIC KEY-----|\s/g, "");
    expect(body.length, "a key must actually be embedded").toBeGreaterThan(40);
    expect(repoFile("web/public/install.sh"), "install.sh").toContain(body.slice(0, 40));
    expect(repoFile("server/selfupdate/release_pubkey.go"), "release_pubkey.go").toContain(body.slice(0, 40));
  });

  it("is a parseable P-256 public key", () => {
    const r = spawnSync("openssl", ["pkey", "-pubin", "-noout", "-text"], {
      input: RELEASE_PUBKEY_PEM,
      encoding: "utf8",
    });
    if (r.error) return; // no openssl here; the dry-run block below skips too
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/prime256v1|P-256/);
  });
});

describe("the asset list matches what the release actually publishes", () => {
  it("names every linux/darwin amd64/arm64 archive goreleaser builds", () => {
    const goreleaser = repoFile(".goreleaser.yaml");
    expect(goreleaser).toContain('name_template: "relayium_{{ .Os }}_{{ .Arch }}"');
    expect(goreleaser).toContain("goos: [linux, darwin, windows]");
    expect(goreleaser).toContain("goarch: [amd64, arm64]");
    for (const asset of TEMP_DOWNLOADER_ASSETS) expect(asset).toMatch(/^relayium_(linux|darwin)_(amd64|arm64)\.tar\.gz$/);
    expect(new Set(TEMP_DOWNLOADER_ASSETS).size).toBe(4);
    // Windows is published as a .zip and has no POSIX shell: it is covered by
    // written guidance, and must never be implied by this list.
    expect(TEMP_DOWNLOADER_ASSETS.some((a) => a.includes("windows"))).toBe(false);
  });
});

// ── running the real thing ──────────────────────────────────────────────────
//
// A fixture "release": a fake relayium that prints its argv, tarred and
// checksummed exactly as goreleaser does, with checksums.txt signed by a
// throwaway P-256 key that the generated script is told to trust. Served over
// file://, which curl reads, so nothing leaves the machine.

type Fixture = {
  root: string;
  base: string; // file:// URL of the release dir
  pub: string; // PEM the script should embed
  rel: string; // release dir on disk
  asset: string;
};

function have(cmd: string): boolean {
  return spawnSync("sh", ["-c", `command -v ${cmd}`]).status === 0;
}

/** The host's own OS/CPU in release-asset spelling, or null if unpublished. */
function hostAsset(): string | null {
  const os = { linux: "linux", darwin: "darwin" }[process.platform as string];
  const cpu = { x64: "amd64", arm64: "arm64" }[process.arch as string];
  return os && cpu ? `relayium_${os}_${cpu}.tar.gz` : null;
}

const asset = hostAsset();
const toolsPresent = ["openssl", "curl", "tar", "mktemp"].every(have) && (have("sha256sum") || have("shasum"));
// curl without file:// support (some hardened builds) would fail the fixture
// for a reason that has nothing to do with the script.
const curlReadsFiles =
  toolsPresent && spawnSync("sh", ["-c", `t=$(mktemp); echo ok > "$t"; curl -fsSL "file://$t" >/dev/null`]).status === 0;
const canRun = asset !== null && toolsPresent && curlReadsFiles;

function makeFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "relayium-tempdl-"));
  const rel = join(root, "release");
  mkdirSync(rel);
  // The "official CLI": prints each argument on its own line, so the test can
  // prove the link arrived as ONE argument with its fragment intact.
  const bin = join(root, "relayium");
  // RELAYIUM_TEST_HANG lets the signal test catch the run mid-download, which is
  // the only moment a Ctrl-C can actually leave the temp directory behind.
  writeFileSync(
    bin,
    '#!/bin/sh\nfor a in "$@"; do printf \'ARG:%s\\n\' "$a"; done\n[ -n "${RELAYIUM_TEST_HANG:-}" ] && sleep 30\nexit 0\n',
  );
  chmodSync(bin, 0o755);
  execFileSync("tar", ["-czf", join(rel, asset!), "-C", root, "relayium"]);

  const sum = have("sha256sum")
    ? execFileSync("sh", ["-c", `sha256sum '${join(rel, asset!)}' | awk '{print $1}'`], { encoding: "utf8" }).trim()
    : execFileSync("sh", ["-c", `shasum -a 256 '${join(rel, asset!)}' | awk '{print $1}'`], { encoding: "utf8" }).trim();
  writeFileSync(join(rel, "checksums.txt"), `${sum}  ${asset}\n`);

  const key = join(root, "release.key");
  execFileSync("openssl", ["ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", key]);
  const pub = execFileSync("openssl", ["ec", "-in", key, "-pubout"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  sign(rel, key);
  return { root, base: `file://${rel}`, pub, rel, asset: asset! };
}

function sign(rel: string, key: string) {
  execFileSync("openssl", [
    "dgst", "-sha256", "-sign", key,
    "-out", join(rel, "checksums.txt.sig"),
    join(rel, "checksums.txt"),
  ]);
}

/**
 * Where `mktemp -d` actually puts things.
 *
 * NOT `$TMPDIR`: on macOS, `mktemp -d` ignores TMPDIR and uses the per-user
 * confstr directory, so a test that redirected TMPDIR and then found it empty
 * would report "cleaned up" for a script that had cleaned up nothing. Ask
 * mktemp itself instead.
 */
const TEMP_BASE = canRun
  ? execFileSync("sh", ["-c", 'd=$(mktemp -d); printf %s "$d"; rmdir "$d"'], { encoding: "utf8" }).replace(/\/[^/]+$/, "")
  : "";

/** Names of everything in that directory right now, to diff a run against. */
function tempSnapshot(): Set<string> {
  try {
    return new Set(readdirSync(TEMP_BASE));
  } catch {
    return new Set();
  }
}

/**
 * Directories the run created and did not remove.
 *
 * Identified by content, not just by being new: the shared temp directory sees
 * unrelated churn from other processes, and a flaky test here would be read as
 * "cleanup is unreliable". Only a directory holding one of the files THIS
 * script writes counts as its leftover.
 */
function leakedDirs(before: Set<string>): string[] {
  const ours = ["relayium-release.pub", "checksums.txt", "relayium"];
  return readdirSync(TEMP_BASE)
    .filter((name) => !before.has(name))
    .filter((name) => {
      try {
        return readdirSync(join(TEMP_BASE, name)).some((f) => ours.includes(f));
      } catch {
        return false; // not a directory, or not ours to read
      }
    })
    .map((name) => join(TEMP_BASE, name));
}

/** Run the generated script the way a pasted block runs, and report what the
 *  shell saw plus any temp directory it left behind. */
function runScript(f: Fixture, o: { dest?: string; link?: string; path?: string; shell?: string } = {}) {
  const script = tempDownloaderScript({
    link: o.link ?? LINK,
    dest: o.dest ?? ".",
    baseUrl: f.base,
    pubKeyPem: f.pub,
  });
  const cwd = join(f.root, "cwd");
  rmSync(cwd, { recursive: true, force: true });
  mkdirSync(cwd);
  const before = tempSnapshot();
  const r = spawnSync(o.shell ?? "sh", ["-c", script], {
    encoding: "utf8",
    cwd,
    env: { ...process.env, ...(o.path === undefined ? {} : { PATH: o.path }) },
  });
  return { ...r, leftovers: leakedDirs(before) };
}

describe.skipIf(!canRun)("the pasted script, actually executed", () => {
  it("verifies, runs the CLI with the whole link, and leaves nothing behind", () => {
    const f = makeFixture();
    try {
      const r = runScript(f);
      expect(r.status, `stderr: ${r.stderr}`).toBe(0);
      expect(r.stdout).toContain("Release signature and checksum verified.");
      // One argv element, fragment intact — the CLI is what decrypts, so the
      // key has to survive the shell exactly.
      expect(r.stdout).toContain("ARG:down\n");
      expect(r.stdout).toContain(`ARG:${LINK}\n`);
      expect(r.stdout).toContain("ARG:.\n");
      expect(r.leftovers, "the temp directory survived a successful run").toEqual([]);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  // The block is pasted, not saved to a file: whatever the recipient's login
  // shell is, is the shell that runs it. bash and zsh are the two that actually
  // greet people over SSH, and the parts most likely to differ (the subshell,
  // the quoted heredoc, a function defined inside an if branch, `local`-free
  // POSIX style) are exactly the parts this script leans on.
  for (const shell of ["bash", "zsh", "dash"]) {
    it.skipIf(!have(shell))(`runs the same way under ${shell}`, () => {
      const f = makeFixture();
      try {
        const r = runScript(f, { shell });
        expect(r.status, `stderr: ${r.stderr}`).toBe(0);
        expect(r.stdout).toContain(`ARG:${LINK}\n`);
        expect(r.leftovers, `${shell} left the temp directory behind`).toEqual([]);
      } finally {
        rmSync(f.root, { recursive: true, force: true });
      }
    });
  }

  it("passes a destination with spaces through as one argument", () => {
    const f = makeFixture();
    try {
      const r = runScript(f, { dest: "my downloads" });
      expect(r.status, `stderr: ${r.stderr}`).toBe(0);
      expect(r.stdout).toContain("ARG:my downloads\n");
      expect(r.leftovers).toEqual([]);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("refuses a tampered checksums.txt — the signature no longer matches", () => {
    const f = makeFixture();
    try {
      // A compromised release host swaps the hash but cannot re-sign it.
      writeFileSync(join(f.rel, "checksums.txt"), `${"0".repeat(64)}  ${f.asset}\n`);
      const r = runScript(f);
      expect(r.status, "a tampered checksum list was accepted").not.toBe(0);
      expect(r.stderr).toContain("release signature is NOT valid");
      expect(r.stdout, "the CLI ran anyway").not.toContain("ARG:down");
      expect(r.leftovers, "a failed run left its temp directory behind").toEqual([]);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("refuses a checksum mismatch that IS correctly signed", () => {
    const f = makeFixture();
    try {
      // The other half: the list is authentic, the archive is not the one it
      // describes. Signature alone would wave this through.
      const key = join(f.root, "release.key");
      writeFileSync(join(f.rel, "checksums.txt"), `${"a".repeat(64)}  ${f.asset}\n`);
      sign(f.rel, key);
      const r = runScript(f);
      expect(r.status, "a mismatched archive was accepted").not.toBe(0);
      expect(r.stderr).toContain("checksum mismatch");
      expect(r.stdout).not.toContain("ARG:down");
      expect(r.leftovers).toEqual([]);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("refuses a signature made by a different key", () => {
    const f = makeFixture();
    try {
      const other = join(f.root, "other.key");
      execFileSync("openssl", ["ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", other]);
      sign(f.rel, other);
      const r = runScript(f);
      expect(r.status, "a foreign signature was accepted").not.toBe(0);
      expect(r.stderr).toContain("release signature is NOT valid");
      expect(r.leftovers).toEqual([]);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("refuses to continue when the signature file is missing", () => {
    const f = makeFixture();
    try {
      rmSync(join(f.rel, "checksums.txt.sig"));
      const r = runScript(f);
      expect(r.status, "an unsigned release was accepted").not.toBe(0);
      expect(r.stderr).toContain("cannot download checksums.txt.sig");
      expect(r.stdout).not.toContain("ARG:down");
      expect(r.leftovers).toEqual([]);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("refuses an asset that the signed list does not mention", () => {
    const f = makeFixture();
    try {
      const key = join(f.root, "release.key");
      writeFileSync(join(f.rel, "checksums.txt"), `${"b".repeat(64)}  relayium_linux_riscv64.tar.gz\n`);
      sign(f.rel, key);
      const r = runScript(f);
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain("no checksum listed for");
      expect(r.leftovers).toEqual([]);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("stops when openssl is absent instead of verifying nothing", () => {
    const f = makeFixture();
    try {
      // A PATH with curl/tar/sha but no openssl. install.sh degrades to
      // checksum-only here; this path must not, because its whole claim to the
      // reader is that the release signature was checked.
      const stub = join(f.root, "bin");
      mkdirSync(stub, { recursive: true });
      // `sh` itself has to be reachable, or the run fails for the wrong reason.
      for (const tool of ["sh", "curl", "tar", "mktemp", "sha256sum", "shasum", "awk", "grep", "cat", "uname", "rm", "echo"]) {
        const real = spawnSync("sh", ["-c", `command -v ${tool}`], { encoding: "utf8" }).stdout.trim();
        if (!real) continue;
        writeFileSync(join(stub, tool), `#!/bin/sh\nexec ${real} "$@"\n`);
        chmodSync(join(stub, tool), 0o755);
      }
      const r = runScript(f, { path: stub });
      expect(r.status, "ran without a signature verifier").not.toBe(0);
      expect(r.stderr).toContain("openssl is required");
      expect(r.stdout).not.toContain("ARG:down");
      expect(r.leftovers).toEqual([]);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  // "deleted on success, failure or Ctrl-C" is a promise the page makes in nine
  // languages. The first two are covered above by exit codes; this is the third,
  // and it is the one an EXIT-only trap would fail — so it sends a real SIGINT
  // to a real process group while the run is mid-flight.
  it("removes the temp directory when the run is interrupted", async () => {
    const f = makeFixture();
    try {
      const script = tempDownloaderScript({ link: LINK, dest: ".", baseUrl: f.base, pubKeyPem: f.pub });
      const cwd = join(f.root, "cwd");
      mkdirSync(cwd, { recursive: true });
      const before = tempSnapshot();
      const child = spawn("sh", ["-c", script], {
        cwd,
        detached: true, // its own process group, so the signal lands like Ctrl-C
        env: { ...process.env, RELAYIUM_TEST_HANG: "1" },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let out = "";
      child.stdout.on("data", (b) => (out += b));
      // Wait until the binary is actually running — before that, an "it cleaned
      // up" result would only mean the script had not started yet.
      const deadline = Date.now() + 20_000;
      while (!out.includes("ARG:down") && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
      expect(out, "the fixture CLI never started, so nothing was interrupted").toContain("ARG:down");
      // The whole test hinges on there being something to clean up at this
      // moment. If this is empty the assertion below proves nothing.
      expect(leakedDirs(before).length, "the temp directory should exist while it runs").toBe(1);

      process.kill(-child.pid!, "SIGINT");
      await new Promise((r) => child.on("exit", r));
      expect(leakedDirs(before), "Ctrl-C left the downloaded binary on disk").toEqual([]);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("writes nothing outside its temp directory and the destination", () => {
    const f = makeFixture();
    try {
      const r = runScript(f);
      expect(r.status, `stderr: ${r.stderr}`).toBe(0);
      // The fixture CLI writes nothing, so a clean cwd proves the script itself
      // staged the binary in $d rather than beside the user's files.
      expect(readdirSync(join(f.root, "cwd"))).toEqual([]);
      expect(existsSync(join(f.root, "cwd", "relayium"))).toBe(false);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });
});

describe("the script text a reader has to be able to audit", () => {
  const script = tempDownloaderScript({ link: LINK, dest: "." });

  it("is not an opaque pipe into a shell", () => {
    expect(/curl[^\n]*\|\s*(sh|bash)/.test(script), "the page's default path pipes into a shell").toBe(false);
    expect(script, "each step is labelled in the text the user copies").toMatch(/# 1\./);
    expect(script).toMatch(/# 6\./);
  });

  it("cannot close the pasted-into shell, and always cleans up", () => {
    expect(script.startsWith("(\nset -eu\n"), "set -e must be confined to a subshell").toBe(true);
    expect(script.trimEnd().endsWith(")")).toBe(true);
    expect(script).toContain(`trap 'rm -rf "$d"' EXIT`);
    expect(script).toContain(`trap 'exit 130' INT TERM HUP`);
  });

  it("asks for no root, no system path, no login and no config", () => {
    for (const forbidden of [/\bsudo\b/, /\/usr\/local\/bin/, /\/etc\//, /\bchown\b/, /\brelayium login\b/, /--config-dir/, /\bHOME\b/]) {
      expect(forbidden.test(script), `the temporary path uses ${forbidden}`).toBe(false);
    }
  });
});

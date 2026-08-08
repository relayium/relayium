// The download page's terminal paths: the one-line command for a machine that
// already has the Relayium CLI, and the *visible* verified sequence for a
// machine that must not gain a persistent install.
//
// Why any of this exists: a plain `curl -L <link> -o file` cannot produce the
// plaintext. The `#k=` fragment never reaches the server (that is the whole
// zero-knowledge promise), so nothing on our side can decrypt for curl; the
// bytes it saves are AES-GCM chunk ciphertext behind an encrypted manifest.
// Recovering the files means running Relayium's open-source decryption code.
//
// So the honest offer is "run it temporarily", not "install it":
//
//   * the archive lands in a `mktemp -d` directory and nowhere else;
//   * the ECDSA release signature over checksums.txt is REQUIRED, then the
//     archive's own SHA-256 is checked against that signed list;
//   * anything missing or mismatched stops before the binary is executed;
//   * a trap deletes the directory on success, failure and signal alike;
//   * no root, no system path, no login, no config file, no device identity.
//
// The full link is a secret. It is passed to the local process as an argv
// element and never as an HTTP URL, query parameter, Referer or log line —
// which is exactly why the script is generated here, next to the quoting.

/** The GitHub project the published release assets come from. */
export const RELEASE_REPO = "relayium/relayium";
/** Where `install.sh` and `relayium update` also fetch their assets from. */
export const RELEASE_BASE_URL = `https://github.com/${RELEASE_REPO}/releases/latest/download`;
/** Human-facing releases page — the Windows path and any manual check start here. */
export const RELEASE_PAGE_URL = `https://github.com/${RELEASE_REPO}/releases/latest`;

/**
 * Windows PowerShell does not ship an ECDSA release-signature verifier that is
 * portable across Windows PowerShell 5.1 and PowerShell 7. Pin a release and
 * the two archive hashes instead: the values below were taken from that
 * release's ECDSA-verified checksums.txt. A future bump is therefore an
 * explicit, reviewable supply-chain update rather than an unauthenticated
 * download of whatever "latest" happens to mean.
 */
export const WINDOWS_RELEASE = "v0.15.0";
export const WINDOWS_SHA256 = {
  amd64: "03b476c6eb4dc8cc418c5070a082542e7434375fd85ef66226e5d4f5a7f55788",
  arm64: "1b6848320427043810db8d96f9407cb668e25bc9467aa43f351074788a2e56c2",
} as const;

/**
 * The release signing key's PUBLIC half (ECDSA P-256, PKIX PEM). Its private
 * half is the RELAYIUM_RELEASE_KEY CI secret that signs every checksums.txt
 * (see `.goreleaser.yaml`). Publishing the public half is the point: the pasted
 * script verifies with stock `openssl` and needs nothing else installed.
 *
 * This literal is duplicated in `web/public/install.sh` and
 * `server/selfupdate/release_pubkey.go`; `temp-downloader.test.ts` fails if the
 * three ever drift apart, so a key rotation cannot land in only two of them.
 */
export const RELEASE_PUBKEY_PEM = `-----BEGIN PUBLIC KEY-----
MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAErOLLZclLFkpUWt8w4KIZ4SYB4JZf
bDRZOmWOdGsmHGKTU2GNeZZpJYPCL22ylULbxvQJEkdveZqkFIyYcGKNoA==
-----END PUBLIC KEY-----`;

/**
 * Every OS/CPU pair the temporary path can serve, named exactly as the release
 * publishes them. Windows ships a `.zip` and no POSIX shell, so it is covered
 * by separate written guidance rather than a block that would only look
 * supported. The script derives its own asset name from `uname` at run time —
 * the machine being fixed over SSH is usually not the one holding this page —
 * and refuses anything outside this list.
 */
export const TEMP_DOWNLOADER_ASSETS: readonly string[] = [
  "relayium_linux_amd64.tar.gz",
  "relayium_linux_arm64.tar.gz",
  "relayium_darwin_amd64.tar.gz",
  "relayium_darwin_arm64.tar.gz",
];

/**
 * POSIX single-quoting, applied unconditionally.
 *
 * Used for the capability link, which is the one argument that must never be
 * re-interpreted: `#` would start a comment, `&` would background the job, and
 * a `'` smuggled into a hand-crafted link would end the quote and let the rest
 * of it run as commands in the recipient's shell. `parseDownloadKey` already
 * confines the fragment to base64url, so this is the second lock, not the only
 * one — and the one that keeps holding if that regex is ever relaxed.
 */
export function shQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

/**
 * Quote a path only when the shell would otherwise split or interpret it, so
 * the common `.` and `./incoming` stay readable in a command meant to be read
 * before it is pasted. An empty destination means "here".
 */
export function shArg(s: string): string {
  const v = s.trim();
  if (v === "") return ".";
  return /^[\w@%+=:,./-]+$/.test(v) ? v : shQuote(v);
}

/** The full capability link, rebuilt from the parts the page still holds.
 *  The address bar lost the fragment on the first line of onMount; this is the
 *  only place it is put back together, and it stays inside the page. */
export function storedLink(origin: string, id: string, fragKey: string): string {
  return `${origin}/d/${id}#k=${fragKey}`;
}

/** What to run when the CLI is already on the machine. */
export function downCommand(link: string, dest: string): string {
  return `relayium down ${shQuote(link)} ${shArg(dest)}`;
}

/**
 * PowerShell single-quoting. A different escape from POSIX: PowerShell doubles
 * an embedded quote (`''`) where sh ends and re-opens the string (`'\''`).
 * Pasting sh's form into PowerShell would leave a stray backslash inside the
 * argument, which for a capability link means a key that silently does not
 * decrypt — so the two forms cannot share one function.
 */
export function psQuote(s: string): string {
  return "'" + s.replace(/'/g, "''") + "'";
}

/** Quote a Windows path only when PowerShell would otherwise split it.
 *  Backslash is a normal path character here, unlike in `shArg`. */
export function psArg(s: string): string {
  const v = s.trim();
  if (v === "") return ".";
  return /^[\w@%+=:,./\\-]+$/.test(v) ? v : psQuote(v);
}

/**
 * The same call on Windows, after the release .zip has been extracted by hand.
 * PowerShell specifically — `cmd.exe` treats `'` as an ordinary character, so
 * the quotes would end up inside the link and `down` would reject it. The
 * command block is titled `powershell` for that reason.
 */
export function windowsDownCommand(link: string, dest: string): string {
  return `.\\relayium.exe down ${psQuote(link)} ${psArg(dest)}`;
}

/**
 * A Windows-native no-persistent-install path. It deliberately uses only
 * PowerShell/.NET facilities present on supported 64-bit Windows systems,
 * verifies a pinned official archive hash before extraction, runs from a
 * random temp directory, and removes that directory from `finally`.
 */
export function windowsTempDownloaderScript(link: string, dest: string): string {
  const base = `https://github.com/${RELEASE_REPO}/releases/download/${WINDOWS_RELEASE}`;
  return `& {
  $ErrorActionPreference = 'Stop'
  $oldSecurityProtocol = [Net.ServicePointManager]::SecurityProtocol
  $root = Join-Path ([IO.Path]::GetTempPath()) ('relayium-' + [guid]::NewGuid())
  New-Item -ItemType Directory -Path $root | Out-Null
  try {
    # GitHub requires TLS 1.2; older Windows PowerShell may not enable it by default.
    [Net.ServicePointManager]::SecurityProtocol = $oldSecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
  $machine = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
  switch ($machine.ToUpperInvariant()) {
    'AMD64' { $arch = 'amd64'; $expected = '${WINDOWS_SHA256.amd64}' }
    'ARM64' { $arch = 'arm64'; $expected = '${WINDOWS_SHA256.arm64}' }
    default { throw "relayium: no published Windows build for $machine" }
  }
  $asset = "relayium_windows_$arch.zip"
  $archive = Join-Path $root $asset
  Invoke-WebRequest -UseBasicParsing -Uri "${base}/$asset" -OutFile $archive
  $actual = (Get-FileHash -Algorithm SHA256 -Path $archive).Hash.ToLowerInvariant()
  if ($actual -ne $expected) { throw 'relayium: pinned SHA-256 mismatch - nothing was run' }
  Expand-Archive -LiteralPath $archive -DestinationPath $root
  & (Join-Path $root 'relayium.exe') down ${psQuote(link)} ${psArg(dest)}
  if ($LASTEXITCODE -ne 0) { throw "relayium down failed with exit code $LASTEXITCODE" }
  } finally {
    [Net.ServicePointManager]::SecurityProtocol = $oldSecurityProtocol
    Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
  }
}`;
}

export type TempScriptOptions = {
  /** The full `…/d/<id>#k=<key>` link. Quoted; never fetched from here. */
  link: string;
  /** Destination directory for the decrypted files. */
  dest: string;
  /** Release asset base. Overridden only by the dry-run harness. */
  baseUrl?: string;
  /** Release public key. Overridden only by the dry-run harness. */
  pubKeyPem?: string;
};

/**
 * The pasteable, readable, no-persistent-install sequence.
 *
 * Deliberately NOT a `curl … | sh` one-liner: the reader has to be able to see
 * that the signature is checked, that the binary runs from a temp directory,
 * and that the directory is deleted — piping a script into a shell shows none
 * of that. (`install.sh` stays available for people who want the short form and
 * an actual install; this is the other case.)
 *
 * The body runs inside `( … )`. `set -e` in a subshell cannot close the login
 * shell of someone who pasted this over SSH, and the EXIT trap fires when the
 * subshell ends rather than when their session does. `trap 'exit 130' INT TERM
 * HUP` routes a Ctrl-C into that same EXIT trap, so the cleanup path is one
 * path instead of three.
 *
 * Fail-closed points, in order: unsupported OS, unsupported CPU, missing
 * curl/tar/openssl, missing sha256sum/shasum, failed download, bad or missing
 * signature, unlisted asset, checksum mismatch, failed extract. The binary is
 * executed only after all of them pass.
 */
export function tempDownloaderScript(o: TempScriptOptions): string {
  const base = o.baseUrl ?? RELEASE_BASE_URL;
  const pub = (o.pubKeyPem ?? RELEASE_PUBKEY_PEM).trim();
  return `(
set -eu

# 1. An isolated temporary directory, deleted on success, failure or Ctrl-C.
d=$(mktemp -d)
trap 'rm -rf "$d"' EXIT
trap 'exit 130' INT TERM HUP

# 2. Match THIS machine to a published build; stop if there is not one.
os=$(uname -s)
case "$os" in Linux) os=linux ;; Darwin) os=darwin ;; *) echo "relayium: no published build for $os" >&2; exit 1 ;; esac
cpu=$(uname -m)
case "$cpu" in x86_64|amd64) cpu=amd64 ;; arm64|aarch64) cpu=arm64 ;; *) echo "relayium: no published build for $cpu" >&2; exit 1 ;; esac
asset="relayium_\${os}_\${cpu}.tar.gz"

# 3. Require every verifier. Missing tools stop here instead of downgrading.
for tool in curl tar openssl; do command -v "$tool" >/dev/null 2>&1 || { echo "relayium: $tool is required" >&2; exit 1; }; done
if command -v sha256sum >/dev/null 2>&1; then sha() { sha256sum "$1" | awk '{print $1}'; }
elif command -v shasum >/dev/null 2>&1; then sha() { shasum -a 256 "$1" | awk '{print $1}'; }
else echo "relayium: sha256sum or shasum is required" >&2; exit 1; fi

# 4. Fetch the official archive, the checksum list, and its release signature.
base=${shQuote(base)}
echo "Downloading $asset ..."
for f in "$asset" checksums.txt checksums.txt.sig; do
  curl -fsSL "$base/$f" -o "$d/$f" || { echo "relayium: cannot download $f" >&2; exit 1; }
done

# 5. Verify the release signature over checksums.txt, then this archive's hash.
cat > "$d/relayium-release.pub" <<'RELAYIUM_RELEASE_PUBKEY'
${pub}
RELAYIUM_RELEASE_PUBKEY
openssl dgst -sha256 -verify "$d/relayium-release.pub" -signature "$d/checksums.txt.sig" "$d/checksums.txt" >/dev/null 2>&1 || { echo "relayium: release signature is NOT valid - nothing was run" >&2; exit 1; }
want=$(grep " $asset\\$" "$d/checksums.txt" | awk '{print $1}')
[ -n "$want" ] || { echo "relayium: no checksum listed for $asset" >&2; exit 1; }
[ "$want" = "$(sha "$d/$asset")" ] || { echo "relayium: checksum mismatch - nothing was run" >&2; exit 1; }
echo "Release signature and checksum verified."

# 6. Unpack the official CLI inside that directory and run it there. The link's
#    #k= key is an argument to this local process; it is never sent anywhere.
tar -xzf "$d/$asset" -C "$d" relayium || { echo "relayium: cannot extract $asset" >&2; exit 1; }
"$d/relayium" down ${shQuote(o.link)} ${shArg(o.dest)}
)`;
}

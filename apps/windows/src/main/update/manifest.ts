// The update manifest, parsed only after its bytes were verified.
//
// ## Strict, and unknown means refuse
//
// Every field is checked, every unexpected schema is refused, and the platform,
// architecture, product and channel are all explicit rather than assumed. A
// manifest this build cannot fully understand is not partially honoured: a
// forward-compatible parser that ignores what it does not recognise is a parser
// that can be told to ignore the field that mattered.
//
// ## Why the version rules are two rules
//
// `build` is a monotonic integer and is the gate: strictly greater, or there is
// nothing to install. `version` is what the user sees, and it may never go
// backwards. Both are required because they answer different questions — a
// rebuild of the same version is a legitimate update (same version, higher
// build), while a lower version with a higher build is a downgrade wearing a
// newer number.

export const MAX_MANIFEST_BYTES = 64 * 1024;
export const MAX_VERSION_LENGTH = 32;
export const MAX_URL_LENGTH = 2048;
/** A generous ceiling on an installer, so a hostile `sizeBytes` cannot become a
 *  disk-fill budget. The Windows artifact is ~90 MB. */
export const MAX_ARTIFACT_BYTES = 512 * 1024 * 1024;

export interface UpdateManifest {
  readonly schema: 1;
  readonly product: string;
  readonly channel: string;
  readonly platform: "windows";
  readonly arch: "x64";
  readonly version: string;
  readonly build: number;
  readonly artifactUrl: string;
  readonly artifactBytes: number;
  /** Lowercase hex SHA-256 of the artifact. */
  readonly artifactSha256: string;
  readonly publishedAt: number;
  readonly notesUrl: string | null;
  /**
   * The EXACT bytes the signature covers, carried with the parse.
   *
   * A restart has to re-authenticate rather than trust a local record, so the
   * bytes travel with the manifest and are persisted verbatim. Re-serialising
   * the parsed object would produce something the signature does not cover.
   */
  readonly signedBytes: Uint8Array;
  /** Base64url of the detached signature over `signedBytes`. */
  readonly signature: string;
}

export type ManifestRefusal =
  | "not-json"
  | "not-an-object"
  | "unknown-schema"
  | "wrong-product"
  | "wrong-channel"
  | "wrong-platform"
  | "wrong-arch"
  | "bad-version"
  | "bad-build"
  | "bad-artifact-url"
  | "bad-artifact-size"
  | "bad-artifact-hash"
  | "bad-published-at"
  | "bad-notes-url"
  | "too-large";

export class ManifestError extends Error {
  constructor(readonly code: ManifestRefusal) {
    super(`update manifest: ${code}`);
    this.name = "ManifestError";
  }
}

const SEMVER = /^(0|[1-9][0-9]{0,4})\.(0|[1-9][0-9]{0,4})\.(0|[1-9][0-9]{0,4})$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * `x.y.z`, and nothing else.
 *
 * No prerelease, no build metadata, no `v` prefix, no four-part version. Every
 * one of those is a comparison rule this product does not need and would have
 * to get right to be safe. Leading zeros are refused so `1.01.0` cannot compare
 * equal to `1.1.0` in one place and differently in another.
 */
export function parseVersion(text: unknown): readonly [number, number, number] {
  if (typeof text !== "string" || text.length > MAX_VERSION_LENGTH) throw new ManifestError("bad-version");
  const match = SEMVER.exec(text);
  if (match === null) throw new ManifestError("bad-version");
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** -1, 0 or 1. Total over the strict form above. */
export function compareVersions(left: string, right: string): number {
  const a = parseVersion(left);
  const b = parseVersion(right);
  for (let i = 0; i < 3; i += 1) {
    const l = a[i] ?? 0;
    const r = b[i] ?? 0;
    if (l !== r) return l < r ? -1 : 1;
  }
  return 0;
}

/** An https URL of a bounded length, with nothing that carries a credential or
 *  a secret. The HOST is not checked here — that is `artifact.ts`'s allowlist,
 *  and keeping the two apart means neither can be mistaken for the other. */
function checkedHttpsUrl(value: unknown, refusal: ManifestRefusal): string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_URL_LENGTH) {
    throw new ManifestError(refusal);
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new ManifestError(refusal);
  }
  if (parsed.protocol !== "https:") throw new ManifestError(refusal);
  if (parsed.username !== "" || parsed.password !== "") throw new ManifestError(refusal);
  // A fragment is where a key lives elsewhere in this product; an artifact URL
  // has no use for one, so it is refused rather than dropped.
  if (parsed.hash !== "") throw new ManifestError(refusal);
  if (parsed.port !== "" && parsed.port !== "443") throw new ManifestError(refusal);
  return value;
}

function checkedInteger(value: unknown, refusal: ManifestRefusal, max: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > max) {
    throw new ManifestError(refusal);
  }
  return value;
}

/**
 * Parse the manifest. Call ONLY after `assertSignedByPin` has accepted the same
 * bytes.
 *
 * `expected` states what this build is: its product, channel, platform and
 * architecture. They are compared, not read — a manifest that names another
 * platform is refused rather than treated as a newer one.
 */
export function parseManifest(
  bytes: Uint8Array,
  expected: {
    readonly product: string;
    readonly channel: string;
    readonly platform: "windows";
    readonly arch: "x64";
  },
  /** The signature that was verified over `bytes`, carried for persistence. */
  signature: string,
): UpdateManifest {
  if (bytes.byteLength > MAX_MANIFEST_BYTES) throw new ManifestError("too-large");
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new ManifestError("not-json");
  }
  if (!isRecord(parsed)) throw new ManifestError("not-an-object");
  // Schema first: everything below is a claim about a shape this build believes
  // it knows, and an unknown schema means it does not.
  if (parsed["schema"] !== 1) throw new ManifestError("unknown-schema");
  if (parsed["product"] !== expected.product) throw new ManifestError("wrong-product");
  if (parsed["channel"] !== expected.channel) throw new ManifestError("wrong-channel");
  if (parsed["platform"] !== expected.platform) throw new ManifestError("wrong-platform");
  if (parsed["arch"] !== expected.arch) throw new ManifestError("wrong-arch");

  const version = parsed["version"];
  parseVersion(version); // throws `bad-version`
  const build = checkedInteger(parsed["build"], "bad-build", Number.MAX_SAFE_INTEGER);
  if (build === 0) throw new ManifestError("bad-build");

  const artifact = parsed["artifact"];
  if (!isRecord(artifact)) throw new ManifestError("bad-artifact-url");
  const artifactUrl = checkedHttpsUrl(artifact["url"], "bad-artifact-url");
  const artifactBytes = checkedInteger(artifact["sizeBytes"], "bad-artifact-size", MAX_ARTIFACT_BYTES);
  if (artifactBytes === 0) throw new ManifestError("bad-artifact-size");
  const hash = artifact["sha256"];
  if (typeof hash !== "string" || !SHA256_HEX.test(hash)) throw new ManifestError("bad-artifact-hash");

  const publishedAt = checkedInteger(parsed["publishedAt"], "bad-published-at", Number.MAX_SAFE_INTEGER);
  const notes = parsed["notesUrl"];
  const notesUrl =
    notes === undefined || notes === null ? null : checkedHttpsUrl(notes, "bad-notes-url");

  return {
    schema: 1,
    product: expected.product,
    channel: expected.channel,
    platform: expected.platform,
    arch: expected.arch,
    version: version as string,
    build,
    artifactUrl,
    artifactBytes,
    artifactSha256: hash,
    publishedAt,
    notesUrl,
    signedBytes: bytes,
    signature,
  };
}

export type Installability =
  /** Strictly newer by build, and not a version regression. */
  | { readonly verdict: "newer" }
  /** Nothing to do: the same build, or an older one. */
  | { readonly verdict: "not-newer" }
  /** The build advanced but the version went BACKWARDS — a downgrade wearing a
   *  newer build number. Refused, and reported distinctly from "not newer". */
  | { readonly verdict: "version-regression" };

/**
 * Whether a manifest describes something this build may install.
 *
 * Two rules, because they catch different lies:
 *
 *   * `build` must be strictly greater. Equal is not newer, and lower is a
 *     replay of an older feed. This is the monotonic gate.
 *   * `version` must not be lower. A same-version, higher-build manifest is a
 *     legitimate rebuild; a lower-version one is a downgrade, and a monotonic
 *     build counter alone would admit it.
 */
export function installability(
  candidate: { readonly version: string; readonly build: number },
  current: { readonly version: string; readonly build: number },
): Installability {
  if (candidate.build <= current.build) return { verdict: "not-newer" };
  if (compareVersions(candidate.version, current.version) < 0) {
    return { verdict: "version-regression" };
  }
  return { verdict: "newer" };
}

#!/usr/bin/env node
// scripts/test/dependency-pinning-test.mjs — the deterministic, offline half of
// this repository's dependency policy: every tracked third-party reference must
// be as specific as its ecosystem allows, and the tracked files that record
// those references must agree with each other.
//
// The strongest form a reference can take is an IDENTITY: a 40-hex Git object
// name, in a `uses:` pin or in a `Package.resolved` revision, denotes one
// immutable object. `actions/checkout@v6` is a NAME — upstream decides later
// which commit it means, and the answer can change between the run that was
// reviewed and the run that ships.
//
// Not everything below reaches that bar, and this file does not pretend it does.
// A check is worth exactly what the thing it checks is worth:
//
//   * `exact: "0.11.0"` is a fixed SEMANTIC-VERSION CONSTRAINT, not an identity.
//     It takes away the resolver's freedom to choose a different release, but the
//     tag behind that version lives in somebody else's repository and can in
//     principle be repointed. The immutable evidence for a Swift dependency is
//     the 40-hex `revision` in `Package.resolved` — which is why rule 3 exists,
//     and why rules 2 and 3 are only worth something together.
//   * `node-version: 24` is a MUTABLE MAJOR SELECTOR. `setup-node` resolves the
//     major to whichever matching 24.x release is available that day — from the
//     hosted tool cache or by downloading one — which is not necessarily the one
//     it resolved to last month. Rule 4 claims nothing else: all it enforces
//     is that every lane names the SAME numeric major, so no lane silently tests
//     a runtime no other lane does.
//
// That distinction is not cosmetic here. `release.yml` signs and publishes the
// CLI; `macos.yml` produces a notarized, Developer-ID-signed artifact and an
// IMMUTABLE GitHub Release; `swift-sodium` is the crypto the entire end-to-end
// promise rests on. A retagged upstream action or a resolve that quietly moved a
// crypto dependency reaches users through those lanes with every check green,
// because nothing else in this repository looks at the reference itself.
//
// ## What this file checks
//
//   1. Action pins.       Every non-local `uses:` in `.github/workflows/*.yml`
//                         is a 40-character lowercase hex commit with a
//                         trailing `# vX.Y.Z` comment. Unsupported remote forms
//                         (`docker://`, a bare name, a tag) are DIAGNOSED, not
//                         skipped. One ACTION+SHA must always carry the same
//                         version comment and one action+version must always
//                         carry one SHA — but two MAJORS of one action may sit
//                         at different SHAs, which is the real state of
//                         `actions/upload-artifact` here and is not a defect.
//                         Comment consistency is keyed by action+SHA rather
//                         than by the bare SHA because a Git object name only
//                         means something inside a repository: two unrelated
//                         action repositories may legitimately contain the same
//                         commit id and describe it as different releases.
//   2. Swift declarations. `apps/RelayiumKit/Package.swift` external packages
//                         use `exact:`; `from:`, a branch, a revision and every
//                         range form are rejected. Every
//                         XCRemoteSwiftPackageReference in both `.pbxproj`
//                         files uses `exactVersion` with a concrete version.
//                         This is the CONSTRAINT half only; rule 3 holds the
//                         revision that makes it concrete.
//   3. Swift resolutions.  All three tracked `Package.resolved` files parse;
//                         every pin has an identity, a 40-lowercase-hex
//                         revision and a concrete version; and an identity that
//                         appears in more than one file resolves to the SAME
//                         revision and version everywhere. The files are NOT
//                         required to be identical: Sparkle is a macOS-only
//                         dependency and legitimately appears in one of them.
//   4. Node major.         Every `node-version:` across every workflow is the
//                         same bare numeric major. Expressions, ranges and
//                         aliases are rejected in this wave rather than
//                         interpreted. This is a CONSISTENCY rule, not a
//                         pinning one: a bare major still lets the runner pick
//                         its own minor and patch.
//   5. Web lockfile.       `web/package-lock.json` is lockfileVersion >= 3, has
//                         a non-empty `packages` map, and every non-root entry
//                         resolves to `https://registry.npmjs.org/` with a
//                         non-empty `integrity`. Any other host, a git or file
//                         reference, a malformed URL or a missing `resolved` is
//                         a failure.
//
// ## What it deliberately does NOT check
//
// Nothing here touches the network, so nothing here can know whether a pinned
// SHA is the commit its `# v6.0.2` comment names, whether that release is the
// latest, or whether any pinned version has a published advisory. The comment is
// checked for SHAPE — a human-readable marker that is present and well-formed —
// and the integrity hashes are checked for PRESENCE. Those are different claims
// from "this is the right code", and `docs/DEPENDENCY-POLICY.md` says which
// layer is supposed to make the other ones.
//
// It also does not prove that a BUILD consumed any of this unchanged. No lane
// here passes `-onlyUsePackageVersionsFromResolvedFile` or otherwise disables
// automatic SwiftPM resolution, so `xcodebuild` may still resolve and rewrite
// `Package.resolved` during a run. On the npm side this file inspects no install
// command: every Web install in `.github/workflows/` is `npm ci` today, and
// `ci-event-policy-test.mjs` already enforces that form for the compat lane, so
// the gap left here is chiefly the Swift/Xcode one. What rules 2, 3 and 5 establish is
// that the TRACKED declarations and the TRACKED resolutions are internally
// consistent and specific — a precondition for a reproducible build, not a
// demonstration of one. Closing that gap is recorded as deferred work in
// `docs/DEPENDENCY-POLICY.md`.
//
// ## Why the checks are functions over a world
//
// A pinning check is the kind that passes because it found nothing. Delete the
// `dependencies:` block and rule 2 has no declaration to reject; rename
// `node-version` and rule 4 has no value to disagree with; strip `resolved` from
// the lockfile and rule 5 approves of the empty set. So every rule takes an
// in-memory WORLD — the file texts, nothing read at check time — `policyFailures`
// is a pure function of it, and section 7 feeds it deliberately broken worlds and
// requires the specific complaint back. Coverage assertions inside the rules
// themselves make "there was nothing to check" a failure rather than a pass.
//
// Both halves run on the ordinary invocation. There is no `--self-check` flag,
// because a flag is a thing CI can be configured without.
//
// Deliberately no YAML or plist dependency, for the same reason as
// `macos-publish-order-test.mjs`: `web/` is the only Node project here and this
// must run with nothing installed. The parsing is narrow and fails closed — a
// block it cannot attribute is reported, never assumed empty.

import { readFile, readdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

const WORKFLOW_DIR = ".github/workflows";
const PACKAGE_SWIFT = "apps/RelayiumKit/Package.swift";
const PBXPROJS = [
  "apps/mac/Relayium.xcodeproj/project.pbxproj",
  "apps/ios/Relayium.xcodeproj/project.pbxproj",
];
const RESOLVED = [
  "apps/RelayiumKit/Package.resolved",
  "apps/mac/Relayium.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved",
  "apps/ios/Relayium.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved",
];
const PACKAGE_LOCK = "web/package-lock.json";

/** A 40-character lowercase hex object name. Uppercase is rejected on purpose:
 *  Git accepts it, string comparison against a review does not. */
const FULL_SHA = /^[0-9a-f]{40}$/;
/** The shape of the human-readable marker, not its truth. */
const VERSION_COMMENT = /^v\d+(?:\.\d+){0,2}$/;
/** A concrete released version: no ranges, no branches, no `latest`. */
const CONCRETE_VERSION = /^\d+(?:\.\d+){0,3}(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?$/;

const failures = [];
function check(ok, message) {
  if (ok) return;
  failures.push(message);
}

// ---------------------------------------------------------------------------
// 1. The world
// ---------------------------------------------------------------------------

/**
 * Every file the policy reads, as text, keyed by repository-relative path.
 *
 * Read once. Every rule below is a function of this map and of nothing else,
 * which is what lets section 7 hand the same rules a broken repository without
 * writing a byte to disk.
 */
async function readWorld() {
  const world = new Map();
  const names = (await readdir(resolve(repoRoot, WORKFLOW_DIR)))
    .filter((name) => name.endsWith(".yml"))
    .sort();
  const paths = [
    ...names.map((name) => `${WORKFLOW_DIR}/${name}`),
    PACKAGE_SWIFT, ...PBXPROJS, ...RESOLVED, PACKAGE_LOCK,
  ];
  for (const path of paths) {
    world.set(path, await readFile(resolve(repoRoot, path), "utf8"));
  }
  return world;
}

/** The workflow paths in a world, in a stable order. */
function workflowPaths(world) {
  return [...world.keys()].filter((path) => path.startsWith(`${WORKFLOW_DIR}/`)).sort();
}

/**
 * The executable lines of a file: comment lines dropped, line numbers kept.
 *
 * Comments matter in both directions here. `repo-hygiene.yml` explains its own
 * pinning rule in prose that contains a version-looking string, and this file's
 * rationale names the very forms it rejects — matched as code, either would make
 * the gate agree with a comment instead of with a command.
 */
function codeLines(text) {
  return text.split("\n")
    .map((text_, index) => ({ text: text_, line: index + 1 }))
    .filter(({ text: line }) => !/^\s*#/.test(line));
}

// ---------------------------------------------------------------------------
// 2. Rule 1 — GitHub Actions references
// ---------------------------------------------------------------------------

/**
 * One `uses:` reference, classified.
 *
 * `kind` is `local` for `./…` (this repository's own tree, moved with the
 * commit under test and so already pinned by definition), `remote` for
 * `owner/repo[/path]@ref`, and `unsupported` for everything else. There is no
 * fourth outcome: a form this cannot name is reported, never dropped, because a
 * silently ignored reference is exactly the hole the rule exists to close.
 */
function classifyUses(value) {
  const match = /^(\S+)(?:\s+#\s*(.*?)\s*)?$/.exec(value.trim());
  if (!match) return { kind: "unsupported", reason: "is not a parseable uses: value" };
  const ref = match[1].replace(/^["']|["']$/g, "");
  const comment = match[2];
  if (ref.startsWith("./") || ref === ".") return { kind: "local", ref };
  const remote = /^([A-Za-z0-9][\w.-]*)\/([\w.-]+(?:\/[\w.-]+)*)@(.+)$/.exec(ref);
  if (!remote) {
    const reason = ref.startsWith("docker://")
      ? "is a docker:// reference, which this policy does not cover"
      : ref.includes("@")
        ? "is not owner/repo[/path]@ref"
        : "names no ref at all (an unpinned action)";
    return { kind: "unsupported", ref, reason };
  }
  return { kind: "remote", ref, action: `${remote[1]}/${remote[2]}`, pin: remote[3], comment };
}

function checkActionPins(world, out) {
  let remoteCount = 0;
  let localCount = 0;
  /** `action@SHA` -> first `file:line` and version comment that used it.
   *  Keyed by ACTION as well as SHA on purpose: a Git object name is only
   *  unique inside one repository, so two unrelated action repositories may
   *  legitimately hold the same commit id under different release names. Only
   *  the same commit of the SAME action has to be described one way. */
  const byActionSha = new Map();
  /** `action@version` -> first `file:line` and SHA that used it. */
  const byVersion = new Map();

  for (const path of workflowPaths(world)) {
    for (const { text, line } of codeLines(world.get(path))) {
      const match = /^\s*(?:-\s+)?uses:\s*(\S.*)$/.exec(text);
      if (!match) continue;
      const where = `${path}:${line}`;
      const use = classifyUses(match[1]);

      if (use.kind === "local") { localCount += 1; continue; }
      if (use.kind === "unsupported") {
        out.push(`${where}: uses: ${JSON.stringify(use.ref ?? match[1].trim())} ${use.reason}.`
          + ` Use owner/repo@<40-hex commit> # vX.Y.Z, or ./path for an action in this repository.`);
        continue;
      }

      remoteCount += 1;
      if (!FULL_SHA.test(use.pin)) {
        out.push(`${where}: ${use.action} is pinned to ${JSON.stringify(use.pin)}, which is not 40`
          + ` lowercase hex characters. A tag or branch is a name upstream can repoint at any commit;`
          + ` pin the commit and put the tag in the trailing comment.`);
        continue;
      }
      if (use.comment === undefined) {
        out.push(`${where}: ${use.action} is pinned to a commit with no trailing "# vX.Y.Z" comment.`
          + ` The SHA is the identity and the comment is how a human reads the diff — add it.`);
        continue;
      }
      if (!VERSION_COMMENT.test(use.comment)) {
        out.push(`${where}: ${use.action}'s trailing comment is ${JSON.stringify(use.comment)},`
          + ` which is not of the form vX.Y.Z. (This gate checks the comment's SHAPE only; it cannot`
          + ` reach the network to confirm the SHA is that release.)`);
        continue;
      }

      // Two majors of one action at two SHAs are FINE and are the real state of
      // actions/upload-artifact here. What is never fine is one action's commit
      // described two ways, or one described version of one action sitting at
      // two SHAs — both mean a bump was applied to some call sites and not
      // others, and the comment has stopped describing the code. Two DIFFERENT
      // actions sharing a commit id is not that, and is not reported.
      const shaKey = `${use.action}@${use.pin}`;
      const seenSha = byActionSha.get(shaKey);
      if (seenSha && seenSha.comment !== use.comment) {
        out.push(`${where}: ${use.action} commit ${use.pin} is commented "# ${use.comment}" here`
          + ` and "# ${seenSha.comment}" at ${seenSha.where}. One commit of one action is one`
          + ` release; one of these comments is wrong.`);
      } else if (!seenSha) {
        byActionSha.set(shaKey, { where, comment: use.comment });
      }

      const versionKey = `${use.action}@${use.comment}`;
      const seenVersion = byVersion.get(versionKey);
      if (seenVersion && seenVersion.pin !== use.pin) {
        out.push(`${where}: ${use.action} ${use.comment} is ${use.pin} here and ${seenVersion.pin}`
          + ` at ${seenVersion.where}. A partially applied bump: pick one commit for this version.`
          + ` (Different MAJORS of one action may legitimately differ.)`);
      } else if (!seenVersion) {
        byVersion.set(versionKey, { where, pin: use.pin });
      }
    }
  }

  // Coverage. A rule whose input set is empty reports nothing and looks green.
  if (remoteCount === 0) {
    out.push(`${WORKFLOW_DIR}/ contains no remote "uses:" references at all. Either every workflow`
      + ` lost its actions, or this gate has stopped finding them — both need a human.`);
  }
  return { remoteCount, localCount };
}

// ---------------------------------------------------------------------------
// 3. Rule 2 — Swift dependency DECLARATIONS
// ---------------------------------------------------------------------------

/**
 * `src` with comments removed, string literals preserved.
 *
 * Necessary rather than tidy: the `dependencies:` block in `Package.swift` is
 * commented with the sentence "Exact, not `from:`", and a `from:` scan over the
 * raw text reports the rationale as the defect. Dropping `//` naively is not an
 * option either — every dependency URL contains one — so this respects quotes.
 */
function stripSwiftComments(src) {
  let out = "";
  let i = 0;
  let inString = false;
  while (i < src.length) {
    const c = src[i];
    if (inString) {
      if (c === "\\") { out += src.slice(i, i + 2); i += 2; continue; }
      if (c === '"') inString = false;
      out += c; i += 1; continue;
    }
    if (c === '"') { inString = true; out += c; i += 1; continue; }
    if (c === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") i += 1;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i += 1;
      i += 2; continue;
    }
    out += c; i += 1;
  }
  return out;
}

/** The balanced `open`…`close` run starting at `from`, or null if unbalanced. */
function balanced(text, from, open, close) {
  let depth = 0;
  for (let i = from; i < text.length; i += 1) {
    if (text[i] === open) depth += 1;
    else if (text[i] === close) {
      depth -= 1;
      if (depth === 0) return { text: text.slice(from, i + 1), end: i + 1 };
    }
  }
  return null;
}

/** Every requirement form that is not a single frozen version. */
const SWIFT_LOOSE_FORMS = [
  ["from:", "a minimum-version range: any newer release satisfies it"],
  ["branch:", "a branch: it moves under every resolve"],
  ["revision:", "a bare revision: use exact: with a released version"],
  [".upToNextMajor", "an up-to-next-major range"],
  [".upToNextMinor", "an up-to-next-minor range"],
  ["..<", "a version range"],
  ["range:", "an explicit range"],
];

function checkPackageSwift(world, out) {
  const path = PACKAGE_SWIFT;
  const raw = world.get(path);
  if (raw === undefined) { out.push(`${path} is missing from the world`); return { external: 0 }; }
  const src = stripSwiftComments(raw);

  // The package-level dependencies array, found by its four-space indent so a
  // target's own `dependencies: [` cannot be mistaken for it.
  const header = /(?:^|\n)[ \t]{4}dependencies:[ \t]*\[/.exec(src);
  if (!header) {
    out.push(`${path}: could not find the package-level "    dependencies: [" block. This gate`
      + ` refuses to report "no unpinned dependencies" for a file it could not parse — fix the`
      + ` block's shape or teach this parser the new one.`);
    return { external: 0 };
  }
  const open = src.indexOf("[", header.index);
  const block = balanced(src, open, "[", "]");
  if (!block) {
    out.push(`${path}: the package-level dependencies array has unbalanced brackets and could not`
      + ` be attributed. Failing closed rather than approving an unparsed block.`);
    return { external: 0 };
  }
  const blockStart = open;
  const blockEnd = open + block.text.length;

  let external = 0;
  let local = 0;
  for (let at = src.indexOf(".package("); at !== -1; at = src.indexOf(".package(", at + 1)) {
    if (at < blockStart || at >= blockEnd) {
      out.push(`${path}: a ".package(" declaration at offset ${at} sits outside the package-level`
        + ` dependencies array this gate attributes. It is therefore unchecked — move it back or`
        + ` extend this parser.`);
      continue;
    }
    const decl = balanced(src, src.indexOf("(", at), "(", ")");
    if (!decl) {
      out.push(`${path}: a ".package(" declaration at offset ${at} has unbalanced parentheses and`
        + ` could not be read.`);
      continue;
    }
    const body = decl.text;
    const url = /url:\s*"([^"]*)"/.exec(body);
    if (!url) {
      if (/\bpath:\s*"/.test(body)) { local += 1; continue; }
      out.push(`${path}: a ".package(" declaration is neither url: nor path: form and cannot be`
        + ` classified: ${JSON.stringify(body.slice(0, 120))}`);
      continue;
    }
    external += 1;

    const loose = SWIFT_LOOSE_FORMS.filter(([token]) => body.includes(token));
    for (const [token, why] of loose) {
      out.push(`${path}: ${url[1]} is declared with "${token}" — ${why}. Every external Swift`
        + ` dependency here must use exact: "X.Y.Z" so a resolve cannot choose a different`
        + ` release on its own. (exact: is a version CONSTRAINT; the 40-hex revision in`
        + ` Package.resolved is what names the commit.)`);
    }
    const exact = /\bexact:\s*"([^"]*)"/.exec(body);
    if (!exact) {
      if (loose.length === 0) {
        out.push(`${path}: ${url[1]} is declared without exact:. Use`
          + ` .package(url: "…", exact: "X.Y.Z").`);
      }
      continue;
    }
    if (!CONCRETE_VERSION.test(exact[1])) {
      out.push(`${path}: ${url[1]} has exact: ${JSON.stringify(exact[1])}, which is not a concrete`
        + ` released version.`);
    }
  }

  if (external === 0) {
    out.push(`${path}: no external ".package(url:" declarations were attributed. This gate's`
      + ` subject has vanished; that is a parser or file change, not a clean bill of health.`);
  }
  return { external, local };
}

/** Requirement kinds an Xcode project may name that are not one frozen version. */
const PBX_LOOSE_KINDS = [
  "upToNextMajorVersion", "upToNextMinorVersion", "versionRange", "branch", "revision",
];

function checkPbxproj(world, out) {
  let refs = 0;
  for (const path of PBXPROJS) {
    const text = world.get(path);
    if (text === undefined) { out.push(`${path} is missing from the world`); continue; }

    // Every declared remote reference in the file, found independently of the
    // section markers, so a block that escaped the section is still counted.
    const declared = (text.match(/isa\s*=\s*XCRemoteSwiftPackageReference\s*;/g) ?? []).length;

    const begin = text.indexOf("/* Begin XCRemoteSwiftPackageReference section */");
    const end = text.indexOf("/* End XCRemoteSwiftPackageReference section */");
    if (begin === -1 || end === -1) {
      // No section is a legitimate state — the iOS project links only local
      // packages — but only if nothing declared one anyway.
      if (declared > 0) {
        out.push(`${path}: ${declared} XCRemoteSwiftPackageReference object(s) exist with no`
          + ` "/* Begin XCRemoteSwiftPackageReference section */" to attribute them to. Failing`
          + ` closed: an unattributed remote package is an unchecked one.`);
      }
      continue;
    }
    if (end < begin) {
      out.push(`${path}: the XCRemoteSwiftPackageReference section markers are inverted;`
        + ` refusing to read it.`);
      continue;
    }
    const section = text.slice(begin, end);

    let found = 0;
    const objectAt = /([A-Za-z0-9_]+)\s*(?:\/\*[^*]*\*\/\s*)?=\s*\{/g;
    let m;
    while ((m = objectAt.exec(section)) !== null) {
      const block = balanced(section, section.indexOf("{", m.index + m[0].length - 1), "{", "}");
      if (!block) {
        out.push(`${path}: the remote package object "${m[1]}" has unbalanced braces and could not`
          + ` be read.`);
        continue;
      }
      if (!/isa\s*=\s*XCRemoteSwiftPackageReference\s*;/.test(block.text)) continue;
      found += 1;
      refs += 1;
      const url = (/repositoryURL\s*=\s*"?([^";\n]+)"?\s*;/.exec(block.text) ?? [, m[1]])[1];

      for (const kind of PBX_LOOSE_KINDS) {
        if (new RegExp(`\\b${kind}\\b`).test(block.text)) {
          out.push(`${path}: the package reference for ${url} uses "${kind}". An Xcode project`
            + ` that ships a signed build must name one version: kind = exactVersion.`);
        }
      }
      if (!/kind\s*=\s*exactVersion\s*;/.test(block.text)) {
        out.push(`${path}: the package reference for ${url} does not declare`
          + ` "kind = exactVersion;".`);
        continue;
      }
      const version = /\bversion\s*=\s*"?([^";\n]+)"?\s*;/.exec(block.text);
      if (!version) {
        out.push(`${path}: the package reference for ${url} is exactVersion with no version =`
          + ` value at all.`);
        continue;
      }
      if (!CONCRETE_VERSION.test(version[1].trim())) {
        out.push(`${path}: the package reference for ${url} has version =`
          + ` ${JSON.stringify(version[1].trim())}, which is not a concrete released version.`);
      }
    }

    if (found !== declared) {
      out.push(`${path}: ${declared} XCRemoteSwiftPackageReference object(s) are declared but`
        + ` ${found} could be attributed inside the section. Failing closed rather than checking`
        + ` only the ones this parser happened to see.`);
    }
  }
  return { refs };
}

// ---------------------------------------------------------------------------
// 4. Rule 3 — Swift RESOLUTIONS
// ---------------------------------------------------------------------------

function checkResolved(world, out) {
  /** identity -> the first file that pinned it, and to what. */
  const seen = new Map();
  let pins = 0;

  for (const path of RESOLVED) {
    const text = world.get(path);
    if (text === undefined) { out.push(`${path} is missing from the world`); continue; }
    let doc;
    try {
      doc = JSON.parse(text);
    } catch (err) {
      out.push(`${path} is not valid JSON (${err.message}). A resolution file that cannot be read`
        + ` cannot be trusted to say what a build fetches.`);
      continue;
    }
    if (!Array.isArray(doc?.pins) || doc.pins.length === 0) {
      // The three files legitimately differ in JSON `version` and in which
      // packages they list — Sparkle is macOS-only — but none of them may be
      // empty, or this rule would approve of a build resolving from nothing.
      out.push(`${path} has no non-empty "pins" array.`);
      continue;
    }
    for (const pin of doc.pins) {
      pins += 1;
      const identity = typeof pin?.identity === "string" ? pin.identity.trim() : "";
      const label = identity === "" ? "<unnamed pin>" : identity;
      if (identity === "") {
        out.push(`${path}: a pin has no non-empty "identity".`);
        continue;
      }
      const state = pin.state ?? {};
      if (typeof state.branch === "string" && state.branch !== "") {
        out.push(`${path}: ${label} is resolved to branch "${state.branch}". A branch is not a`
          + ` resolution; it is a promise to fetch something else later.`);
      }
      const revision = typeof state.revision === "string" ? state.revision : "";
      const version = typeof state.version === "string" ? state.version.trim() : "";
      if (!FULL_SHA.test(revision)) {
        out.push(`${path}: ${label} has revision ${JSON.stringify(revision)}, which is not 40`
          + ` lowercase hex characters.`);
      }
      if (version === "" || !CONCRETE_VERSION.test(version)) {
        out.push(`${path}: ${label} has version ${JSON.stringify(state.version ?? null)}, which is`
          + ` not a concrete released version.`);
      }

      const before = seen.get(identity);
      if (!before) { seen.set(identity, { path, revision, version }); continue; }
      if (before.revision !== revision) {
        out.push(`${path}: ${label} resolves to ${revision || "<none>"} here and`
          + ` ${before.revision || "<none>"} in ${before.path}. The mac app, the iOS app and`
          + ` swift test would compile different code under one version number.`);
      }
      if (before.version !== version) {
        out.push(`${path}: ${label} is version ${JSON.stringify(version)} here and`
          + ` ${JSON.stringify(before.version)} in ${before.path}.`);
      }
    }
  }

  if (pins === 0) out.push(`no Package.resolved pin was read at all; rule 3 checked nothing.`);
  return { pins, identities: seen.size };
}

// ---------------------------------------------------------------------------
// 5. Rule 4 — one Node major
//
// A consistency rule, not a pinning one. `node-version: 24` is a mutable major
// SELECTOR: setup-node resolves the major to whichever matching release is
// available — tool cache or download — so the exact minor and patch move under
// it without any edit here. What this rule buys is that
// every lane moves together — one major across the repository — so a failure
// reproduces in the lane next door instead of being one job's private runtime.
// ---------------------------------------------------------------------------

function checkNodeVersion(world, out) {
  const found = [];
  for (const path of workflowPaths(world)) {
    for (const { text, line } of codeLines(world.get(path))) {
      const match = /^\s*node-version(-file)?:\s*(\S.*?)\s*$/.exec(text);
      if (!match) continue;
      const where = `${path}:${line}`;
      if (match[1]) {
        out.push(`${where}: node-version-file is not covered by this wave's policy. State the`
          + ` numeric major inline so one gate can compare every occurrence.`);
        continue;
      }
      const value = match[2].replace(/\s+#.*$/, "").replace(/^["']|["']$/g, "");
      if (value.includes("${{")) {
        out.push(`${where}: node-version is the expression ${JSON.stringify(value)}. What runs is`
          + ` then decided at run time, and this gate cannot compare it to the others.`);
        continue;
      }
      if (!/^\d+$/.test(value)) {
        out.push(`${where}: node-version is ${JSON.stringify(value)}. This wave requires a bare`
          + ` numeric major (e.g. 24) so one gate can compare every lane to every other. Ranges,`
          + ` "x" wildcards and lts/* aliases are not comparable that way. (No form here pins a`
          + ` patch: setup-node resolves the major to an available matching release.)`);
        continue;
      }
      found.push({ where, value });
    }
  }

  if (found.length === 0) {
    out.push(`no usable node-version was found in ${WORKFLOW_DIR}/. Rule 4 has nothing to compare`
      + ` and would pass regardless of what CI actually runs.`);
    return { count: 0 };
  }
  const [first, ...rest] = found;
  for (const other of rest) {
    if (other.value !== first.value) {
      out.push(`${other.where}: node-version ${other.value} disagrees with ${first.value} at`
        + ` ${first.where}. One major across the repository, or a lane silently tests a runtime`
        + ` no other lane does.`);
    }
  }
  return { count: found.length, major: first.value };
}

// ---------------------------------------------------------------------------
// 6. Rule 5 — the web lockfile
// ---------------------------------------------------------------------------

const REGISTRY = "https://registry.npmjs.org/";

function checkPackageLock(world, out) {
  const path = PACKAGE_LOCK;
  const text = world.get(path);
  if (text === undefined) { out.push(`${path} is missing from the world`); return { entries: 0 }; }
  let lock;
  try {
    lock = JSON.parse(text);
  } catch (err) {
    out.push(`${path} is not valid JSON (${err.message}).`);
    return { entries: 0 };
  }

  if (!Number.isInteger(lock?.lockfileVersion) || lock.lockfileVersion < 3) {
    out.push(`${path}: lockfileVersion is ${JSON.stringify(lock?.lockfileVersion ?? null)};`
      + ` this policy requires an integer >= 3, where "packages" is the authoritative tree.`);
  }
  if (lock?.dependencies !== undefined) {
    out.push(`${path}: a top-level "dependencies" map is present alongside "packages". That is a`
      + ` v1/v2 compatibility shape, and this gate will not guess which of the two an install`
      + ` would honour.`);
  }
  const packages = lock?.packages;
  if (packages === null || typeof packages !== "object" || Array.isArray(packages)) {
    out.push(`${path}: "packages" is not an object; nothing about this lockfile can be checked.`);
    return { entries: 0 };
  }
  const keys = Object.keys(packages);
  if (keys.length === 0) {
    out.push(`${path}: "packages" is empty. An empty lockfile satisfies every rule below and`
      + ` guarantees nothing.`);
    return { entries: 0 };
  }

  let entries = 0;
  for (const key of keys) {
    if (key === "") continue;
    const entry = packages[key];
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      out.push(`${path}: the entry for "${key}" is not an object.`);
      continue;
    }
    // A workspace or file link has no tarball to verify; it is source in this
    // repository, already covered by the commit under test.
    if (entry.link === true) continue;
    entries += 1;

    if (typeof entry.resolved !== "string" || entry.resolved === "") {
      out.push(`${path}: "${key}" has no "resolved" URL and is not a link. Without one there is`
        + ` nothing to constrain, so this is a failure rather than a skip.`);
      continue;
    }
    let url;
    try {
      url = new URL(entry.resolved);
    } catch {
      out.push(`${path}: "${key}" has a malformed resolved URL ${JSON.stringify(entry.resolved)}.`);
      continue;
    }
    if (url.protocol !== "https:" || !entry.resolved.startsWith(REGISTRY)) {
      out.push(`${path}: "${key}" resolves to ${JSON.stringify(entry.resolved)}. Every dependency`
        + ` must come from ${REGISTRY} — a git, file or third-host reference is fetched by rules`
        + ` this lockfile does not record.`);
      continue;
    }
    if (typeof entry.integrity !== "string" || entry.integrity.trim() === "") {
      out.push(`${path}: "${key}" has no "integrity" hash, so npm has nothing to verify the`
        + ` downloaded tarball against.`);
    }
  }

  if (entries === 0) {
    out.push(`${path}: no non-link package entries were checked. Rule 5's subject is empty.`);
  }
  return { entries };
}

// ---------------------------------------------------------------------------
// 7. The whole policy, as one pure function
// ---------------------------------------------------------------------------

/** Every complaint the policy has about `world`, in rule order. */
function policyFailures(world) {
  const out = [];
  checkActionPins(world, out);
  checkPackageSwift(world, out);
  checkPbxproj(world, out);
  checkResolved(world, out);
  checkNodeVersion(world, out);
  checkPackageLock(world, out);
  return out;
}

const world = await readWorld();

// The real repository. Every message is already file-specific and says what to
// do about it, so it is reported verbatim.
for (const failure of policyFailures(world)) check(false, failure);

// Coverage of the real tree, reported for the record and asserted so that a
// world which quietly lost a subject cannot look like a world that passed.
const counts = {
  actions: checkActionPins(world, []),
  swift: checkPackageSwift(world, []),
  pbx: checkPbxproj(world, []),
  resolved: checkResolved(world, []),
  node: checkNodeVersion(world, []),
  lock: checkPackageLock(world, []),
};
check(counts.actions.remoteCount >= 5, `only ${counts.actions.remoteCount} remote action`
  + ` reference(s) found; this repository has many more, so the scanner is not seeing them`);
check(counts.resolved.pins >= 7, `only ${counts.resolved.pins} Swift pin(s) read across the three`
  + ` Package.resolved files`);
check(counts.node.count >= 5, `only ${counts.node.count} node-version value(s) found`);
check(counts.lock.entries >= 50, `only ${counts.lock.entries} locked npm package(s) checked`);

// ---------------------------------------------------------------------------
// 8. The mutations
//
// Each case breaks a copy of the real world in ONE way and requires the specific
// complaint back. Without this section the rules above would report green for a
// repository whose pins had all been replaced by branch names, because a check
// nobody has ever seen fail is a check nobody has evidence works.
//
// `expect` cases are the negative controls, one per rule class and one per
// distinct rejection inside it. `refute` cases are the other obligation: a
// legitimate shape that must NOT be reported. A gate that complains about
// correct code gets widened until it complains about nothing.
// ---------------------------------------------------------------------------

/** A fresh copy of the real world for one mutation to break. */
const realWorld = () => new Map(world);

/**
 * Replace the first occurrence of `from` in one file.
 *
 * Throwing when the anchor is gone is deliberate and is the harness's own
 * safety net: a mutation that silently stopped applying would hand `expect` an
 * UNBROKEN world, the rule would correctly report nothing, and this section
 * would be asserting the opposite of what it claims.
 */
function withText(sources, file, from, to) {
  const text = sources.get(file);
  if (text === undefined) throw new Error(`${file} is not in the world`);
  if (!text.includes(from)) throw new Error(`anchor not found in ${file}: ${JSON.stringify(from)}`);
  sources.set(file, text.replace(from, to));
  return sources;
}

/** Replace every occurrence of `from` in every file; throws if it matched none. */
function withEveryText(sources, from, to) {
  let hits = 0;
  for (const [file, text] of sources) {
    if (!text.includes(from)) continue;
    hits += 1;
    sources.set(file, text.split(from).join(to));
  }
  if (hits === 0) throw new Error(`anchor not found anywhere: ${JSON.stringify(from)}`);
  return sources;
}

const HYGIENE = `${WORKFLOW_DIR}/repo-hygiene.yml`;
const WEB = `${WORKFLOW_DIR}/web.yml`;
const CHECKOUT = "actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd # v6.0.2";
const IOS_RESOLVED = RESOLVED[2];

const MUTATIONS = [
  // --- Rule 1: action references ---
  {
    name: "an action is pinned to a tag instead of a commit",
    mutate: (s) => withText(s, HYGIENE, CHECKOUT, "actions/checkout@v6 # v6.0.2"),
    expect: /pinned to "v6", which is not 40 lowercase hex/,
  },
  {
    name: "an action is pinned to a branch",
    mutate: (s) => withText(s, HYGIENE, CHECKOUT, "actions/checkout@main # v6.0.2"),
    expect: /pinned to "main", which is not 40 lowercase hex/,
  },
  {
    name: "an action's SHA is uppercased",
    mutate: (s) => withText(
      s, HYGIENE, CHECKOUT,
      "actions/checkout@DE0FAC2E4500DABE0009E67214FF5F5447CE83DD # v6.0.2",
    ),
    expect: /which is not 40\n?\s*lowercase hex/,
  },
  {
    name: "an action's SHA is one character short",
    mutate: (s) => withText(s, HYGIENE, CHECKOUT,
      "actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83d # v6.0.2"),
    expect: /not 40\n?\s*lowercase hex/,
  },
  {
    name: "the human-readable version comment is dropped",
    mutate: (s) => withText(s, HYGIENE, CHECKOUT,
      "actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd"),
    expect: /no trailing "# vX\.Y\.Z" comment/,
  },
  {
    name: "the version comment is prose rather than a version",
    mutate: (s) => withText(s, HYGIENE, CHECKOUT,
      "actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd # latest"),
    expect: /trailing comment is "latest", which is not of the form vX\.Y\.Z/,
  },
  {
    name: "an action is referenced with no ref at all",
    mutate: (s) => withText(s, HYGIENE, CHECKOUT, "actions/checkout # v6.0.2"),
    expect: /names no ref at all \(an unpinned action\)/,
  },
  {
    name: "an action reference is not owner/repo@ref at all",
    mutate: (s) => withText(s, HYGIENE, CHECKOUT,
      "actions@de0fac2e4500dabe0009e67214ff5f5447ce83dd # v6.0.2"),
    expect: /is not owner\/repo\[\/path\]@ref/,
  },
  {
    name: "a docker:// action reference appears",
    mutate: (s) => withText(s, HYGIENE, CHECKOUT, "docker://alpine:3.20"),
    expect: /is a docker:\/\/ reference, which this policy does not cover/,
  },
  {
    name: "the SAME action's commit is given two different version comments",
    mutate: (s) => withText(s, WEB, CHECKOUT,
      "actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd # v5.0.0"),
    expect: /actions\/checkout commit de0fac2e\w+ is commented "# v5\.0\.0" here and "# v6\.0\.2"/,
  },
  {
    // The other half of the same key. A Git object name is unique within one
    // repository, not across GitHub: two unrelated action repositories can hold
    // a commit with the same id, and each is entitled to its own release name.
    // Keyed by the bare SHA this would be reported as "one of these comments is
    // wrong" about two references that are both correct — the false complaint
    // that gets a gate deleted rather than fixed.
    name: "two DIFFERENT actions share one commit id under different versions — legitimate",
    mutate: (s) => withText(
      s, HYGIENE,
      `      - uses: ${CHECKOUT}\n`,
      `      - uses: ${CHECKOUT}\n`
      + "      - uses: example-org/example-action"
      + "@de0fac2e4500dabe0009e67214ff5f5447ce83dd # v1.4.0\n",
    ),
    refute: /commit de0fac2e\w+ is commented/,
  },
  {
    name: "one action version is pinned to two different commits (a half-applied bump)",
    mutate: (s) => withText(s, WEB, CHECKOUT,
      "actions/checkout@0000000000000000000000000000000000000001 # v6.0.2"),
    expect: /actions\/checkout v6\.0\.2 is 0{39}1 here and de0fac2e/,
  },
  {
    name: "a SECOND MAJOR of an action is added at its own commit — legitimate",
    mutate: (s) => withText(
      s, HYGIENE,
      `      - uses: ${CHECKOUT}\n`,
      `      - uses: ${CHECKOUT}\n`
      + "      - uses: actions/checkout@0000000000000000000000000000000000000002 # v5.0.0\n",
    ),
    refute: /actions\/checkout/,
  },

  // --- Rule 2: Swift declarations ---
  {
    name: "a Swift dependency moves from exact: to from:",
    mutate: (s) => withText(s, PACKAGE_SWIFT, 'swift-sodium.git", exact: "0.11.0"',
      'swift-sodium.git", from: "0.11.0"'),
    expect: /swift-sodium\.git is declared with "from:"/,
  },
  {
    name: "a Swift dependency moves to a branch",
    mutate: (s) => withText(s, PACKAGE_SWIFT, 'WebRTC.git", exact: "150.0.0"',
      'WebRTC.git", branch: "latest"'),
    expect: /WebRTC\.git is declared with "branch:"/,
  },
  {
    name: "a Swift dependency moves to an up-to-next-major range",
    mutate: (s) => withText(s, PACKAGE_SWIFT, 'swift-sodium.git", exact: "0.11.0"',
      'swift-sodium.git", .upToNextMajor(from: "0.11.0")'),
    expect: /swift-sodium\.git is declared with "\.upToNextMajor"/,
  },
  {
    name: "the package-level dependencies block can no longer be attributed",
    mutate: (s) => withText(s, PACKAGE_SWIFT, "\n    dependencies: [", "\n    deps: ["),
    expect: /could not find the package-level "    dependencies: \[" block/,
  },
  {
    name: "the Xcode project's package reference becomes a major range",
    mutate: (s) => withText(s, PBXPROJS[0], "kind = exactVersion;", "kind = upToNextMajorVersion;"),
    expect: /uses "upToNextMajorVersion"/,
  },
  {
    name: "the Xcode project's package reference becomes a branch",
    mutate: (s) => withText(s, PBXPROJS[0], "\t\t\t\tkind = exactVersion;\n\t\t\t\tversion = 2.9.4;",
      "\t\t\t\tbranch = main;\n\t\t\t\tkind = branch;"),
    expect: /does not declare\n?\s*"kind = exactVersion;"/,
  },
  {
    name: "the Xcode project pins a version that is not a version",
    mutate: (s) => withText(s, PBXPROJS[0], "version = 2.9.4;", 'version = "latest";'),
    expect: /has version =\n?\s*"latest", which is not a concrete released version/,
  },
  {
    name: "a remote package reference escapes the section this gate attributes",
    mutate: (s) => withText(
      s, PBXPROJS[0],
      "/* End XCRemoteSwiftPackageReference section */",
      "/* End XCRemoteSwiftPackageReference section */\n"
      + "\t\tA1000000000000000000FFFF = {\n\t\t\tisa = XCRemoteSwiftPackageReference;\n"
      + "\t\t\trepositoryURL = \"https://example.invalid/x\";\n\t\t};",
    ),
    expect: /2 XCRemoteSwiftPackageReference object\(s\) are declared but 1 could be attributed/,
  },

  // --- Rule 3: Swift resolutions ---
  {
    name: "a resolved revision is truncated",
    mutate: (s) => withText(s, RESOLVED[0], '"revision" : "cfd195c76882aa9b997560ca7cb95d72fbf5db00"',
      '"revision" : "cfd195c"'),
    expect: /swift-sodium has revision "cfd195c", which is not 40/,
  },
  {
    name: "a resolved pin names a branch instead of a version",
    mutate: (s) => withText(s, RESOLVED[0], '"version" : "150.0.0"', '"branch" : "main"'),
    expect: /webrtc is resolved to branch "main"/,
  },
  {
    name: "the mac and iOS projects resolve one identity to different commits",
    mutate: (s) => withText(s, IOS_RESOLVED, '"revision" : "6ed87f05368632f71dc95c89c14c051561710925"',
      '"revision" : "0000000000000000000000000000000000000003"'),
    expect: /webrtc resolves to \w+ here and \w+ in apps\/(mac|RelayiumKit)/,
  },
  {
    name: "the mac and iOS projects disagree about one identity's version",
    mutate: (s) => withText(s, IOS_RESOLVED, '"version" : "0.11.0"', '"version" : "0.12.0"'),
    expect: /swift-sodium is version "0\.12\.0" here and "0\.11\.0" in/,
  },
  {
    name: "a Package.resolved stops being JSON",
    mutate: (s) => withText(s, IOS_RESOLVED, '"pins" : [', '"pins" : ['.repeat(2)),
    expect: /Package\.resolved is not valid JSON/,
  },
  {
    name: "Sparkle stays macOS-only and the three files are not identical — legitimate",
    mutate: (s) => new Map(s),
    refute: /sparkle/i,
  },

  // --- Rule 4: node major ---
  {
    name: "one lane is left behind on an older Node major",
    mutate: (s) => withText(s, WEB, "node-version: 24", "node-version: 22"),
    expect: /node-version 22 disagrees with 24 at/,
  },
  {
    name: "node-version becomes a workflow expression",
    mutate: (s) => withText(s, WEB, "node-version: 24", "node-version: ${{ inputs.node }}"),
    expect: /node-version is the expression/,
  },
  {
    name: "node-version becomes an lts alias",
    mutate: (s) => withText(s, WEB, "node-version: 24", "node-version: lts/*"),
    expect: /node-version is "lts\/\*"/,
  },
  {
    name: "node-version becomes a wildcard range",
    mutate: (s) => withText(s, WEB, "node-version: 24", "node-version: 24.x"),
    expect: /node-version is "24\.x"/,
  },
  {
    name: "every node-version is replaced by a version file",
    mutate: (s) => withEveryText(s, "node-version: 24", "node-version-file: .nvmrc"),
    expect: /node-version-file is not covered by this wave's policy/,
  },
  {
    name: "every node-version disappears",
    mutate: (s) => withEveryText(s, "node-version: 24", "check-latest: true"),
    expect: /no usable node-version was found/,
  },

  // --- Rule 5: the web lockfile ---
  {
    name: "the lockfile drops to version 2",
    mutate: (s) => withText(s, PACKAGE_LOCK, '"lockfileVersion": 3', '"lockfileVersion": 2'),
    expect: /lockfileVersion is 2; this policy requires an integer >= 3/,
  },
  {
    name: "a package is resolved from a host that is not the npm registry",
    mutate: (s) => withText(s, PACKAGE_LOCK, '"resolved": "https://registry.npmjs.org/',
      '"resolved": "https://registry.example.invalid/'),
    expect: /resolves to "https:\/\/registry\.example\.invalid\//,
  },
  {
    name: "a package is resolved from git",
    mutate: (s) => withText(s, PACKAGE_LOCK, '"resolved": "https://registry.npmjs.org/',
      '"resolved": "git+ssh://git@github.com/'),
    expect: /resolves to "git\+ssh:\/\//,
  },
  {
    name: "a resolved URL is malformed",
    mutate: (s) => withText(s, PACKAGE_LOCK, '"resolved": "https://registry.npmjs.org/',
      '"resolved": "not a url '),
    expect: /has a malformed resolved URL/,
  },
  {
    name: "a locked package loses its resolved URL entirely",
    mutate: (s) => withText(s, PACKAGE_LOCK, '"resolved": "https://registry.npmjs.org/',
      '"resolvedX": "https://registry.npmjs.org/'),
    expect: /has no "resolved" URL and is not a link/,
  },
  {
    name: "a package loses its integrity hash",
    mutate: (s) => withText(s, PACKAGE_LOCK, '"integrity": "sha512-', '"integrityX": "sha512-'),
    expect: /has no "integrity" hash/,
  },
  {
    name: "the packages map is emptied",
    mutate: (s) => {
      const lock = JSON.parse(s.get(PACKAGE_LOCK));
      lock.packages = {};
      s.set(PACKAGE_LOCK, JSON.stringify(lock, null, 2));
      return s;
    },
    expect: /"packages" is empty/,
  },
  {
    name: "a v1-style top-level dependencies map is reintroduced",
    mutate: (s) => withText(s, PACKAGE_LOCK, '"packages": {', '"dependencies": {},\n  "packages": {'),
    expect: /a top-level "dependencies" map is present alongside "packages"/,
  },
];

// The positive control. The mutation plumbing copies the world and the rules
// read from that copy; if the copying itself corrupted anything, every `expect`
// below would still pass — for the wrong reason. So the un-mutated copy is run
// through the same path first and must be silent.
{
  const control = policyFailures(realWorld());
  check(
    control.length === 0,
    `the positive control failed: an UNMUTATED copy of the real world produced`
    + ` ${control.length} complaint(s):\n    ${control.join("\n    ")}\n  Either the repository`
    + ` violates the policy (the failures above say how) or the mutation harness's copy of it is`
    + ` broken, and in the second case every mutation result below is meaningless.`,
  );
}

let asserted = 0;
for (const { name, mutate, expect, refute } of MUTATIONS) {
  let got;
  try {
    got = policyFailures(mutate(realWorld()));
  } catch (err) {
    // Includes a missing anchor. A mutation that no longer applies is a broken
    // harness, and a broken harness must be loud rather than green.
    check(false, `the dependency-pinning mutation "${name}" threw instead of reporting:`
      + ` ${err.message}`);
    continue;
  }
  const rendered = got.length === 0 ? "no failures at all" : `[\n    ${got.join("\n    ")}\n  ]`;
  if (expect) {
    asserted += 1;
    check(
      got.some((message) => expect.test(message)),
      `the dependency policy did NOT complain about "${name}". Expected a message matching`
      + ` ${expect}; got ${rendered}. A rule that cannot fail for the reason it was written is not`
      + ` a rule, and this one would report green while the pin it names is already gone.`,
    );
  }
  if (refute) {
    asserted += 1;
    check(
      !got.some((message) => refute.test(message)),
      `the dependency policy complained about "${name}", which is a legitimate shape. Expected NO`
      + ` message matching ${refute}; got ${rendered}. False complaints cost what missing ones do,`
      + ` one step later: they are what gets a gate widened until it says nothing.`,
    );
  }
  if (!expect && !refute) {
    check(false, `the mutation "${name}" asserts neither expect nor refute`);
  }
}

if (failures.length > 0) {
  for (const failure of failures) process.stderr.write(`FAIL: ${failure}\n`);
  process.stderr.write(`\n${failures.length} dependency-pinning assertion(s) failed\n`);
  process.exit(1);
}

process.stdout.write(
  `ok: ${counts.actions.remoteCount} remote action reference(s) across`
  + ` ${workflowPaths(world).length} workflows are full-SHA pinned with shaped version comments`
  + ` (${counts.actions.localCount} local), ${counts.swift.external} Swift package(s) are exact:,`
  + ` ${counts.pbx.refs} Xcode remote reference(s) are exactVersion, ${counts.resolved.pins} pin(s)`
  + ` over ${counts.resolved.identities} identity(ies) agree across ${RESOLVED.length}`
  + ` Package.resolved files, ${counts.node.count} node-version value(s) are all`
  + ` ${counts.node.major}, and ${counts.lock.entries} locked npm package(s) come from`
  + ` ${REGISTRY} with integrity — and ${asserted} mutation assertion(s) prove each of those`
  + ` can fail\n`,
);

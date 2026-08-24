// web/scripts/macos-release-candidate.test.mjs — the four ways a macOS
// publication has actually gone wrong, driven directly.
//
// Two releases failed the same way. Run 31931451292 built, signed, notarized and
// stapled 1.2.5, created the immutable `macos-v1.2.5` GitHub Release, and only
// THEN ran the web suite against a tree whose manifest said 1.2.5 while the
// READMEs, the release-page source and the generated English and Simplified
// Chinese pages still said 1.2.4. The suite failed, as it should have — but the
// release was already public and permanent, and recovering it took a separate
// hand-assembled commit. The 1.2.4 release before it failed the same way.
//
// So the cases below are not hypothetical. Each one is a state a real
// publication reached:
//
//   1. The prose bump itself — including the two sentences that must NOT move.
//   2. A README that stayed behind while the manifest advanced.
//   3. A maintained generated page that was never regenerated.
//   4. A frozen locale that `gen-pages.mjs` quietly dragged onto the new URL.
//
// The bump is exercised against the repository's REAL documents rather than a
// fixture. A fixture would drift from the sentences it stands for, and the whole
// defect class here is a guard that kept passing while the thing it guarded
// moved on.

import { readFile, writeFile, mkdtemp, mkdir, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CANDIDATE_PATHS,
  FROZEN_PAGE_PREFIXES,
  MAINTAINED_GENERATED_PAGES,
  RELEASE_DOCS,
  bumpReleaseDocs,
  checkCandidateScope,
  cliReleasesFromTagTable,
  syncCliReleaseHistory,
} from "./macos-release-candidate.mjs";

const repoRoot = resolve(process.cwd(), "..");

const { macos } = JSON.parse(
  await readFile(resolve(process.cwd(), "native-releases.json"), "utf8"),
);
/** The version currently published, which is what a bump starts FROM. */
const PUBLISHED = macos.version;
/** A version that is not published anywhere, which is what it moves TO. */
const NEXT = "9.9.9";

/** A throwaway copy of the three release documents, so the real ones are never
 *  written by a test run. */
async function stagedDocs() {
  const root = await mkdtemp(resolve(tmpdir(), "relayium-release-candidate-"));
  for (const doc of RELEASE_DOCS) {
    const destination = resolve(root, doc);
    await mkdir(dirname(destination), { recursive: true });
    await cp(resolve(repoRoot, doc), destination);
  }
  return root;
}

const macTags = (text) => new Set([...text.matchAll(/macos-v[0-9]+(?:\.[0-9]+){1,2}/g)].map((m) => m[0]));

describe("bumping the documents that name the published macOS release", () => {
  it("moves every release claim in all three documents", async () => {
    const root = await stagedDocs();
    const { changed } = await bumpReleaseDocs({ repoRoot: root, from: PUBLISHED, to: NEXT });
    expect(changed).toEqual(RELEASE_DOCS);

    for (const doc of ["README.md", "apps/README.md"]) {
      const text = await readFile(resolve(root, doc), "utf8");
      expect(text, `${doc} does not name the new release tag`).toContain(`macos-v${NEXT}`);
      // Every link, not merely one. A bump that moved four of five would pass a
      // containment check and then fail publication: `MacSurfaceGuardTests`
      // requires the current tag and `repository-status.test.mjs` requires that
      // no superseded one is left beside it.
      expect(text, `${doc} still links the superseded release`)
        .not.toContain(`macos-v${PUBLISHED}`);
    }

    // README.md is held to set equality by `repository-status.test.mjs`: it is
    // the front door, and a reader who finds two tags there cannot tell which
    // download is current. apps/README.md is deliberately NOT — it carries
    // historical narrative that cites `macos-v1.0` on purpose, and the Swift
    // guard asks it only to name the current tag.
    expect(macTags(await readFile(resolve(root, "README.md"), "utf8")))
      .toEqual(new Set([`macos-v${NEXT}`]));
  });

  it("moves the status sentence, whose version ends in a full stop", async () => {
    // `**Status: released as 1.2.4.**` — the dot after the patch number is the
    // end of the sentence, not a fourth version component. An earlier lookahead
    // of `(?![0-9.])` treated it as one and skipped this line, which left
    // apps/README.md's headline status a whole release behind while every other
    // sentence in the same file moved. It is asserted on its own because it is
    // the one occurrence whose surrounding punctuation differs.
    const root = await stagedDocs();
    await bumpReleaseDocs({ repoRoot: root, from: PUBLISHED, to: NEXT });
    const text = await readFile(resolve(root, "apps/README.md"), "utf8");
    expect(text).toContain(`**Status: released as ${NEXT}.**`);
    expect(text).not.toContain(`released as ${PUBLISHED}.`);
  });

  it("does not rewrite the independently versioned Mac App Store claim", async () => {
    // The root README is a concise public overview now. It must preserve the
    // channel boundary without carrying internal App Store package history.
    // If a detailed document does name such a package, a Developer ID release
    // bump must still leave that independently versioned claim untouched.
    const root = await stagedDocs();
    const before = await readFile(resolve(repoRoot, "README.md"), "utf8");
    const appStoreClaims = (text) => [...text.matchAll(/1\.3\.1[^\n]*Mac App Store|Mac App Store[^\n]*1\.3\.1/g)].map((m) => m[0]);
    expect(before).toContain("apps.apple.com/app/id6801142976");
    expect(appStoreClaims(before).length).toBeGreaterThan(0);

    await bumpReleaseDocs({ repoRoot: root, from: PUBLISHED, to: NEXT });
    const after = await readFile(resolve(root, "README.md"), "utf8");
    expect(appStoreClaims(after)).toEqual(appStoreClaims(before));
    expect(after).toContain("apps.apple.com/app/id6801142976");
  });

  it("refuses a document that no longer names the published release", async () => {
    // A no-op is the dangerous answer here. If the prose drifted off the
    // published version at some earlier point, "nothing to replace" would hand
    // the publication step a candidate that is incomplete in precisely the way
    // that made both failed releases unrecoverable — and it would do it
    // silently.
    const root = await stagedDocs();
    await writeFile(resolve(root, "README.md"), "# Relayium\n\nNo version here.\n", "utf8");
    await expect(bumpReleaseDocs({ repoRoot: root, from: PUBLISHED, to: NEXT }))
      .rejects.toThrow(/README\.md names no published macOS release/);
  });

  it("writes nothing when a later document refuses", async () => {
    // The refusal above is only useful if it leaves the tree alone. README.md is
    // rewritten first and `content/releases.mjs` is checked last, so a naive
    // write-as-you-go loop would leave two of three documents bumped and the
    // publication step staring at a half-moved tree.
    const root = await stagedDocs();
    const before = await readFile(resolve(root, "README.md"), "utf8");
    await writeFile(
      resolve(root, "web/scripts/pages/content/releases.mjs"),
      "export default { langs: {} };\n",
      "utf8",
    );
    await expect(bumpReleaseDocs({ repoRoot: root, from: PUBLISHED, to: NEXT })).rejects.toThrow();
    expect(await readFile(resolve(root, "README.md"), "utf8")).toBe(before);
  });

  it("refuses to bump a version onto itself", async () => {
    const root = await stagedDocs();
    await expect(bumpReleaseDocs({ repoRoot: root, from: PUBLISHED, to: PUBLISHED }))
      .rejects.toThrow(/already/);
  });

  it("does not touch a version that is a prefix or suffix of another", async () => {
    const root = await stagedDocs();
    await writeFile(
      resolve(root, "README.md"),
      `macos-v${PUBLISHED} and ${PUBLISHED}1 and ${PUBLISHED}.7 and 11${PUBLISHED}\n`,
      "utf8",
    );
    await bumpReleaseDocs({ repoRoot: root, from: PUBLISHED, to: NEXT, docs: ["README.md"] });
    expect(await readFile(resolve(root, "README.md"), "utf8"))
      .toBe(`macos-v${NEXT} and ${PUBLISHED}1 and ${PUBLISHED}.7 and 11${PUBLISHED}\n`);
  });
});

describe("synchronizing immutable CLI tags into the public release ledger", () => {
  const tags = [
    "macos-v1.3.2\t2026-08-24",
    "v0.22.2\t2026-08-24",
    "v0.22.10\t2026-08-24",
    "v0.21.0\t2026-08-17",
    "vmacos-v1.2.0\t2026-08-12",
  ].join("\n");

  it("keeps only CLI tags and sorts same-day versions numerically", () => {
    expect(cliReleasesFromTagTable(tags)).toEqual([
      { version: "v0.22.10", date: "2026-08-24" },
      { version: "v0.22.2", date: "2026-08-24" },
      { version: "v0.21.0", date: "2026-08-17" },
    ]);
  });

  it("rewrites exactly the canonical release block and is idempotent", async () => {
    const root = await stagedDocs();
    const first = await syncCliReleaseHistory({ repoRoot: root, tagTable: tags });
    expect(first.changed).toBe(true);
    const once = await readFile(resolve(root, "web/scripts/pages/content/releases.mjs"), "utf8");
    expect(once).toContain('{ version: "v0.22.10", date: "2026-08-24" }');
    expect(once).not.toContain('{ version: "macos-v1.3.2"');
    const second = await syncCliReleaseHistory({ repoRoot: root, tagTable: tags });
    expect(second.changed).toBe(false);
    expect(await readFile(resolve(root, "web/scripts/pages/content/releases.mjs"), "utf8")).toBe(once);
  });
});

describe("judging an assembled release candidate by what it changes", () => {
  const complete = () => [...CANDIDATE_PATHS];

  it("accepts the complete candidate", () => {
    expect(checkCandidateScope(complete()).ok).toBe(true);
  });

  it("rejects a candidate whose README stayed behind", () => {
    // The observed failure, reduced to its path set: run 31931451292 delivered
    // `web/native-releases.json` and the appcast and nothing else.
    const partial = ["web/native-releases.json", "web/public/apps/macos/appcast.xml"];
    const result = checkCandidateScope(partial);
    expect(result.ok).toBe(false);
    expect(result.missing).toContain("README.md");
    expect(result.missing).toContain("apps/README.md");
    expect(result.problems.join("\n")).toMatch(/incomplete/);
  });

  it("rejects a candidate that left the native client policy behind", () => {
    // The policy's `latestVersion` moves with the release. A candidate without
    // it publishes a version that every installed client still believes is not
    // the latest — the same shape of failure as a stale README, and with the
    // same absence of anything that would notice.
    for (const path of ["web/native-client-policy.json",
                        "web/public/apps/macos/client-policy.json"]) {
      const result = checkCandidateScope(complete().filter((candidate) => candidate !== path));
      expect(result.ok, `${path} may be omitted`).toBe(false);
      expect(result.missing).toEqual([path]);
    }
  });

  it("rejects a candidate whose maintained pages were never regenerated", () => {
    // `content/releases.mjs` corrected and `npm run gen:pages` forgotten leaves
    // the source truthful and the bytes a reader fetches still lying.
    for (const page of MAINTAINED_GENERATED_PAGES) {
      const result = checkCandidateScope(complete().filter((path) => path !== page));
      expect(result.ok, `${page} may be omitted`).toBe(false);
      expect(result.missing).toEqual([page]);
    }
  });

  it("rejects a candidate that moved an archived locale", () => {
    // `gen-pages.mjs` rewrites all nine `/apps` pages from the manifest, so an
    // ordinary regeneration drags the seven frozen locales onto the new download
    // URL. They are archived translations: they keep the version they were
    // published with. The publication step restores them, and this is the check
    // that proves the restore actually happened.
    for (const prefix of FROZEN_PAGE_PREFIXES) {
      const mutated = `${prefix}apps/index.html`;
      const result = checkCandidateScope([...complete(), mutated]);
      expect(result.ok, `${mutated} may be rewritten`).toBe(false);
      expect(result.frozen).toEqual([mutated]);
      expect(result.problems.join("\n")).toMatch(/byte-for-byte/);
    }
  });

  it("rejects unrelated work riding along in the release commit", () => {
    const result = checkCandidateScope([...complete(), "server/account/files.go"]);
    expect(result.ok).toBe(false);
    expect(result.unexpected).toEqual(["server/account/files.go"]);
  });

  it("names every required path, so an empty candidate cannot pass", () => {
    const result = checkCandidateScope([]);
    expect(result.ok).toBe(false);
    expect(result.missing).toEqual(CANDIDATE_PATHS);
  });
});

describe("re-running publication after the metadata already landed", () => {
  // Recovering a delivery that failed AFTER the immutable release was created
  // means re-running the publish job against a main that already carries the
  // commit. The rule inverts: the complete candidate is now the empty one.

  it("accepts a re-derivation that reproduces main exactly", () => {
    expect(checkCandidateScope([], { alreadyDelivered: true }).ok).toBe(true);
  });

  it("rejects a re-derivation that is not reproducible", () => {
    // Anything at all. If re-assembling the same version from the same artifact
    // against a main that already documents it produces a difference, the
    // assembly is not deterministic — and pushing it would put a second,
    // unreviewed commit on top of a release that is already public.
    const result = checkCandidateScope(["web/native-releases.json"], { alreadyDelivered: true });
    expect(result.ok).toBe(false);
    expect(result.unexpected).toEqual(["web/native-releases.json"]);
    expect(result.problems.join("\n")).toMatch(/must change nothing/);
  });

  it("still refuses an archived locale that moved", () => {
    const result = checkCandidateScope(["web/public/de/apps/index.html"], { alreadyDelivered: true });
    expect(result.ok).toBe(false);
  });
});

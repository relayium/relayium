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
//   4. A frozen locale page that `gen-pages.mjs` quietly rewrote — every
//      archived path except the seven `/apps` twins, whose macOS download URL
//      the manifest owns and whose absence is now failure 3 in another costume.
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
  ARCHIVED_APP_PAGES,
  CANDIDATE_PATHS,
  FROZEN_PAGE_PREFIXES,
  MAC_APP_STORE_RELEASE_DOC,
  MAINTAINED_GENERATED_PAGES,
  OPTIONAL_GENERATED_PAGES,
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

/**
 * The OTHER published macOS channel, which a Developer ID bump must never move.
 *
 * As of 2026-08-26 the two channels are at the SAME version — 1.3.8 on both —
 * and that is precisely why this file grew the cases below. While the App Store
 * literal was a stale 1.3.1 the version pattern could not reach it by accident;
 * now every occurrence of `PUBLISHED` in the READMEs is ambiguous, and a blind
 * rewrite turns "the App Store is at 1.3.8", which is true, into "the App Store
 * is at 1.3.9", which is a public claim about a build Apple has never reviewed.
 */
const APP_STORE = JSON.parse(
  await readFile(resolve(process.cwd(), "mac-app-store-release.json"), "utf8"),
);

/** A throwaway copy of the release documents and the App Store record they are
 *  checked against, so the real ones are never written by a test run. */
async function stagedDocs({ appStore = APP_STORE } = {}) {
  const root = await mkdtemp(resolve(tmpdir(), "relayium-release-candidate-"));
  for (const doc of RELEASE_DOCS) {
    const destination = resolve(root, doc);
    await mkdir(dirname(destination), { recursive: true });
    await cp(resolve(repoRoot, doc), destination);
  }
  if (appStore) {
    await writeFile(
      resolve(root, MAC_APP_STORE_RELEASE_DOC),
      `${JSON.stringify(appStore, null, 2)}\n`,
      "utf8",
    );
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
    // THE regression this file exists to hold, and the reason it is no longer
    // theoretical. The App Store literal used to be 1.3.1 while the direct
    // download was 1.3.8, so the version pattern could not reach it however
    // blunt it was. Both channels are at 1.3.8 now, which means every occurrence
    // of `PUBLISHED` in these documents is ambiguous and only the App Store LINK
    // distinguishes the one sentence that must not move.
    //
    // Every claim is compared, in both documents, before and after. A bump that
    // moved one of the root README's two would still leave the other correct and
    // read as green under a containment check.
    expect(APP_STORE.version, "the collision this test is about no longer holds")
      .toBe(PUBLISHED);
    const root = await stagedDocs();
    const claims = (text) =>
      [...text.matchAll(new RegExp(`\\[[^\\]]*\\]\\(${APP_STORE.url.replace(/[.?*+^$[\]\\(){}|/-]/g, "\\$&")}\\)`, "g"))]
        .map((m) => m[0]);

    const before = {};
    for (const doc of ["README.md", "apps/README.md"]) {
      before[doc] = claims(await readFile(resolve(repoRoot, doc), "utf8"));
      expect(before[doc].length, `${doc} carries no App Store claim to protect`)
        .toBeGreaterThan(0);
      for (const claim of before[doc]) {
        expect(claim, `${doc}'s App Store claim does not name a version`)
          .toContain(APP_STORE.version);
      }
    }

    await bumpReleaseDocs({ repoRoot: root, from: PUBLISHED, to: NEXT });

    for (const doc of ["README.md", "apps/README.md"]) {
      const after = await readFile(resolve(root, doc), "utf8");
      expect(claims(after), `${doc}'s App Store claim followed the Developer ID bump`)
        .toEqual(before[doc]);
      expect(after, `${doc} lost the App Store product link`).toContain(APP_STORE.url);
      // And the direct claim really did move, so the assertion above is not
      // passing because the bump did nothing at all.
      expect(after, `${doc} did not move the Developer ID claim`)
        .toContain(`macos-v${NEXT}`);
    }
  });

  it("refuses a tree with no canonical App Store record", async () => {
    // Fail closed. Without the record there is no way to tell which occurrences
    // of `from` name the App Store, so the only safe answer is to refuse — a
    // best-effort bump here is exactly the silent rewrite the case above
    // forbids, arrived at by omission instead of by a bad pattern.
    const root = await stagedDocs({ appStore: null });
    await expect(bumpReleaseDocs({ repoRoot: root, from: PUBLISHED, to: NEXT }))
      .rejects.toThrow(/mac-app-store-release\.json/);
  });

  it("refuses a tree whose App Store record is malformed", async () => {
    const root = await stagedDocs({ appStore: { ...APP_STORE, version: "latest" } });
    await expect(bumpReleaseDocs({ repoRoot: root, from: PUBLISHED, to: NEXT }))
      .rejects.toThrow(/version/);
  });

  it("refuses a document whose App Store claim has drifted off the record", async () => {
    // The claim is a LINK, and its text has to name the version the record
    // says is live. A README stuck at a superseded App Store version would be
    // protected from the bump and left wrong — protected staleness is still
    // staleness, and this is the state the repository was actually in.
    const root = await stagedDocs({ appStore: { ...APP_STORE, version: "1.4.0" } });
    await expect(bumpReleaseDocs({ repoRoot: root, from: PUBLISHED, to: NEXT }))
      .rejects.toThrow(/Mac App Store release 1\.4\.0/);
  });

  it("refuses a document that lost its App Store claim entirely", async () => {
    const root = await stagedDocs();
    const readme = await readFile(resolve(root, "README.md"), "utf8");
    await writeFile(
      resolve(root, "README.md"),
      readme.replaceAll(APP_STORE.url, "https://relayium.com/apps"),
      "utf8",
    );
    await expect(bumpReleaseDocs({ repoRoot: root, from: PUBLISHED, to: NEXT }))
      .rejects.toThrow(/README\.md carries no Mac App Store release claim/);
  });

  it("refuses an App Store version written outside its link", async () => {
    // The protection is span-based: the version is safe because it sits inside
    // `[…](https://apps.apple.com/app/id…)`. A sentence that names the App Store
    // version in bare prose is therefore INVISIBLE to it and would be rewritten
    // — so writing one is refused rather than silently mishandled, which is the
    // whole difference between a guard and a hope.
    const root = await stagedDocs();
    const readme = await readFile(resolve(root, "README.md"), "utf8");
    await writeFile(
      resolve(root, "README.md"),
      `${readme}\nThe Mac App Store build is ${APP_STORE.version} today.\n`,
      "utf8",
    );
    await expect(bumpReleaseDocs({ repoRoot: root, from: PUBLISHED, to: NEXT }))
      .rejects.toThrow(/outside a Mac App Store link/);
  });

  it("refuses a release-history module that restates the App Store version", async () => {
    // The nine-locale document is protected by DERIVING the value, not by a
    // carve-out: `。` is not `. `, so a Chinese sentence carrying the direct tag
    // and the App Store claim is one unsplittable segment and the link-span
    // logic has nothing to grip. Inlining the number back is therefore refused
    // outright, because from there the next bump reaches it.
    const root = await stagedDocs();
    const doc = "web/scripts/pages/content/releases.mjs";
    const source = await readFile(resolve(root, doc), "utf8");
    await writeFile(
      resolve(root, doc),
      source.replace("${APP_STORE.version}", APP_STORE.version),
      "utf8",
    );
    await expect(bumpReleaseDocs({ repoRoot: root, from: PUBLISHED, to: NEXT }))
      .rejects.toThrow(/restates the Mac App Store release/);
  });

  it("refuses a release-history module that stopped reading the record", async () => {
    // Word-bounded on purpose. A substring check passed an import aliased to
    // `xreadMacAppStoreReleasex`, which is exactly the shape a rename produces.
    const root = await stagedDocs();
    const doc = "web/scripts/pages/content/releases.mjs";
    const source = await readFile(resolve(root, doc), "utf8");
    await writeFile(
      resolve(root, doc),
      source.replaceAll("readMacAppStoreRelease", "xreadMacAppStoreReleasex"),
      "utf8",
    );
    await expect(bumpReleaseDocs({ repoRoot: root, from: PUBLISHED, to: NEXT }))
      .rejects.toThrow(/must read the Mac App Store version/);
  });

  it("bumps normally once the two channels diverge again", async () => {
    // The guard must not become a permanent tax. When the App Store record moves
    // on to a version the direct channel is not at, nothing in the documents is
    // ambiguous any more and an ordinary bump has to keep working — including
    // the protected link, which simply does not match `from`.
    const root = await stagedDocs({ appStore: { ...APP_STORE, version: "1.4.0" } });
    for (const doc of ["README.md", "apps/README.md"]) {
      const text = await readFile(resolve(root, doc), "utf8");
      await writeFile(resolve(root, doc), text.replaceAll(
        `[${APP_STORE.version}](${APP_STORE.url})`,
        `[1.4.0](${APP_STORE.url})`,
      ).replaceAll(
        `[${APP_STORE.version} on the Mac App Store](${APP_STORE.url})`,
        `[1.4.0 on the Mac App Store](${APP_STORE.url})`,
      ), "utf8");
    }
    await bumpReleaseDocs({ repoRoot: root, from: PUBLISHED, to: NEXT });
    for (const doc of ["README.md", "apps/README.md"]) {
      const after = await readFile(resolve(root, doc), "utf8");
      expect(after, `${doc} did not move the Developer ID claim`).toContain(`macos-v${NEXT}`);
      expect(after, `${doc} moved the App Store claim`).toContain(`[1.4.0](${APP_STORE.url})`);
    }
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
    // The App Store claim rides along because README.md is a claim document and
    // is required to carry one — which also shows the two rules composing: the
    // link is protected by its span while the look-around still decides every
    // occurrence outside it.
    const root = await stagedDocs();
    const claim = `[${APP_STORE.version}](${APP_STORE.url})`;
    await writeFile(
      resolve(root, "README.md"),
      `macos-v${PUBLISHED} and ${PUBLISHED}1 and ${PUBLISHED}.7 and 11${PUBLISHED}\n${claim}\n`,
      "utf8",
    );
    await bumpReleaseDocs({ repoRoot: root, from: PUBLISHED, to: NEXT, docs: ["README.md"] });
    expect(await readFile(resolve(root, "README.md"), "utf8"))
      .toBe(`macos-v${NEXT} and ${PUBLISHED}1 and ${PUBLISHED}.7 and 11${PUBLISHED}\n${claim}\n`);
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

  it("rejects a candidate that left the server verified-release catalog behind", () => {
    const catalog = "server/account/macos_release_catalog.json";
    const result = checkCandidateScope(complete().filter((path) => path !== catalog));
    expect(result.ok).toBe(false);
    expect(result.missing).toEqual([catalog]);
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

  it("allows but does not require the conditionally regenerated sitemap", () => {
    expect(checkCandidateScope(complete()).ok).toBe(true);
    expect(checkCandidateScope([...complete(), ...OPTIONAL_GENERATED_PAGES]).ok).toBe(true);
    expect(CANDIDATE_PATHS).not.toContain("web/public/sitemap.xml");
  });

  it("requires every archived /apps page, whose download URL the manifest owns", () => {
    // The drift this list exists to end. `gen-pages.mjs` renders the manifest's
    // `downloadUrl` into all nine `/apps` pages; the publication job used to
    // restore seven of them back onto the PREVIOUS tag before committing, so
    // main shipped seven public download buttons naming a superseded release
    // while the deployed site — same manifest, no restore — served the new one.
    // Missing one is now incomplete in exactly the way a stale README is.
    expect(ARCHIVED_APP_PAGES).toHaveLength(FROZEN_PAGE_PREFIXES.length);
    for (const page of ARCHIVED_APP_PAGES) {
      const result = checkCandidateScope(complete().filter((path) => path !== page));
      expect(result.ok, `${page} may be omitted`).toBe(false);
      expect(result.missing).toEqual([page]);
      // Not the frozen axis. A required path reported as frozen could never be
      // satisfied, so the exemption has to remove it from that list entirely.
      expect(result.frozen).toEqual([]);
      expect(result.problems.join("\n")).toMatch(/incomplete/);
    }
  });

  it("rejects every OTHER archived page that moved", () => {
    // The freeze is narrowed by exactly one file per locale, not lifted. An
    // archived `/releases` page carries translated PROSE about a release; a
    // release commit that refreshed it would be republishing a translation the
    // product no longer maintains, which is the thing the freeze is for.
    for (const prefix of FROZEN_PAGE_PREFIXES) {
      const mutated = `${prefix}releases/index.html`;
      const result = checkCandidateScope([...complete(), mutated]);
      expect(result.ok, `${mutated} may be rewritten`).toBe(false);
      expect(result.frozen).toEqual([mutated]);
      expect(result.problems.join("\n")).toMatch(/byte-for-byte/);
    }
  });

  it("keeps the archived exemption to /apps/index.html and nothing beside it", () => {
    // A prefix-shaped exemption would quietly cover `/apps/anything`. Only the
    // one generated file per locale is manifest-derived.
    for (const prefix of FROZEN_PAGE_PREFIXES) {
      for (const sibling of [`${prefix}apps/index.htm`, `${prefix}apps/macos/index.html`]) {
        const result = checkCandidateScope([...complete(), sibling]);
        expect(result.ok, `${sibling} may be rewritten`).toBe(false);
        expect(result.frozen).toEqual([sibling]);
      }
    }
  });

  it("rejects a release candidate that also moves the App Store fact", () => {
    // The two channels are delivered separately and by different actors: this
    // candidate is assembled from a notarized DMG the workflow just built, while
    // the App Store version changes when Apple releases a build somebody
    // submitted days earlier. A commit doing both is not a Developer ID release,
    // and the reviewer of a release commit should not have to notice that.
    const result = checkCandidateScope([...CANDIDATE_PATHS, MAC_APP_STORE_RELEASE_DOC]);
    expect(result.ok).toBe(false);
    expect(result.unexpected).toContain(MAC_APP_STORE_RELEASE_DOC);
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
    const result = checkCandidateScope(["web/public/de/releases/index.html"], { alreadyDelivered: true });
    expect(result.ok).toBe(false);
    expect(result.frozen).toEqual(["web/public/de/releases/index.html"]);
  });

  it("refuses an archived /apps page that moved, even though a fresh release requires it", () => {
    // The exemption makes these seven required candidate content; it does not
    // make them reproducible-rerun content. If re-deriving a version main
    // already documents moves one of them, the manifest and the committed bytes
    // disagreed before the rerun started, and pushing a second commit on top of
    // a public release is the wrong way to find that out.
    for (const page of ARCHIVED_APP_PAGES) {
      const result = checkCandidateScope([page], { alreadyDelivered: true });
      expect(result.ok, `${page} may move on a rerun`).toBe(false);
      expect(result.unexpected).toEqual([page]);
      expect(result.problems.join("\n")).toMatch(/must change nothing/);
    }
  });
});

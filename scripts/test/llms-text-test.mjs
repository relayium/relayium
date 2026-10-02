#!/usr/bin/env node
// Migrated from web/scripts/pages/llms-text.test.mjs with assertions preserved.
// Root documentation changes do not select web.yml; repo-hygiene.yml runs this
// dependency-free Node check on main pushes and through merge-gate on PRs. Inputs resolve from this module. Keep this as the sole owner of these tests.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const llms = readFileSync(new URL("../../web/public/llms.txt", import.meta.url), "utf8");
const homepage = readFileSync(new URL("../../web/index.html", import.meta.url), "utf8");
const readme = readFileSync(new URL("../../README.md", import.meta.url), "utf8");
const billing = readFileSync(new URL("../../docs/billing-transparency.md", import.meta.url), "utf8");
// The newest published CLI is the top row of /releases, which releases.test.mjs
// holds to the real `v*` tags. Read as text: the module resolves a manifest from
// the web root at import, and this check runs from the repository root.
const releasesSource = readFileSync(new URL("../../web/scripts/pages/content/releases.mjs", import.meta.url), "utf8");
const PUBLISHED_CLI = /export const RELEASES = \[\s*\{ version: "(v\d+\.\d+\.\d+)"/.exec(releasesSource)?.[1];
// History, not the newest release: the last CLI whose pairing-code modes are
// direct-only, and the first that pairs over the relayed link. A v0.27.0 binary
// still falls back to the direct-only pairing against an older CLI peer.
const LAST_DIRECT_ONLY_CLI = "v0.26.0";
const FIRST_LINK_CLI = "v0.27.0";
const flat = (text) => text.replace(/\s+/g, " ");

describe("llms.txt file and ephemeral text product facts", () => {
  it("positions text as online-only, bounded, and not server-stored", () => {
    assert.ok(llms.includes("file and online-only ephemeral text transfer"));
    assert.ok(llms.includes("both devices must be online at the same time"));
    assert.ok(llms.includes("no offline delivery or server-side message history"));
    assert.ok(llms.includes("65,536 UTF-8 bytes"));
    assert.ok(llms.includes("Either endpoint can copy, log, screenshot, or otherwise retain text"));
  });

  // An answering model reads this file to decide what to tell someone about the
  // cross-network product. Leaving the unified workspace out of the pairing-code
  // bullet let it describe a surface that stopped existing on 2026-08-10 — one
  // where files and messages are separate flows across networks.
  it("states that a pairing-code room gets the same shared workspace", () => {
    assert.ok(llms.includes("Two up-to-date browsers get the same shared workspace here as on the same network"));
    assert.ok(llms.includes("one end-to-end encrypted connection carrying files and ephemeral text together"));
    assert.ok(llms.includes("one optional verification code (SAS) rather than one per session"));
    // Relayed and therefore bounded — relay-deadline.ts derives it from the TURN
    // REST credential, so this is a product fact and not an implementation note.
    assert.ok(llms.includes("bounded lifetime derived from the TURN credential"));
    // The exact-match capability gate, which is what keeps this from overclaiming.
    assert.ok(llms.includes("older browsers, the native apps, the CLI — keep the separate file and text flows"));
    // The same-network bullet has to describe the same one surface, or the two
    // bullets teach a reader that the rooms differ in a way they no longer do.
    assert.ok(llms.includes("the peer card offers one action, which opens a shared workspace"));
    assert.doesNotMatch(llms, /pairing[- ]code[^.]{0,80}(?:older|legacy|separate) (?:controls|surface|flows?)/i);
  });

  it("states the account boundary for pairing-code creation and joining", () => {
    assert.ok(llms.includes("Same-network transfers need no account"));
    assert.ok(llms.includes("Creating a cross-network file or text pairing code requires sign-in"));
    assert.ok(llms.includes("joining with a code does not"));
  });

  it("pins pairing-code shape and expiry, and separates it from the SAS", () => {
    // Both are six digits now, so the file cannot rely on "characters vs digits"
    // to tell them apart — it has to say so.
    assert.ok(llms.includes("6-digit pairing code"));
    assert.ok(llms.includes("Codes expire 5 minutes"));
    assert.ok(llms.includes("six decimal digits (0-9, leading zeros included)"));
    assert.ok(llms.includes("not the same value as the 6-digit SAS"));
    assert.ok(llms.includes("6-digit Short Authentication String (SAS)"));
    // The alphabet and the two TTLs this file has carried before. Any of them
    // reappearing means the format or the window moved and this file was left
    // behind — which is exactly what happened at 5 -> 30 minutes.
    assert.doesNotMatch(llms, /6-character/i);
    assert.doesNotMatch(llms, /ACDEFHJKMNPRTWXY/);
    assert.doesNotMatch(llms, /codes? (?:live|last|expire(?:s)?) (?:15|30) minutes/i);
  });

  // The SAS is opt-in. A file that describes it as something the product always
  // does would be teaching an LLM to tell users they are protected by a check
  // their browser never showed them.
  it("says the SAS comparison is optional and bounds what turning it off changes", () => {
    assert.match(llms, /Anti man-in-the-middle \(optional\)/);
    assert.ok(llms.includes("it is off by default"));
    assert.ok(llms.includes("only when a person actually compares the two values"));
    assert.ok(llms.includes("it never disables commit-then-reveal"));
    assert.ok(llms.includes("receiving files still asks before anything is saved"));
  });

  it("distinguishes browser TURN ciphertext from direct-only CLI text", () => {
    assert.ok(llms.includes("cross-network browser file and text sessions carry end-to-end encrypted ciphertext through TURN by design"));
    assert.ok(llms.includes("CLI text uses a separate direct-only protocol"));
    assert.ok(llms.includes("CLI text is direct-only and does not use TURN"));
    // Direct-only is a fact about CLI v0.26.0 and earlier, and about the older
    // pairing a current CLI falls back to against such a peer — not about the
    // CLI: since v0.27.0 pairing-code sessions relay whenever a TURN relay is
    // issued. Every sentence that calls CLI pairing or CLI text direct-only must
    // carry that historical scope, and the relayed link must be described as the
    // newest published release, not as an unreleased candidate.
    assert.match(PUBLISHED_CLI ?? "", /^v\d+\.\d+\.\d+$/, "the newest /releases row could not be read");
    assert.notEqual(PUBLISHED_CLI, LAST_DIRECT_ONLY_CLI, "the newest published CLI is still the direct-only one");
    assert.ok(llms.includes(`In the published CLI (${PUBLISHED_CLI}), CLI pairing-code sessions use an end-to-end encrypted link that goes through a TURN relay whenever the server issues one`));
    assert.ok(llms.includes(`In CLI ${LAST_DIRECT_ONLY_CLI} and earlier, and with an older CLI peer, CLI text uses a separate direct-only protocol`));
    assert.ok(llms.includes(`in CLI ${LAST_DIRECT_ONLY_CLI} and earlier, and with an older CLI peer, CLI text is direct-only and does not use TURN`));
    for (const sentence of llms.split(/(?<=[.!?])\s+/)) {
      if (/\bCLI\b/.test(sentence) && /direct-only/.test(sentence)) {
        assert.ok(sentence.includes(`CLI ${LAST_DIRECT_ONLY_CLI} and earlier`), `unscoped CLI direct-only claim: ${sentence}`);
      }
    }
    // Every "published CLI" names the newest release, and the pre-release
    // wording is gone rather than left beside it.
    const named = [...llms.matchAll(/published CLI(?:'s)?(?: \(([^)]*)\))?/g)];
    assert.ok(named.length > 0);
    for (const m of named) assert.equal(m[1], PUBLISHED_CLI, `"${m[0]}" does not name the newest published CLI`);
    for (const stale of [/next CLI release/i, /release candidate/i, /source on main/i, /not yet a published release/i])
      assert.doesNotMatch(llms, stale);
    assert.doesNotMatch(llms, /(?:file|message|realtime) bytes (?:never|do not) touch the server/i);
    assert.doesNotMatch(llms, /all realtime transfers .*need no account/i);
  });

  it("keeps browser and CLI SAS constructions protocol-specific", () => {
    assert.ok(llms.includes("derived from the two X25519 endpoint public keys"));
    assert.ok(llms.includes("derived from the two pinned TLS certificate fingerprints"));
    // The pinned-TLS SAS belongs to the older direct CLI pairing; the published
    // CLI's link derives its SAS from the exchanged keys. Neither is the
    // browser's X25519 construction.
    assert.ok(llms.includes(`The pinned-TLS SAS belongs to the older direct CLI pairing (CLI ${LAST_DIRECT_ONLY_CLI} and earlier, or an older CLI peer)`));
    assert.ok(llms.includes(`in the published CLI (${PUBLISHED_CLI}), a CLI session with a current relayium, an app or the web page runs over an end-to-end encrypted link`));
    assert.ok(llms.includes("The older CLI-to-CLI pairing uses a separate SAS derived from the two pinned TLS certificate fingerprints"));
    assert.ok(llms.includes("whose 6-digit SAS is derived from the keys the two ends exchanged"));
    assert.doesNotMatch(llms, /CLI[^.]{0,80}X25519/);
    assert.ok(llms.includes("authenticate endpoints rather than proving that no server or TURN relay exists"));
    assert.doesNotMatch(llms, /SAS\) is derived from the session keys/i);
  });

  // What an answering model tells someone who asks "is Relayium free?" and
  // "which platforms is it on?". Both answers were wrong until 2026-08-28: the
  // file said "Price: free" and answered the FAQ with an unconditional "Yes",
  // while cross-network relay bandwidth and stored-file storage have been
  // metered against a monthly allowance with four paid tiers since 2026-07. A
  // crawler-facing file that overstates the free tier is a support burden and a
  // billing surprise, in that order.
  //
  // Corrected again on 2026-08-28: "a free tier, not a free product" was itself
  // wrong in the other direction. The SOFTWARE is a free product — AGPL-3.0,
  // self-hostable, no limits — and only the hosted service is bounded. The
  // sentence a model repeats has to draw that line, not erase it.
  it("bounds the hosted service without denying that the software is free", () => {
    assert.ok(llms.includes("the software is a free, open-source product"));
    assert.ok(llms.includes("a free tier, not an unlimited free hosted service"));
    // The retired form, which denied the free software along with the free service.
    assert.ok(!llms.includes("there is a free tier, not a free product"));
    // The unmetered half has to survive too. "It costs money" is as wrong as
    // "it is free" — direct paths genuinely are unmetered, and that is the
    // product's actual position.
    assert.ok(llms.includes("Direct transfers cost nothing and are never metered"));
    // …and the four limits, stated as four. Calling relay and storage both
    // "monthly allowances" is the systematic error this batch corrected: only
    // traffic is monthly, and storage is live occupancy checked by
    // remainingStorage/CurrentStorage (server/account/plan_enforce.go).
    assert.ok(llms.includes("monthly traffic"));
    assert.match(llms, /hosted uploads?,? hosted downloads? and (billable )?relay/i);
    assert.match(llms, /occupancy and not a monthly total/i);
    assert.match(llms, /daily upload quota/i);
    assert.match(llms, /retention window/i);
    // The shape that would undo it: storage described as a monthly quantity.
    assert.doesNotMatch(llms, /\bstorage\b[^.]{0,30}\bper month\b/i);
    for (const tier of ["Plus", "Pro", "Max"]) {
      assert.ok(llms.includes(tier), `the ${tier} tier is missing`);
    }
    // Figures are deliberately NOT in this file. Plan rows are editable in the
    // admin dashboard, so a number copied here is a number that goes stale
    // without anything failing; /pricing renders the live values.
    assert.ok(llms.includes("https://relayium.com/pricing"));
    assert.ok(llms.includes("do not quote figures from memory"));
    // The exact retired sentences, verbatim from the diff that removed them.
    assert.ok(!llms.includes("Price: free."));
    assert.doesNotMatch(llms, /\*\*Is Relayium free\?\*\* Yes\b/);
  });

  // The second half of that same defect, corrected 2026-08-28. Saying the free
  // tier is an allowance is not enough if the file then tells an answering model
  // that "every CLI mode" is on the unmetered side of it. `relayium up` is a CLI
  // mode, and it uploads a client-side-encrypted copy into hosted storage whose
  // TTL the server truncates to the account plan's cap
  // (server/cmd/relayium/cloud.go runUp; cloud_ttl_notice_test.go). Both the
  // Price bullet and the FAQ answer carried the overbroad form, so both are
  // pinned here — a model that repeated it would tell a paying user their
  // storage-quota consumption is free.
  it("never puts every CLI mode on the unmetered side of the free tier", () => {
    // The retired phrase, verbatim, and the shapes it could come back as. The
    // generalisation is what is wrong, so no wording of it is allowed.
    assert.ok(!llms.includes("every CLI mode"));
    assert.doesNotMatch(llms, /\b(every|all|any|each) CLI (mode|command|verb|subcommand)s?\b/i);
    assert.doesNotMatch(llms, /\bthe (whole |entire )?CLI\b[^.]{0,80}\b(is|are|stays?|remains?)\b[^.]{0,40}\b(free|unmetered|direct)\b/i);
    // A generalisation over "modes" that also generalises about cost or path is
    // the same defect with the word CLI dropped.
    assert.doesNotMatch(llms, /\b(every|all) (transfer )?modes?\b[^.]{0,90}\b(direct|unmetered|free|never metered|cost nothing)\b/i);

    // Removing the claim is only half of it. Both places must instead enumerate
    // the modes that really are direct, and both must name `up` as the hosted
    // exception, or the file has simply gone quiet on the question a reader is
    // asking.
    for (const mode of [
      "daemon-direct CLI push/sync",
      "pairing-code send/receive",
      "ephemeral text",
    ]) {
      assert.ok(llms.includes(mode), `the direct-mode enumeration lost ${mode}`);
    }
    assert.match(llms, /`relayium up` is deliberately not direct/);
    assert.match(llms, /`relayium up` is hosted storage/);
    // Two mentions of the exception, one per corrected passage: the Price bullet
    // and the FAQ answer. A single mention means one of them regressed.
    assert.equal((llms.match(/`relayium up`/g) ?? []).length, 2);
    // And what the exception actually costs the sender, in both passages. It
    // used to be pinned as "plan storage cap and retention window" — two of the
    // four dimensions, which is how the file came to imply storage was monthly.
    assert.ok(!llms.includes("plan storage cap and retention window"));
    // One per corrected passage — the Price bullet and the FAQ answer — each
    // saying `up` is bounded exactly as a browser stored link is.
    assert.equal((llms.match(/browser stored link/g) ?? []).length, 2);
    assert.equal((llms.match(/four (?:separate )?plan limits/g) ?? []).length, 2);
  });

  // Routing is not billing. The next CLI release candidate relays a pairing-code
  // session whenever a TURN relay is issued, but its bytes count toward the code
  // creator's allowance only when the relay reports billable usage: fleet relay
  // nodes do; coturn's Redis ingest is disabled and its metering bridge defaults
  // to shadow, which never writes the billable ledger
  // (server/account/coturn_metering_store.go ApplyCoturnSnapshot). Both
  // overclaims are wrong: "every relayed byte counts" and "relaying is free".
  it("makes CLI relay billing conditional, neither unconditional nor all-free", () => {
    assert.ok(llms.includes("count toward the code creator's monthly traffic allowance only when the relay reports them as billable usage"));
    assert.ok(llms.includes("Relayium's fleet relay nodes do, while Relayium's coturn TURN servers bill nothing today"));
    assert.ok(llms.includes("Being relayed is not by itself being billed"));
    assert.ok(llms.includes("billable relay usage comes from the fleet relay nodes"));
    // coturn's accounting ingest is off by default (production configures no
    // bridge route); shadow mode is only what happens IF it is configured.
    assert.ok(llms.includes("its legacy Redis relay-byte ingest is disabled; its optional accounting ingest is off by default and, if configured in shadow mode, records measurements without billing anyone"));
    for (const re of [/currently only measure/i, /\bruns measure-only\b/i, /\b(bridge|ingest) (runs|is running|is active|is on)\b/i])
      assert.doesNotMatch(llms, re);
    for (const s of llms.split(/(?<=[.!?;])\s+/))
      if (/coturn|bridge|\bingest\b/i.test(s) && /measure/i.test(s))
        assert.match(s, /if configured in shadow mode/i, `coturn measurement without the IF-configured qualifier: ${s}`);
    // The generic relay statements are billable-only too.
    assert.ok(llms.includes("Billable relay usage and hosted storage usage are counted against four separate plan limits"));
    assert.ok(llms.includes("Billable cross-network relay bandwidth (fleet relay nodes report it; Relayium's coturn TURN servers bill nothing today)"));
    assert.ok(!llms.includes("Hosted relay/storage usage is counted"));
    assert.ok(!llms.includes("Cross-network browser relay bandwidth and temporary hosted storage draw"));
    for (const clause of llms.split(/[.;](?=\s)/)) {
      if (/(code creator|minted the code|code owner)/i.test(clause) && /\bcount/i.test(clause)) {
        assert.match(clause, /billable/, `unconditional relay billing clause: ${clause}`);
      }
    }
    assert.doesNotMatch(llms, /\b(all|every|any) relay(ed)? (traffic|bytes?|sessions?|transfers?)\b[^.]{0,40}\b(free|unmetered|never (counted|metered|billed))\b/i);
    assert.doesNotMatch(llms, /\brelay(ing|ed traffic)? is (always |)free\b/i);
  });

  // "An account stores only an email and display name" was a data-minimisation
  // claim the code does not support, and the word doing the damage was "only".
  // A user row also carries the sign-in method and its credential material, and
  // the account owns sessions, paired devices (id, name, install id), usage and
  // storage accounting, and a plan plus a provider subscription reference —
  // every one of those is in the schema table of docs/billing-transparency.md.
  // An answering model repeating "only an email" would be telling someone their
  // device list and billing linkage do not exist.
  //
  // The replacement is deliberately a short summary plus a link, not a column
  // list: this file is not the privacy policy and a copied field list is a
  // second truth that goes stale silently.
  it("does not claim an account holds only an email and a display name", () => {
    assert.ok(!llms.includes("An account stores only an email and display name"));
    assert.doesNotMatch(llms, /\baccount\b[^.]{0,60}\bstores? only\b/i);
    // What it says instead: not-only, the categories that actually exist, the
    // categories that do not, and where the authoritative list lives.
    assert.match(llms, /not just an email and a display name/i);
    for (const held of [/sign-in method/i, /sessions/i, /devices/i, /usage and storage/i, /subscription reference/i])
      assert.match(llms, held, `${held} is missing from the account summary`);
    assert.match(llms, /never holds card numbers, file contents, filenames or any key/i);
    assert.ok(llms.includes("https://relayium.com/privacy"));
  });

  it("names both macOS channels and no app for a platform that has none", () => {
    assert.ok(llms.includes("a native macOS menu-bar app"));
    assert.ok(llms.includes("https://apps.apple.com/app/id6801142976"));
    assert.ok(llms.includes("independently versioned"));
    assert.ok(llms.includes("their version numbers are not expected to match"));
    // The three that do not exist. `apps/` holds mac/, ios/ and RelayiumKit/;
    // iOS development is paused with no public listing, and there is no Android
    // or Windows target at all. An answer engine that invented one of these
    // would send a reader looking for a download that has never existed.
    // Android left this denial on 2026-09-08: the APK is published, so naming
    // it among the platforms with no app would be the untrue half.
    assert.ok(llms.includes("There is no Relayium app for iOS or Windows"));
    // …and the answer engines must be told what Android actually gets, with its
    // limits, or the omission reads as a full-featured client.
    assert.match(llms, /Android app distributed as a direct APK/i);
    assert.match(llms, /not on Google Play/i);
    assert.doesNotMatch(llms, /\b(?:iOS|Android|Windows)\s+(?:native\s+|desktop\s+)*app\s+(?:is|will be)\b/i);
  });

  it("describes Device Inbox, including the upload-is-not-save boundary", () => {
    // Shipped 2026-08-24 (c63d4c5e) and absent from this file entirely, so an
    // answering model had no way to describe the product's one asynchronous
    // path to a machine the sender owns.
    assert.ok(llms.includes("Device Inbox"));
    assert.ok(llms.includes("https://relayium.com/device-inbox"));
    assert.ok(llms.includes("sealed to that device's public key"));
    assert.ok(llms.includes("waits in a queue while the device is offline"));
    // The two boundaries the product page is itself required to state.
    assert.ok(llms.includes("the server reaching a ciphertext upload is explicitly not the same state"));
    assert.ok(llms.includes("A public download link can never make a device write to disk"));
  });

  it("links the pages a reader is sent to for a current figure", () => {
    for (const url of [
      "https://relayium.com/apps",
      "https://relayium.com/releases",
      "https://relayium.com/pricing",
    ]) {
      assert.ok(llms.includes(url), `${url} is not linked`);
    }
  });

  // The README and the billing document make the same publication claims as
  // this file, and went stale together when v0.27.0 shipped: both kept calling
  // the relayed link, `pair` and `inbox send` an unreleased "next CLI release
  // candidate" after it was the published CLI. Same rule here: the newest
  // published CLI is named, older behavior carries its version scope, and the
  // pre-release wording does not come back.
  it("states the CLI publication state in the README and the billing document", () => {
    const r = flat(readme);
    const b = flat(billing);
    for (const [name, text] of [["README.md", r], ["billing-transparency.md", b]]) {
      const named = [...text.matchAll(/published CLI(?:'s)?(?:,? \(?(v\d+\.\d+\.\d+)\)?)?/g)];
      assert.ok(named.length > 0, `${name}: never names the published CLI`);
      for (const m of named) assert.equal(m[1], PUBLISHED_CLI, `${name}: "${m[0]}" does not name the newest published CLI`);
      for (const stale of [/next CLI release/i, /CLI release candidate/i, /not (?:yet )?in a published CLI release/i,
        /in the source on `main` but not yet/i, /only the next release's help/i])
        assert.doesNotMatch(text, stale, `${name}: pre-release CLI wording is back`);
    }
    // The README's direct-only sentence is the older pairing's limit, so the
    // version scope has to come right before it.
    const scope = `In CLI ${LAST_DIRECT_ONLY_CLI} and earlier, and in ${FIRST_LINK_CLI} against an older \`relayium\` CLI, it is cross-network and direct peer-to-peer`;
    const at = r.indexOf(scope);
    assert.ok(at >= 0, "README send/receive lost the version scope of the direct-only pairing");
    const limit = r.indexOf("This mode is direct-only: with no direct path", at);
    assert.ok(limit > at && limit - at < 400, "README's direct-only limit is not attached to the older pairing");
    assert.ok(r.includes(`**In the published CLI (${PUBLISHED_CLI})**, the other end may be a current \`relayium\``));
    assert.ok(r.includes(`**\`pair\` — a live two-way session (since CLI ${FIRST_LINK_CLI})**`));
    assert.ok(r.includes(`In CLI ${LAST_DIRECT_ONLY_CLI} and earlier, the CLI's **Device Inbox is the receive side only**`));
    assert.ok(r.includes(`adds the sending side: \`relayium inbox send --to <device> <path...>\``));
    assert.ok(r.includes(`SSH transport is **retired in the published CLI (${PUBLISHED_CLI})**`));
    // The installer relayium.com serves follows the website deployment, not the
    // CLI release, so its source-versus-served wording stays.
    assert.ok(r.includes("The `install.sh` one-liner checks the same signature with `openssl`. In the source on `main` it refuses to install when `openssl` is missing"));
    assert.ok(r.includes("the copy relayium.com serves changes when the site is next deployed"));
    // billing-transparency: the relayed link is the published CLI's, and the
    // direct-only pairing is scoped to the older binaries.
    assert.ok(b.includes(`- **CLI:** in the **published CLI (${PUBLISHED_CLI})**, pairing-code sessions — \`send\`/\`receive\`, \`text\` and \`pair\` — relay every byte`));
    assert.ok(b.includes(`In CLI ${LAST_DIRECT_ONLY_CLI} and earlier the pairing-code modes are direct-only: those binaries have no ICE or TURN path for file or text bytes`));
    assert.ok(b.includes(`and in CLI ${LAST_DIRECT_ONLY_CLI} and earlier also \`send\`/\`receive\`, \`text\` and \`push\`/\`pull\`/\`sync\` over your own SSH`));
    assert.doesNotMatch(b, /\(source on `main`\)/);
  });

  it("keeps the buffered-browser warning consistent across crawler sources", () => {
    for (const [name, copy] of [
      ["llms.txt", llms],
      ["index.html", homepage],
      ["README.md", readme],
    ]) {
      assert.ok(copy.includes("256 MB"), `${name}: warning threshold`);
      assert.doesNotMatch(copy, /(?:under|about) ~?200 MB/i, `${name}: no stale recommendation`);
    }
    assert.match(llms, /conservative estimate, not a hard limit/i);
    assert.match(homepage, /conservative estimate, not a hard limit/i);
    assert.match(readme, /conservative estimate, not a hard limit/i);
  });
});

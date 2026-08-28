import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const llms = readFileSync(resolve(process.cwd(), "public/llms.txt"), "utf8");
const homepage = readFileSync(resolve(process.cwd(), "index.html"), "utf8");
const readme = readFileSync(resolve(process.cwd(), "../README.md"), "utf8");

describe("llms.txt file and ephemeral text product facts", () => {
  it("positions text as online-only, bounded, and not server-stored", () => {
    expect(llms).toContain("file and online-only ephemeral text transfer");
    expect(llms).toContain("both devices must be online at the same time");
    expect(llms).toContain("no offline delivery or server-side message history");
    expect(llms).toContain("65,536 UTF-8 bytes");
    expect(llms).toContain("Either endpoint can copy, log, screenshot, or otherwise retain text");
  });

  // An answering model reads this file to decide what to tell someone about the
  // cross-network product. Leaving the unified workspace out of the pairing-code
  // bullet let it describe a surface that stopped existing on 2026-08-10 — one
  // where files and messages are separate flows across networks.
  it("states that a pairing-code room gets the same shared workspace", () => {
    expect(llms).toContain("Two up-to-date browsers get the same shared workspace here as on the same network");
    expect(llms).toContain("one end-to-end encrypted connection carrying files and ephemeral text together");
    expect(llms).toContain("one optional verification code (SAS) rather than one per session");
    // Relayed and therefore bounded — relay-deadline.ts derives it from the TURN
    // REST credential, so this is a product fact and not an implementation note.
    expect(llms).toContain("bounded lifetime derived from the TURN credential");
    // The exact-match capability gate, which is what keeps this from overclaiming.
    expect(llms).toContain("older browsers, the native apps, the CLI — keep the separate file and text flows");
    // The same-network bullet has to describe the same one surface, or the two
    // bullets teach a reader that the rooms differ in a way they no longer do.
    expect(llms).toContain("the peer card offers one action, which opens a shared workspace");
    expect(llms).not.toMatch(/pairing[- ]code[^.]{0,80}(?:older|legacy|separate) (?:controls|surface|flows?)/i);
  });

  it("states the account boundary for pairing-code creation and joining", () => {
    expect(llms).toContain("Same-network transfers need no account");
    expect(llms).toContain("Creating a cross-network file or text pairing code requires sign-in");
    expect(llms).toContain("joining with a code does not");
  });

  it("pins pairing-code shape and expiry, and separates it from the SAS", () => {
    // Both are six digits now, so the file cannot rely on "characters vs digits"
    // to tell them apart — it has to say so.
    expect(llms).toContain("6-digit pairing code");
    expect(llms).toContain("Codes expire 5 minutes");
    expect(llms).toContain("six decimal digits (0-9, leading zeros included)");
    expect(llms).toContain("not the same value as the 6-digit SAS");
    expect(llms).toContain("6-digit Short Authentication String (SAS)");
    // The alphabet and the two TTLs this file has carried before. Any of them
    // reappearing means the format or the window moved and this file was left
    // behind — which is exactly what happened at 5 -> 30 minutes.
    expect(llms).not.toMatch(/6-character/i);
    expect(llms).not.toMatch(/ACDEFHJKMNPRTWXY/);
    expect(llms).not.toMatch(/codes? (?:live|last|expire(?:s)?) (?:15|30) minutes/i);
  });

  // The SAS is opt-in. A file that describes it as something the product always
  // does would be teaching an LLM to tell users they are protected by a check
  // their browser never showed them.
  it("says the SAS comparison is optional and bounds what turning it off changes", () => {
    expect(llms).toMatch(/Anti man-in-the-middle \(optional\)/);
    expect(llms).toContain("it is off by default");
    expect(llms).toContain("only when a person actually compares the two values");
    expect(llms).toContain("it never disables commit-then-reveal");
    expect(llms).toContain("receiving files still asks before anything is saved");
  });

  it("distinguishes browser TURN ciphertext from direct-only CLI text", () => {
    expect(llms).toContain("cross-network browser file and text sessions carry end-to-end encrypted ciphertext through TURN by design");
    expect(llms).toContain("CLI text uses a separate direct-only protocol");
    expect(llms).toContain("CLI text is direct-only and does not use TURN");
    expect(llms).not.toMatch(/(?:file|message|realtime) bytes (?:never|do not) touch the server/i);
    expect(llms).not.toMatch(/all realtime transfers .*need no account/i);
  });

  it("keeps browser and CLI SAS constructions protocol-specific", () => {
    expect(llms).toContain("derived from the two X25519 endpoint public keys");
    expect(llms).toContain("derived from the two pinned TLS certificate fingerprints");
    expect(llms).toContain("authenticate endpoints rather than proving that no server or TURN relay exists");
    expect(llms).not.toMatch(/SAS\) is derived from the session keys/i);
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
    expect(llms).toContain("the software is a free, open-source product");
    expect(llms).toContain("a free tier, not an unlimited free hosted service");
    // The retired form, which denied the free software along with the free service.
    expect(llms).not.toContain("there is a free tier, not a free product");
    // The unmetered half has to survive too. "It costs money" is as wrong as
    // "it is free" — direct paths genuinely are unmetered, and that is the
    // product's actual position.
    expect(llms).toContain("Direct transfers cost nothing and are never metered");
    // …and the four limits, stated as four. Calling relay and storage both
    // "monthly allowances" is the systematic error this batch corrected: only
    // traffic is monthly, and storage is live occupancy checked by
    // remainingStorage/CurrentStorage (server/account/plan_enforce.go).
    expect(llms).toContain("monthly traffic");
    expect(llms).toMatch(/hosted uploads?,? hosted downloads? and (billable )?relay/i);
    expect(llms).toMatch(/occupancy and not a monthly total/i);
    expect(llms).toMatch(/daily upload quota/i);
    expect(llms).toMatch(/retention window/i);
    // The shape that would undo it: storage described as a monthly quantity.
    expect(llms).not.toMatch(/monthly[^.]{0,40}\bstorage\b/i);
    expect(llms).not.toMatch(/\bstorage\b[^.]{0,30}\bper month\b/i);
    for (const tier of ["Plus", "Pro", "Max"]) {
      expect(llms, `the ${tier} tier is missing`).toContain(tier);
    }
    // Figures are deliberately NOT in this file. Plan rows are editable in the
    // admin dashboard, so a number copied here is a number that goes stale
    // without anything failing; /pricing renders the live values.
    expect(llms).toContain("https://relayium.com/pricing");
    expect(llms).toContain("do not quote figures from memory");
    // The exact retired sentences, verbatim from the diff that removed them.
    expect(llms).not.toContain("Price: free.");
    expect(llms).not.toMatch(/\*\*Is Relayium free\?\*\* Yes\b/);
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
    expect(llms).not.toContain("every CLI mode");
    expect(llms).not.toMatch(/\b(every|all|any|each) CLI (mode|command|verb|subcommand)s?\b/i);
    expect(llms).not.toMatch(/\bthe (whole |entire )?CLI\b[^.]{0,80}\b(is|are|stays?|remains?)\b[^.]{0,40}\b(free|unmetered|direct)\b/i);
    // A generalisation over "modes" that also generalises about cost or path is
    // the same defect with the word CLI dropped.
    expect(llms).not.toMatch(/\b(every|all) (transfer )?modes?\b[^.]{0,90}\b(direct|unmetered|free|never metered|cost nothing)\b/i);

    // Removing the claim is only half of it. Both places must instead enumerate
    // the modes that really are direct, and both must name `up` as the hosted
    // exception, or the file has simply gone quiet on the question a reader is
    // asking.
    for (const mode of [
      "SSH push/pull",
      "folder sync",
      "daemon-direct",
      "pairing-code send/receive",
      "ephemeral text",
    ]) {
      expect(llms, `the direct-mode enumeration lost ${mode}`).toContain(mode);
    }
    expect(llms).toContain("`relayium up` is deliberately not one of those modes");
    expect(llms).toContain("`relayium up` is a hosted-storage mode, not a direct one");
    // Two mentions of the exception, one per corrected passage: the Price bullet
    // and the FAQ answer. A single mention means one of them regressed.
    expect(llms.match(/`relayium up`/g) ?? []).toHaveLength(3);
    // And what the exception actually costs the sender, in both passages. It
    // used to be pinned as "plan storage cap and retention window" — two of the
    // four dimensions, which is how the file came to imply storage was monthly.
    expect(llms).not.toContain("plan storage cap and retention window");
    // One per corrected passage — the Price bullet and the FAQ answer — each
    // saying `up` is bounded exactly as a browser stored link is.
    expect(llms.match(/exactly like a stored download link/g) ?? []).toHaveLength(2);
    expect(llms.match(/all four/g) ?? []).toHaveLength(3);
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
    expect(llms).not.toContain("An account stores only an email and display name");
    expect(llms).not.toMatch(/\baccount\b[^.]{0,60}\bstores? only\b/i);
    // What it says instead: not-only, the categories that actually exist, the
    // categories that do not, and where the authoritative list lives.
    expect(llms).toMatch(/not just an email and a display name/i);
    for (const held of [/sign-in method/i, /sessions/i, /devices/i, /usage and storage/i, /subscription reference/i])
      expect(llms, `${held} is missing from the account summary`).toMatch(held);
    expect(llms).toMatch(/never holds card numbers, file contents, filenames or any key/i);
    expect(llms).toContain("https://relayium.com/privacy");
  });

  it("names both macOS channels and no app for a platform that has none", () => {
    expect(llms).toContain("a native macOS menu-bar app");
    expect(llms).toContain("https://apps.apple.com/app/id6801142976");
    expect(llms).toContain("independently versioned");
    expect(llms).toContain("their version numbers are not expected to match");
    // The three that do not exist. `apps/` holds mac/, ios/ and RelayiumKit/;
    // iOS development is paused with no public listing, and there is no Android
    // or Windows target at all. An answer engine that invented one of these
    // would send a reader looking for a download that has never existed.
    expect(llms).toContain("There is no Relayium app for iOS, Android or Windows");
    expect(llms).not.toMatch(/\b(?:iOS|Android|Windows)\s+(?:native\s+|desktop\s+)*app\s+(?:is|will be)\b/i);
  });

  it("describes Device Inbox, including the upload-is-not-save boundary", () => {
    // Shipped 2026-08-24 (c63d4c5e) and absent from this file entirely, so an
    // answering model had no way to describe the product's one asynchronous
    // path to a machine the sender owns.
    expect(llms).toContain("Device Inbox");
    expect(llms).toContain("https://relayium.com/device-inbox");
    expect(llms).toContain("sealed to that device's public key");
    expect(llms).toContain("waits in a queue while the device is offline");
    // The two boundaries the product page is itself required to state.
    expect(llms).toContain("the server reaching a ciphertext upload is explicitly not the same state");
    expect(llms).toContain("A public download link can never make a device write to disk");
  });

  it("links the pages a reader is sent to for a current figure", () => {
    for (const url of [
      "https://relayium.com/apps",
      "https://relayium.com/releases",
      "https://relayium.com/pricing",
    ]) {
      expect(llms, `${url} is not linked`).toContain(url);
    }
  });

  it("keeps the buffered-browser warning consistent across crawler sources", () => {
    for (const [name, copy] of [
      ["llms.txt", llms],
      ["index.html", homepage],
      ["README.md", readme],
    ]) {
      expect(copy, `${name}: warning threshold`).toContain("256 MB");
      expect(copy, `${name}: no stale recommendation`).not.toMatch(/(?:under|about) ~?200 MB/i);
    }
    expect(llms).toMatch(/conservative estimate, not a hard limit/i);
    expect(homepage).toMatch(/conservative estimate, not a hard limit/i);
    expect(readme).toMatch(/conservative estimate, not a hard limit/i);
  });
});

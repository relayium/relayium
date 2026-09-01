// The crawlable /cli shell, and the lock between the page's guide list and the
// authoritative article set.
//
// A non-rendering client — most AI/answer-engine crawlers, Bing's second pass,
// every link unfurler — sees ONLY this shell. So the claims it carries are not a
// summary of the page; for those readers they are the page. Three of them were
// wrong, and all three are asserted here rather than described:
//
//   * Device Inbox was missing entirely, so the mode list read as six.
//   * "Every file is verified … an interrupted transfer resumes" was stated over
//     all modes. The tar fallback verifies nothing and push/pull never resume —
//     and the sentence that replaced it, "Resume is a sync feature", was wrong
//     the other way, because `relayium down` reconnects and continues too.
//   * The --server answer listed five commands; `text` takes it too.
import { describe, it, expect } from "vitest";
import { buildShells } from "./shells.mjs";
import { pricing, cli, deviceInbox } from "./content/spa-pages.mjs";
import { CLI_ARTICLES } from "./content/cli-articles.mjs";
import { GUIDES, CLI_MODES, FLAG_ROWS } from "../../src/lib/cli-page-data";
import en from "../../src/lib/i18n/en";

const shells = buildShells({ pricing, cli, deviceInbox, cliArticles: CLI_ARTICLES });
const body = shells.find((s) => s.file === "cli.html").body;

describe("the /cli guide set has one authority", () => {
  it("the rendered page's GUIDES are exactly CLI_ARTICLES' slugs", () => {
    // cli-articles.mjs reads each slug off the article document itself, so it
    // cannot drift from what is published. The SPA keeps its own list only
    // because it needs grouping and localized titles — this is the lock between
    // the two, and the reason a renamed or added article cannot leave the hub
    // page linking at a 404 or silently dropping a guide.
    expect(GUIDES.map((g) => g.slug).sort()).toEqual(CLI_ARTICLES.map((a) => a.slug).sort());
    expect(GUIDES).toHaveLength(9);
  });

  it("every localized guide title is filled in for both maintained languages", () => {
    for (const g of GUIDES) {
      expect(en.cliPage.guides[g.key], `en guide title for ${g.slug}`).toBeTruthy();
    }
  });
});

describe("the crawlable /cli shell", () => {
  it("mirrors the SPA's title and description byte for byte", () => {
    // The SPA overwrites the served <head> on boot. If these disagree, a
    // rendering crawler and a non-rendering one read two different pages at one
    // URL — the exact defect the shell mechanism exists to remove.
    expect(cli.title).toBe(en.cliPage.metaTitle);
    expect(cli.description).toBe(en.cliPage.metaDesc);
  });

  it("leads with the same H1 and supporting line as the rendered page", () => {
    expect(body).toContain("<h1>Relayium CLI</h1>");
    expect(cli.hero.pitch).toBe(en.cliPage.heroSupport);
  });

  it("names all seven modes, in the accepted order", () => {
    expect(cli.why.items.map((i) => i.title)).toEqual(CLI_MODES.map((m) => m.name));
    for (const m of CLI_MODES) expect(body, m.name).toContain(m.name);
  });

  it("uses the accepted connectivity/ownership taxonomy in the mode prose", () => {
    const byTitle = Object.fromEntries(cli.why.items.map((i) => [i.title, i.desc]));
    for (const name of ["Cloud", "Device Inbox"])
      expect(byTitle[name], name).toMatch(/Another device can be offline/);
    for (const name of ["text", "send / receive"])
      expect(byTitle[name], name).toMatch(/Both devices are online/);
    for (const name of ["push / pull", "serve", "sync"])
      expect(byTitle[name], name).toMatch(/A machine you manage/);
  });

  it("states that the CLI is the Device Inbox RECEIVE side only", () => {
    // The one mode whose sender is not the CLI. Without this, a reader is sent
    // looking for a `relayium inbox send` that does not exist.
    expect(body).toMatch(/RECEIVE side only/);
    expect(body).toMatch(/no CLI command that sends into an inbox/i);
    expect(body).toMatch(/serve with push or sync/i);
  });

  it("carries no blanket resume or SHA-256 promise", () => {
    expect(body).not.toMatch(/Every file is verified end-to-end with SHA-256/i);
    expect(body).not.toMatch(/an interrupted transfer resumes from where it stopped/i);
    expect(body).not.toContain("Verified and resumable");
    // …and says the per-mode truth instead.
    expect(body).toMatch(/verifies nothing per file/);
    expect(body).toMatch(/push and pull do not resume/i);
  });

  // The first fix for the blanket promise replaced it with "Resume is a sync
  // feature", which is a second untrue sentence rather than the correction.
  // `relayium down` resumes too — server/internal/cloud/transfer.go's Download
  // loop reconnects up to five attempts and continues with
  // `Range: bytes=<consumed>-` from the last whole frame the Decryptor accepted
  // (TestDownloadResumesAfterMidStreamDrop) — it simply resumes in a different
  // SCOPE: inside one invocation, and it removes the partial output when the
  // attempts are spent. So this pins the distinction rather than either blanket.
  it("distinguishes sync's across-runs resume from Cloud's in-run reconnect", () => {
    expect(body, "the sync-only blanket came back").not.toMatch(/Resume is a sync feature/i);
    expect(body).toMatch(/sync resumes across runs/i);
    expect(body).toMatch(/relayium down resumes within a single run/i);
    expect(body).toMatch(/HTTP Range/);
    expect(body).toMatch(/five attempts/i);
    // The half a reader is most likely to over-read: this is not a mailbox that
    // survives the process exiting.
    expect(body).toMatch(/deletes the partial output/i);
    expect(body).toMatch(/starts from the beginning|start from the beginning/i);
    // And it must never be stated as surviving a later invocation.
    expect(body).not.toMatch(/relayium down[^.]{0,80}resumes? on the next run/i);
  });

  it("gives --server its real scope, text included", () => {
    const answer = cli.faq.items.find((f) => f.q === "Can I point it at my own server?").a;
    for (const cmd of ["login", "up", "down", "send", "receive", "text"])
      expect(answer, `--server answer omits ${cmd}`).toMatch(new RegExp(`\\b${cmd}\\b`));
    // The flag table on the rendered page has to agree.
    expect(FLAG_ROWS.find((f) => f.flag === "--server <url>").who).toContain("text");
  });

  it("does not imply the POSIX shell installer works on Windows", () => {
    const steps = cli.how.steps.join(" ");
    expect(steps).toMatch(/macOS and Linux: one command/);
    expect(steps).toMatch(/POSIX shell script and does not run on Windows/i);
    expect(steps).toMatch(/portable ZIP/i);
    // The old wording — one command "for your OS", Windows as an aside.
    expect(steps).not.toMatch(/a prebuilt binary for your OS/i);
  });

  it("links all nine guides, each with a trailing slash", () => {
    for (const a of CLI_ARTICLES) expect(body, a.slug).toContain(`href="/${a.slug}/"`);
    expect(body.match(/href="\/(?:guides|how-to)\/[^"]+\/"/g)).toHaveLength(9);
  });

  it("asks the four accepted FAQ questions", () => {
    const questions = cli.faq.items.map((i) => i.q);
    for (const q of [
      "Do I need an account?",
      "Can the other device be offline?",
      "Which transfers can resume?",
      "How does verification differ by mode?",
    ])
      expect(questions, q).toContain(q);
  });

  it("hardcodes no release version", () => {
    expect(body).not.toContain("0.24.0");
    expect(body).not.toMatch(/\bv\d+\.\d+\.\d+\b/);
  });
});

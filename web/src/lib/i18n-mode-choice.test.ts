// web/src/lib/i18n-mode-choice.test.ts — the product's answer to "which of the
// three do I want?", pinned in every maintained language.
//
// Relayium has three transfer modes and they are not interchangeable:
//   LAN        account-free, device to device, and same network ONLY
//   Realtime   quick cross-network hand-off of small files and text, both online
//   Download link  the large-file and send-now/fetch-later path
//
// Every one of those has a limitation that rules it out for somebody, and copy
// that sells the benefit while dropping the limitation sends that reader to a
// screen that cannot do what they came for. The comparison table used to list
// two modes and to answer "best for" with "live big-file transfer", which is the
// one recommendation the shape of the product does not support: realtime has no
// server-side size cap, but it rides a single live session, so closing or
// reloading either endpoint costs the whole transfer even though a brief
// transport drop can resume while both sessions stay active.
//
// The token tables are per language and written by hand — the point is that
// somebody read each translation and confirmed the claim survived it. The
// `STALE` table is different in kind: those are the strings that actually
// shipped, kept verbatim so the guard recognises the defect rather than only
// the fix. A table built by reading corrected copy cannot fail on wrong copy.
import { describe, expect, it } from "vitest";
import en from "./i18n/en";
import zh from "./i18n/zh";

const locales = { en, zh };
type Code = keyof typeof locales;

type Tokens = {
  /** LAN cannot leave the network — the limitation that makes it a choice. */
  sameNetworkOnly: RegExp;
  /** The mode that should own large files. */
  largeFiles: RegExp;
  /** What realtime is actually good at. */
  smallOrText: RegExp;
  /** The async mode by name, as the size answer has to name it. */
  linkMode: RegExp;
  /** Wording that shipped while realtime was sold as the big-file path. */
  stale: RegExp;
  /** The realtime method's first step, and the step that must follow it. */
  codeFirst: RegExp;
  filesAfter: RegExp;
};

const t: Record<Code, Tokens> = {
  en: {
    sameNetworkOnly: /same local network only/i,
    largeFiles: /large files/i,
    smallOrText: /small files and text/i,
    linkMode: /download link/i,
    stale: /live big-file|big-file or text transfer/i,
    codeFirst: /6-digit code/i,
    filesAfter: /choose the files/i,
  },
  zh: {
    sameNetworkOnly: /仅限同一局域网/,
    largeFiles: /大文件/,
    smallOrText: /小文件和文本/,
    linkMode: /下载链接/,
    stale: /实时传输大文件或文本/,
    codeFirst: /6 位数字码/,
    filesAfter: /选择要发送的文件/,
  },
};

/** Every string in the comparison table, header cells included. */
function compareCopy(m: typeof en): string {
  const c = m.compare;
  return [c.title, c.sub, c.colFeature, c.colLan, c.colRealtime, c.colStored,
    ...c.rows.flatMap((r) => [r.label, r.lan, r.realtime, r.stored])].join("\n");
}

/** The last row is the recommendation row: which mode for which job. */
const bestFor = (m: typeof en) => m.compare.rows[m.compare.rows.length - 1];

describe("the three transfer modes are presented as a real choice", () => {
  for (const [code, m] of Object.entries(locales) as [Code, typeof en][]) {
    const tok = t[code];

    it(`${code} compares three modes, each column its own page`, () => {
      // A two-column table cannot present a three-way choice, and a column with
      // a name shared by another one is not a column the reader can pick.
      const names = [m.compare.colLan, m.compare.colRealtime, m.compare.colStored];
      for (const name of names) expect(name.trim(), `${code}: empty column name`).toBeTruthy();
      expect(new Set(names).size, `${code}: two columns share a name — ${names.join(" / ")}`).toBe(3);
      // Rows carry a cell per mode; a blank one reads as "not applicable" and is
      // exactly where a mode's limitation goes missing.
      expect(m.compare.rows.length, `${code}: too few rows to decide with`).toBeGreaterThanOrEqual(5);
      for (const r of m.compare.rows) {
        expect(r.lan.trim(), `${code}: "${r.label}" has no LAN answer`).toBeTruthy();
        expect(r.realtime.trim(), `${code}: "${r.label}" has no realtime answer`).toBeTruthy();
        expect(r.stored.trim(), `${code}: "${r.label}" has no download-link answer`).toBeTruthy();
      }
    });

    it(`${code} says LAN cannot leave the network`, () => {
      // Without this the account-free mode reads as strictly better than the
      // other two, and the reader finds out it is not by failing to connect.
      expect(compareCopy(m), `${code}: LAN's same-network limitation is missing`).toMatch(tok.sameNetworkOnly);
    });

    it(`${code} recommends the download link for large files`, () => {
      expect(bestFor(m).stored, `${code}: the async column does not claim large files`).toMatch(tok.largeFiles);
    });

    it(`${code} positions realtime at small files and text, not large ones`, () => {
      expect(bestFor(m).realtime, `${code}: realtime's "best for" lost small files/text`).toMatch(tok.smallOrText);
      // The stale recommendation, and the general claim that outlives it: no
      // "best for" cell may hand large files to a mode that one closed lid ends.
      expect(bestFor(m).realtime, `${code}: realtime is recommended for large files`).not.toMatch(tok.largeFiles);
      expect(compareCopy(m), `${code}: the shipped big-file wording is back`).not.toMatch(tok.stale);
    });

    it(`${code} answers the file-size question with the mode to use`, () => {
      // Realtime genuinely has no server-side cap. Saying only that, and then
      // stopping, is what made readers pick it for a 20 GB file.
      const answer = m.faq.items[2].a;
      expect(answer, `${code}: the size answer never names the async mode`).toMatch(tok.linkMode);
      expect(answer, `${code}: the size answer never mentions large files`).toMatch(tok.largeFiles);
    });

    it(`${code} describes the realtime steps in the order they happen`, () => {
      // The code comes first and the files are chosen after the other device
      // joins — copy in the other order describes a product that does not exist,
      // and the reader waits on a "pick files" step that is not there yet.
      const sub = m.methods.realtime.sub;
      const code0 = sub.search(tok.codeFirst);
      const files = sub.search(tok.filesAfter);
      expect(code0, `${code}: the realtime blurb never mentions creating the code`).toBeGreaterThanOrEqual(0);
      expect(files, `${code}: the realtime blurb never mentions choosing files`).toBeGreaterThanOrEqual(0);
      expect(code0, `${code}: the blurb picks files before the code exists`).toBeLessThan(files);
    });
  }
});

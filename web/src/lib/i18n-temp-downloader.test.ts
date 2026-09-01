// The download page's "no persistent install" copy, in every maintained language.
//
// This copy is the product. The command block is identical everywhere, so the
// only thing that tells a reader what they are about to run is the surrounding
// prose — and a locale that quietly loses one of these three claims is
// indistinguishable from one that keeps them, until someone pastes the block:
//
//   1. it is TEMPORARY EXECUTION, not an install (no root, no login, nothing
//      left behind). Calling it "install without installing" would be a lie
//      the reader can only discover afterwards;
//   2. the supply chain IS verified — the release signature over checksums.txt
//      and then the archive's own hash, with nothing run if either fails;
//   3. plain curl CANNOT decrypt the link. That is the sentence that stops a
//      reader from concluding they can skip all of this, and it is the one that
//      an earlier generation of docs got wrong.
//
// It also scans the wider copy surface for the reverse claim coming back:
// anything that hands a `/d/…` link to curl and implies files come out.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import en from "./i18n/en";
import zh from "./i18n/zh";
import type { Messages } from "./i18n/types";
import { WINDOWS_RELEASE } from "./temp-downloader";

const locales: Record<string, Messages> = { en, zh };

/** "temporary" — the word that has to survive translation. */
const TEMPORARY: Record<string, RegExp> = {
  en: /temporar/i,
  zh: /临时/,
  ja: /一時/,
  ko: /임시/,
  de: /temporär/i,
  fr: /temporaire/i,
  ar: /مؤقت/u,
  es: /temporal/i,
  pt: /temporári/i,
};

/** What `tempMeans` must actually claim: nothing installed, no root, no login. */
const MEANS: Record<string, RegExp[]> = {
  en: [/Nothing is installed/i, /no root/i, /no sign-in/i],
  zh: [/不安装任何东西/, /不用 root/, /不登录/],
  ja: [/何もインストールしません/, /root/, /サインイン/],
  ko: [/아무것도 설치하지 않습니다/, /root/, /로그인/],
  de: [/Es wird nichts installiert/, /kein root/, /keine Anmeldung/],
  fr: [/Rien n'est installé/, /pas de root/, /pas de connexion/],
  ar: [/لا يُثبَّت أي شيء/u, /صلاحيات جذر/u, /تسجيل دخول/u],
  es: [/No se instala nada/, /sin root/, /sin inicio de sesión/],
  pt: [/Nada é instalado/, /sem root/, /sem login/],
};

/** "curl cannot decrypt it" — the negation, in each locale's own words. */
const CURL_CANNOT: Record<string, RegExp> = {
  en: /cannot decrypt/i,
  zh: /解不开|无法解密|不能解密/,
  ja: /復号(?:は)?できません/,
  ko: /복호화하지는 못합니다|복호화할 수 없/,
  de: /nicht entschlüsseln|entschlüsseln kann es ihn nicht/,
  fr: /pas le déchiffrer|pas déchiffrer/,
  ar: /لا يمكنه فكّ تشفيره/u,
  es: /no puede descifrarlo/,
  pt: /não consegue descriptografá-lo/,
};

describe("the no-persistent-install copy, in every locale", () => {
  it("calls it temporary execution rather than an installation", () => {
    for (const [lang, m] of Object.entries(locales)) {
      const cli = m.download.cli;
      expect(cli.tempTitle, `${lang}: tempTitle`).toBeTruthy();
      expect(
        TEMPORARY[lang].test(`${cli.tempTitle} ${cli.tempMeans} ${cli.steps.join(" ")}`),
        `${lang}: never says the execution is temporary`,
      ).toBe(true);
      for (const claim of MEANS[lang]) {
        expect(claim.test(cli.tempMeans), `${lang}: tempMeans is missing ${claim}`).toBe(true);
      }
      // Substantive, not a stub: a one-word translation would pass every regex
      // above and tell the reader nothing.
      expect(cli.tempMeans.length, `${lang}: tempMeans is too short to have explained anything`).toBeGreaterThan(80);
    }
  });

  it("states the supply-chain verification, with the same primitives everywhere", () => {
    for (const [lang, m] of Object.entries(locales)) {
      const cli = m.download.cli;
      // These three are proper nouns of the mechanism, so they are the same
      // token in every maintained language — which makes them checkable without a
      // per-locale phrasebook, and makes a dropped claim impossible to miss.
      expect(cli.verified, `${lang}: names the signature algorithm`).toMatch(/ECDSA/);
      expect(cli.verified, `${lang}: names the archive hash`).toMatch(/SHA-256/);
      expect(cli.verified, `${lang}: names the signed file`).toMatch(/checksums\.txt/);
      expect(cli.steps.length, `${lang}: the visible sequence must have all six steps`).toBe(6);
      expect(cli.steps.join(" "), `${lang}: the verify step`).toMatch(/ECDSA/);
      expect(cli.steps.join(" "), `${lang}: the archive hash step`).toMatch(/SHA-256/);
      // Fail-closed on a missing verifier is part of the promise, so the step
      // that requires openssl has to be visible too.
      expect(cli.steps.join(" "), `${lang}: the required-verifier step`).toMatch(/openssl/);
      // And the fragment claim has to name the fragment.
      expect(cli.keyStaysLocal, `${lang}: names the key`).toMatch(/#k=/);
    }
  });

  it("says plain curl cannot decrypt — nowhere implies that it can", () => {
    for (const [lang, m] of Object.entries(locales)) {
      expect(m.download.cli.tempCurlNote, `${lang}: tempCurlNote`).toMatch(/curl/i);
      expect(
        CURL_CANNOT[lang].test(m.download.cli.tempCurlNote),
        `${lang}: mentions curl without saying it cannot decrypt`,
      ).toBe(true);
    }
  });

  // The general rule behind the test above: if a translated string talks about
  // curl at all, it has to be the sentence that says curl is not enough. A new
  // locale string that casually suggests curling the link fails here.
  //
  // One string is allowed to name curl neutrally: the step that lists the tools
  // the run requires. It is exempted by path, not by pattern, so a second
  // casual mention cannot slip in behind it — and it still has to prove it is
  // that step by naming the other required verifiers.
  const TOOL_LIST_STEP = "download.cli.steps[2]";

  it("never mentions curl in the catalogue except to rule it out", () => {
    for (const [lang, m] of Object.entries(locales)) {
      const seen: string[] = [];
      for (const [path, value] of strings(m)) {
        if (!/curl/i.test(value)) continue;
        seen.push(path);
        if (path === TOOL_LIST_STEP) {
          expect(value, `${lang}: ${path} is exempt but is not the tool list`).toMatch(/openssl/);
          expect(value, `${lang}: ${path} is exempt but is not the tool list`).toMatch(/tar/);
          continue;
        }
        expect(
          CURL_CANNOT[lang].test(value),
          `${lang}: ${path} mentions curl without ruling out decryption — "${value}"`,
        ).toBe(true);
      }
      // The negation itself must be one of the strings found, or the rule above
      // is vacuous for this locale.
      expect(seen, `${lang}: the "curl cannot decrypt" sentence is missing`).toContain("download.cli.tempCurlNote");
    }
  });

  it("keeps the Windows guidance honest instead of pretending the block covers it", () => {
    for (const [lang, m] of Object.entries(locales)) {
      const note = m.download.cli.windowsNote;
      expect(note, `${lang}: windowsNote`).toBeTruthy();
      // It must explain the native, pinned verification path rather than saying
      // "not supported" or asking the reader to trust a downloaded hash list.
      expect(note, `${lang}: names PowerShell`).toMatch(/PowerShell/);
      expect(note, `${lang}: names the pinned release`).toContain(WINDOWS_RELEASE);
      expect(note, `${lang}: names the hash check`).toMatch(/SHA-256/);
      expect(note, `${lang}: says the directory is temporary`).toMatch(/temp|临时|一時|임시|temporär|temporaire|مؤقت|temporal|temporári/i);
      expect(note, `${lang}: says why the block above does not apply`).toMatch(/POSIX/);
    }
  });
});

/** Every leaf string in a message table, with a dotted path for the failure. */
function* strings(v: unknown, path = ""): Generator<[string, string]> {
  if (typeof v === "string") yield [path, v];
  else if (Array.isArray(v)) for (let i = 0; i < v.length; i++) yield* strings(v[i], `${path}[${i}]`);
  else if (v && typeof v === "object") {
    for (const [k, val] of Object.entries(v)) yield* strings(val, path ? `${path}.${k}` : k);
  }
  // Functions are skipped: their output is covered by the tests that call them.
}

// ── the wider copy surface ──────────────────────────────────────────────────
//
// `4.2 为什么普通 curl -L <link> -o file 不成立` in the PRD is there because the
// obvious-looking instruction is wrong: the bytes on the other end of a `/d/`
// link are chunk ciphertext behind an encrypted manifest, and the key never
// reaches the server. Any doc that hands such a link to curl is teaching a
// failure. This scan is what stops that sentence from being written again.

const repoFile = (p: string) => readFileSync(resolve(process.cwd(), "..", p), "utf8");

function walk(dir: string): string[] {
  const abs = resolve(process.cwd(), "..", dir);
  const out: string[] = [];
  for (const name of readdirSync(abs)) {
    const full = join(abs, name);
    if (statSync(full).isDirectory()) out.push(...walk(join(dir, name)));
    else if (/\.(mjs|md|txt|ts|svelte)$/.test(name)) out.push(join(dir, name));
  }
  return out;
}

describe("nothing in the docs tells a reader to curl a download link", () => {
  it("finds no curl aimed at a /d/ capability link", () => {
    const sources = [
      // Two shipped message tables since the 2026-08-14 freeze. The archived
      // tables are unbundled and unreachable, so a sentence in one cannot teach
      // a reader anything; the static page corpus below is still walked in
      // full, because those pages ARE public in all nine languages.
      ...["en", "zh"].map((l) => `web/src/lib/i18n/${l}.ts`),
      "web/src/lib/CliPage.svelte",
      // Where /cli's literal commands live since the page was split into
      // components — including its two curl lines, which is exactly the shape
      // this test is looking for.
      "web/src/lib/cli-page-data.ts",
      "web/src/lib/DownloadPage.svelte",
      "web/public/llms.txt",
      "README.md",
      ...walk("web/scripts/pages/content"),
    ];
    // `curl … <something>/d/<id>` or `curl … #k=` — either shape is the mistake.
    const bad = [/curl[^\n]{0,160}\/d\//, /curl[^\n]{0,160}#k=/];
    for (const path of sources) {
      const source = repoFile(path);
      for (const re of bad) {
        const hit = re.exec(source);
        expect(hit === null, `${path}: points curl at a capability link — "${hit?.[0]}"`).toBe(true);
      }
    }
  });
});

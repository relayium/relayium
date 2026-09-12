// A catalogue key that nothing names is copy somebody has to translate twice
// and nobody will ever read.
//
// This product maintains two languages. Every key here is written, reviewed and
// translated, so a key with no reader is not merely untidy — it is recurring
// work with no output.
//
// It is also a DECOY, which is the expensive part. Seventeen of these were found
// on 2026-09-12 and every one had to be traced before it could be removed,
// because a string with no reader looks exactly like a feature that was written
// and never wired. Three of them —
//
//     receivedReveal:  "Show in folder"
//     receivedMissing: "That file is no longer where Relayium put it."
//     receivedFailed:  "Windows would not do that just now."
//
// — read like a whole missing action on the received-files surface, complete
// with its two failure cases, and cost a full trace through `handlers.ts`,
// `received-controller.svelte.ts` and `LinkPane.svelte` to disprove. The button
// exists, is wired to `received.act("reveal", token)`, and says
// `t("recvShowFile")` from the main catalogue instead. Every one of the
// seventeen turned out the same way: superseded by a better replacement.
//
// That is the cost this pin exists to stop paying.
import { readFileSync, globSync } from "node:fs";
import { describe, expect, it } from "vitest";

/** The English half of each catalogue. `zh` parity is a compile error already. */
const CATALOGUES: readonly (readonly [string, string])[] = [
  ["src/renderer/i18n/messages.ts", "en"],
  ["src/renderer/account/messages.ts", "accountEn"],
  ["src/renderer/update/messages.ts", "updateEn"],
  ["src/renderer/pair/messages.ts", "pairEn"],
  ["src/renderer/os-entry/messages.ts", "osEntryEn"],
];

function keysOf(file: string, exported: string): string[] {
  const source = readFileSync(file, "utf8");
  const start = source.indexOf(`export const ${exported}`);
  if (start < 0) throw new Error(`${file} does not export ${exported}`);
  const rest = source.slice(start);
  // The object ends where the next top-level declaration begins.
  const end = rest.slice(20).search(/\n(?:export|const|function|type|interface)\s/);
  const block = end < 0 ? rest : rest.slice(0, 20 + end);
  return [...new Set([...block.matchAll(/^ {2}(\w+):/gm)].map((m) => m[1]!))];
}

describe("every catalogue key is named by something", () => {
  // Renderer source AND the suites: a key used only by a test is still a key
  // with a reader, and deleting it would break that reader.
  const corpus = [...globSync("src/**/*.{ts,svelte}"), ...globSync("test/**/*.{ts,mjs}")]
    .filter((f) => !f.endsWith("messages.ts"))
    .map((f) => readFileSync(f, "utf8"))
    .join("\n");

  it("has a corpus and catalogues to check", () => {
    // Both silent-zero guards. Without them this file passes by finding nothing.
    expect(corpus.length).toBeGreaterThan(100_000);
    expect(CATALOGUES.flatMap(([f, n]) => keysOf(f, n)).length).toBeGreaterThan(500);
  });

  for (const [file, exported] of CATALOGUES) {
    it(`${file} has no unread key`, () => {
      // Quoted (`t("k")`, or a bare value in a `satisfies Record<...>` map) or
      // a property access. There is no dynamic key construction in this app —
      // if that ever changes, this pin has to change with it.
      const dead = keysOf(file, exported).filter(
        (key) => !new RegExp(`["'\`]${key}["'\`]|\\.${key}\\b`).test(corpus),
      );
      expect(dead, "delete it, or wire up the surface it was written for").toEqual([]);
    });
  }
});

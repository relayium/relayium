// A catalogue key that nothing names is copy somebody has to translate and
// nobody will ever read.
//
// This client maintains two languages, so every key here is written, reviewed
// and translated twice. A key with no reader is recurring work with no output —
// and worse, it goes stale silently. `stored.tooMany` said "Up to 1000 files at
// a time; ignored the extra N" for as long as the sender trimmed. When the
// sender was changed on 2026-09-12 to refuse an over-limit batch whole, that
// string survived the change that made it describe the OPPOSITE of what the app
// does, and anyone reading it would have concluded the app still trims.
//
// The Windows client got this pin the same day. It has already failed the build
// twice on its own author's new copy, which is the point: knowing the rule and
// being subject to it are different things.
//
// ## Why the matching is what it is
//
// This catalogue is nested (`stored.copy`, `me.plan`), unlike the flat Windows
// one, and it is read as `t.stored.copy`. So a leaf is looked for as
// `.parent.leaf` first, which is specific enough to mean something; then as
// `.leaf` and as a quoted name, which is looser and only ever makes this pin
// MISS a dead key. Missing one is the safe direction — a pin that cries wolf on
// live copy is a pin that gets deleted.
//
// The archived locales under `i18n/archive/` are deliberately not scanned and
// deliberately not counted as readers. They are frozen translations, and a
// string being present in a language nobody maintains is not evidence that
// anything reads it.
import { readFileSync, globSync } from "node:fs";
import { describe, expect, it } from "vitest";

const CATALOGUE = "src/lib/i18n/en.ts";

/** Leaf keys and their immediate parent, read from the source. */
function leaves(): { parent: string | null; name: string }[] {
  const stack: string[] = [];
  const found: { parent: string | null; name: string }[] = [];
  for (const line of readFileSync(CATALOGUE, "utf8").split("\n")) {
    const open = /^\s*([A-Za-z_$][\w$]*)\s*:\s*\{\s*$/.exec(line);
    if (open) {
      stack.push(open[1]!);
      continue;
    }
    if (/^\s*\},?\s*$/.test(line)) {
      stack.pop();
      continue;
    }
    const leaf = /^\s*([A-Za-z_$][\w$]*)\s*:\s*(["'`(])/.exec(line);
    if (leaf) found.push({ parent: stack[stack.length - 1] ?? null, name: leaf[1]! });
  }
  return found;
}

function corpus(): string {
  const blank = (m: string): string => "\n".repeat((m.match(/\n/g) ?? []).length);
  return globSync("src/**/*.{ts,svelte}")
    .filter((f) => !/i18n[/\\](en|zh|types)\.ts$/.test(f))
    .filter((f) => !f.includes("i18n/archive/") && !f.includes("i18n\\archive\\"))
    .map((f) =>
      readFileSync(f, "utf8")
        // Comments are not readers. The Windows pin learned this the hard way:
        // it passed on a key whose only mention was the comment explaining that
        // the key was gone.
        .replace(/<!--[\s\S]*?-->/g, blank)
        .replace(/\/\*[\s\S]*?\*\//g, " ")
        .split("\n")
        .map((l) => l.replace(/(^|[^:\w])\/\/.*$/, "$1"))
        .join("\n"),
    )
    .join("\n");
}

describe("every catalogue key is named by something", () => {
  it("has a catalogue and a corpus to check", () => {
    // Both silent-zero guards. Without them this file passes by finding nothing
    // to look at, which is the failure mode of every sweep-shaped test.
    expect(leaves().length).toBeGreaterThan(500);
    expect(corpus().length).toBeGreaterThan(200_000);
  });

  it("has no unread key", () => {
    const text = corpus();
    const dead = leaves().filter(({ parent, name }) => {
      if (parent !== null && text.includes(`.${parent}.${name}`)) return false;
      if (text.includes(`.${name}`)) return false;
      return !new RegExp(`["'\`]${name}["'\`]`).test(text);
    });
    expect(
      dead.map((d) => `${d.parent ?? "(top)"}.${d.name}`),
      "delete it, or wire up the surface it was written for",
    ).toEqual([]);
  });
});

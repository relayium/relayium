// A field named for a fault is not copy, and a template must not render it.
//
// Two surfaces shipped with exactly this bug, found within an hour of each
// other:
//
// * `AccountPage.svelte` rendered `{phase.message}`, into which flowed
//   `String(err)` — an Electron IPC rejection, wrapper text and all.
// * `InboxPage.svelte` rendered `{handle.reason}`, whose contract said "the
//   stable code the teardown failed with" and whose producer is
//   `codeOf(error) ?? "cleanup-uncertain"` — `error.code` verbatim, so a person
//   read `EBUSY` as the row's entire explanation.
//
// Both were English-only at best and unbounded OS text at worst, on a product
// that ships in two languages. Neither was caught by a type: the field is a
// `string` and a `string` renders.
//
// So the rule is structural and checked here: a text interpolation may not be a
// bare field whose name says it carries a fault. Map the code to a catalogue
// key — every other surface in this app already does, `laneError`, `noticeText`
// and `joinError` among them.
import { readFileSync, globSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Names that mean "why something failed" rather than "what the user has".
 *
 * `code` is deliberately NOT here. A pairing code and a device code are things
 * a person reads and types, and `{minted.code}` on the Pairing screen is
 * exactly right — a rule that flags it would be turned off rather than obeyed.
 */
const FAULT = /^[\w.]*\b(reason|message|detail|details|error|failure|cause|stack)$/i;

function textInterpolations(source: string): { line: number; expr: string }[] {
  const blank = (m: string): string => "\n".repeat((m.match(/\n/g) ?? []).length);
  // Script and style are not on screen; tags carry attributes, which are not
  // copy either. What is left is the text a person reads.
  const markup = source
    .replace(/<script[\s\S]*?<\/script>/g, blank)
    .replace(/<style[\s\S]*?<\/style>/g, blank)
    .replace(/<[^>]*>/gs, blank);
  const found: { line: number; expr: string }[] = [];
  markup.split("\n").forEach((line, i) => {
    for (const m of line.matchAll(/\{([^{}]+)\}/g)) {
      const expr = m[1]!.trim();
      if (/^[#/:@]/.test(expr)) continue;
      found.push({ line: i + 1, expr });
    }
  });
  return found;
}

describe("a fault code is never a template's text", () => {
  const files = globSync("src/renderer/**/*.svelte");

  it("has templates to check", () => {
    // A silent zero would make every assertion below pass by finding nothing.
    expect(files.length).toBeGreaterThan(5);
    const total = files.reduce((n, f) => n + textInterpolations(readFileSync(f, "utf8")).length, 0);
    expect(total).toBeGreaterThan(50);
  });

  it("renders no bare fault field", () => {
    const offenders: string[] = [];
    for (const file of files) {
      for (const { line, expr } of textInterpolations(readFileSync(file, "utf8"))) {
        if (!FAULT.test(expr)) continue;
        offenders.push(`${file}:${line}  {${expr}}`);
      }
    }
    expect(offenders, "map the code to a catalogue key instead").toEqual([]);
  });

  it("recognises the two forms that shipped, so the rule is not vacuous", () => {
    const sample = `
      <p>{phase.message}</p>
      <span>{handle.reason}</span>
      <span>{t("fine")}</span>
      <span>{file.name}</span>
      <span>{RESIDUE_KEY[handle.residue]}</span>
    `;
    const caught = textInterpolations(sample)
      .filter((x) => FAULT.test(x.expr))
      .map((x) => x.expr);
    expect(caught).toEqual(["phase.message", "handle.reason"]);
  });
});

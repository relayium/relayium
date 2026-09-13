// A regex written as a VALUE inside an equality matcher asserts nothing.
//
// `expect(x).toMatchObject({ message: /wanted/ })` reads like a substring
// check. It is not one: `toMatchObject`, `toEqual` and `toStrictEqual` compare
// a RegExp against a string by structural equality, and a RegExp is never
// structurally equal to a string, so vitest falls through to "close enough"
// and the property passes for ANY string. The substring check people mean is
// `expect.stringMatching(/wanted/)`, or `toMatch` on the property itself.
//
// This is not hypothetical. `sign-in-controller.test.ts` carried
//
//     expect(d.controller.phase).toMatchObject({
//       kind: "failed",
//       message: /could not remove the credential/ as unknown as string,
//     });
//
// for the whole life of that file. It checked `kind` and nothing else, which
// is why nobody noticed that the string it was "checking" was internal
// diagnostic text being rendered on the account screen.
//
// The `as unknown as string` is the tell, and it is the tell in general: a cast
// written to get an assertion past the type checker is a good moment to ask
// whether the runtime agrees with what the assertion appears to say.
import { readFileSync } from "node:fs";
import { globSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("a RegExp as a value in an equality matcher", () => {
  it("accepts a string that does not match, which is why it is banned", () => {
    // The proof, so this file states a fact about vitest rather than a belief.
    let threw = false;
    try {
      expect({ message: "nothing like the pattern" }).toMatchObject({
        message: /could not remove the credential/ as unknown as string,
      });
    } catch {
      threw = true;
    }
    expect(threw, "vitest changed: toMatchObject now honours a RegExp value").toBe(false);
  });

  it("is honoured by the forms that should be used instead", () => {
    expect({ message: "could not remove the credential" }).toMatchObject({
      message: expect.stringMatching(/could not remove/) as unknown as string,
    });
    let threw = false;
    try {
      expect({ message: "nothing like the pattern" }).toMatchObject({
        message: expect.stringMatching(/could not remove/) as unknown as string,
      });
    } catch {
      threw = true;
    }
    expect(threw, "expect.stringMatching must reject a non-matching string").toBe(true);
  });

  it("appears nowhere in this suite", () => {
    const files = globSync("test/**/*.{ts,mjs}").filter(
      (f) => !f.endsWith("vacuous-matchers.test.ts"),
    );
    // Enough files to prove the glob resolved. A silent zero here would make
    // this pin pass by finding nothing to look at.
    expect(files.length).toBeGreaterThan(20);

    const offenders: string[] = [];
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      const lines = source.split("\n");
      let open = -1;
      let depth = 0;
      let buffer = "";
      lines.forEach((line, index) => {
        if (/\.(toMatchObject|toEqual|toStrictEqual)\(/.test(line)) {
          open = index;
          depth = 0;
          buffer = "";
        }
        if (open < 0) return;
        buffer += `${line}\n`;
        for (const ch of line) {
          if (ch === "(") depth += 1;
          if (ch === ")") depth -= 1;
        }
        if (depth > 0 || !buffer.includes("(")) return;
        // A regex literal sitting where a value goes: `key: /.../`
        if (/:\s*\/(?:[^/\\\n]|\\.)+\/[gimsuy]*\s*(?:as\b[^,}]*)?[,}\n]/.test(buffer)) {
          offenders.push(`${file}:${open + 1}`);
        }
        open = -1;
      });
    }
    expect(offenders, "use expect.stringMatching(...) or toMatch on the property").toEqual([]);
  });
});

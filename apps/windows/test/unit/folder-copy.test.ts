// Which folder problem the Inbox reports, in words.
//
// Three situations with three different fixes — reconnect the drive or choose
// again, move whatever file took the path, free space or fix permissions —
// used to be one sentence saying the folder was not there. It was false for
// two of them, and the third could not occur at all because writability was
// never checked.
import { describe, expect, it } from "vitest";

import { folderProblemCopy } from "../../src/renderer/inbox/folder-copy.js";
import type { FolderProblem } from "../../src/shared/ipc-contract.js";
import { en, zh } from "../../src/renderer/i18n/messages.js";

const PROBLEMS: readonly FolderProblem[] = ["missing", "not-a-directory", "not-writable"];

describe("what the Inbox says about its folder", () => {
  it("answers every problem, in both maintained languages", () => {
    for (const problem of PROBLEMS) {
      const { title, body } = folderProblemCopy(problem);
      for (const [name, cat] of [["en", en], ["zh", zh]] as const) {
        expect(cat[title], `${name}/${problem}`).toBeTruthy();
        expect(cat[body], `${name}/${problem}`).toBeTruthy();
      }
      expect(zh[title], problem).not.toBe(en[title]);
      expect(zh[body], problem).not.toBe(en[body]);
    }
  });

  it("gives all three their own title and body", () => {
    expect(new Set(PROBLEMS.map((p) => folderProblemCopy(p).title)).size).toBe(PROBLEMS.length);
    expect(new Set(PROBLEMS.map((p) => folderProblemCopy(p).body)).size).toBe(PROBLEMS.length);
  });

  it("does not tell somebody a present folder is missing", () => {
    // The two the old sentence was wrong about. A folder that is right where
    // the user left it, and a path a file has taken over, both said "not
    // there" — which sends them looking for something that has not moved.
    const missing = folderProblemCopy("missing");
    for (const problem of ["not-a-directory", "not-writable"] as const) {
      expect(folderProblemCopy(problem).title, problem).not.toBe(missing.title);
      expect(en[folderProblemCopy(problem).body].toLowerCase(), problem).not.toContain("cannot be found");
    }
  });

  it("names both causes for an unwritable folder", () => {
    // Permissions and a full disk need different actions, and `access(W_OK)`
    // cannot tell them apart — so the sentence names both rather than picking
    // one and being wrong half the time.
    const said = en[folderProblemCopy("not-writable").body].toLowerCase();
    expect(said).toContain("permission");
    expect(said).toContain("full");
  });

  it("keeps saying receiving is still ON", () => {
    // The user's answer is still their answer. None of these is `disabled`,
    // and a sentence implying receiving turned itself off would be a lie about
    // a setting they made.
    for (const problem of PROBLEMS) {
      expect(en[folderProblemCopy(problem).body].toLowerCase(), problem).toContain("receiving is still on");
    }
  });
});

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { present, type NotificationEvent } from "../../src/main/notifications.js";
import { translator } from "../../src/main/l10n.js";

const t = translator("en");

describe("an upload that finished says so, and says nothing else", () => {
  it("names neither the link nor anything in it", () => {
    // The link IS the secret: its fragment carries the key. A notification is
    // shown on a lock screen, read by whoever is standing there, and kept by
    // the system after it is dismissed — so this says there is something to
    // collect and where, and nothing about what.
    for (const locale of ["en", "zh-Hans"] as const) {
      const content = present({ kind: "link-ready" }, translator(locale));
      const said = `${content.title} ${content.body}`;
      expect(said).not.toMatch(/https?:/i);
      expect(said).not.toContain("#");
      expect(said).not.toMatch(/\/d\//);
      expect(content.title.trim()).not.toBe("");
      expect(content.body.trim()).not.toBe("");
    }
  });

  it("is its own event rather than a reused one", () => {
    // "Files saved" describes a RECEIVE. Announcing an upload with it would
    // tell the sender that something arrived, which is the other direction.
    const ready = present({ kind: "link-ready" }, t);
    const saved = present({ kind: "saved", files: 1 }, t);
    expect(ready.title).not.toBe(saved.title);
    expect(ready.body).not.toBe(saved.body);
  });
});

describe("notifications say counts and closed codes, nothing else", () => {
  it("renders every case in both languages", () => {
    const events: NotificationEvent[] = [
      { kind: "saved", files: 3 },
      { kind: "saved-message" },
      { kind: "attention" },
      { kind: "failed" },
      { kind: "link-ready" },
    ];
    for (const event of events) {
      for (const locale of ["en", "zh-Hans"] as const) {
        const content = present(event, translator(locale));
        expect(content.title.trim()).not.toBe("");
        expect(content.body.trim()).not.toBe("");
      }
    }
  });

  it("never varies with a file count", () => {
    // A count would be safe to show; formatting one here would not be, because
    // that is the seam a filename would later arrive through.
    const one = present({ kind: "saved", files: 1 }, t);
    const many = present({ kind: "saved", files: 4096 }, t);
    expect(one).toEqual(many);
  });

  it("says nothing about a message beyond where to read it", () => {
    const content = present({ kind: "saved-message" }, t);
    // Its OWN keys: reusing the files title said "Files saved" for a message.
    expect(content.title).toBe("Message received");
    expect(content.body).toBe("Open Relayium to read it.");
  });

  /**
   * The textual guard, mirroring `InboxSurfaceGuardTests` on macOS. A leak
   * cannot be caught by rendering the cases we thought of; it is caught by the
   * module having no place to put a value.
   */
  it("the module contains no interpolation at all", () => {
    const source = readFileSync(
      fileURLToPath(new URL("../../src/main/notifications.ts", import.meta.url)),
      "utf8",
    );
    const code = source
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("//") && !line.trimStart().startsWith("*"))
      .join("\n");
    expect(code).not.toMatch(/`[^`]*\$\{/);
    expect(code).not.toMatch(/\+\s*event\./);
  });
});

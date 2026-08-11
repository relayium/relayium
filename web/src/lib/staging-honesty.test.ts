import { describe, it, expect } from "vitest";
import { LANGS, type Lang, type Messages } from "./i18n.svelte";
// Language tables are code-split, so the live `messages` record is empty until
// something loads a locale at runtime. These checks want all nine
// synchronously, so import the split modules and reassemble — same approach as
// i18n.test.ts.
import zh from "./i18n/zh";
import en from "./i18n/en";
import ja from "./i18n/ja";
import ko from "./i18n/ko";
import de from "./i18n/de";
import fr from "./i18n/fr";
import ar from "./i18n/ar";
import es from "./i18n/es";
import pt from "./i18n/pt";

const messages: Record<Lang, Messages> = { zh, en, ja, ko, de, fr, ar, es, pt };

// Two notes about staged files, on two surfaces, saying deliberately different
// things. Getting them mixed up is the failure this file exists to catch.
//
//   lanStagedNote  — LAN. A standing owner promise (2026-08-11): staged LAN
//                    files are local and must never become an upload, because
//                    free LAN transfer is the point. It MAY also say the bytes
//                    go directly to the other device, because on a LAN they do.
//
//   pair.stageNote — code room. Says only that the transfer starts by itself on
//                    join, and stays silent about where the bytes are, because
//                    that is exactly what pre-upload changes. It must not
//                    inherit the LAN promise, and it must not claim a direct
//                    path: a cross-network room relays through TURN.
describe("what the two staged-file notes are allowed to promise", () => {
  it("defines both notes in every language", () => {
    for (const { code } of LANGS) {
      for (const [where, s] of [
        [`${code}.lanStagedNote`, messages[code].lanStagedNote],
        [`${code}.pair.stageNote`, messages[code].pair.stageNote],
      ] as const) {
        expect(s, `${where} has copy`).toBeTruthy();
        expect(s.trim(), `${where} is trimmed`).toBe(s);
      }
    }
  });

  it("never reuses the LAN promise as the code-room note", () => {
    // The cheap mistake: one string for both surfaces. It would be a false
    // statement in a code room the moment pre-upload ships.
    for (const { code } of LANGS) {
      expect(messages[code].pair.stageNote, `${code} reuses the LAN promise`)
        .not.toBe(messages[code].lanStagedNote);
    }
  });

  it("keeps the code-room note free of claims that pre-upload would falsify", () => {
    // English only: this asserts the wording of specific claims, and the other
    // eight are held to the shape by the two tests above plus review. "upload"
    // is checked in both directions — the note may not promise no upload today,
    // and must not advertise one either, since neither is true of every path.
    const note = messages.en.pair.stageNote.toLowerCase();
    for (const banned of ["upload", "directly", "peer to peer", "this device"]) {
      expect(note, `en.pair.stageNote must not claim "${banned}"`).not.toContain(banned);
    }
  });

  it("keeps the LAN note an explicit no-upload promise", () => {
    const note = messages.en.lanStagedNote.toLowerCase();
    expect(note).toContain("never uploads");
    expect(note).toContain("this device");
  });
});

// The sender half of pre-upload adds the first two lines in the waiting room
// that talk about bytes leaving the device. Both are held to what actually
// happened, because both appear at moments the user cannot verify for
// themselves: one while ciphertext is going up, one after the server deleted it.
describe("what the pre-upload lines are allowed to say", () => {
  it("defines both in every language", () => {
    for (const { code } of LANGS) {
      const progress = messages[code].pair.preuploading("photo.jpg", 42);
      const expired = messages[code].pair.preuploadExpired;
      for (const [where, s] of [
        [`${code}.pair.preuploading`, progress],
        [`${code}.pair.preuploadExpired`, expired],
      ] as const) {
        expect(s, `${where} has copy`).toBeTruthy();
        expect(s.trim(), `${where} is trimmed`).toBe(s);
      }
      expect(progress, `${code} progress names the file`).toContain("photo.jpg");
      expect(progress, `${code} progress shows how far`).toContain("42");
    }
  });

  it("never says a pre-upload that expired was delivered", () => {
    // The state it describes: bytes went up, the room's deadline passed, the
    // server deleted that ciphertext, and the files are back in the live-link
    // lane needing a fresh code. Anything that reads as "sent" is a lie about
    // the one case where nothing arrived.
    const note = messages.en.pair.preuploadExpired.toLowerCase();
    for (const banned of ["delivered", "sent successfully", "received"]) {
      expect(note, `en.pair.preuploadExpired must not claim "${banned}"`).not.toContain(banned);
    }
    // ...and it has to say what to do next, or it is just a dead end.
    expect(note).toContain("new code");
  });
});

// web/src/lib/i18n-device-inbox.test.ts — the Device Inbox sender copy, in all
// nine languages.
//
// Two claims in this section are product requirements rather than wording, and
// a translation that loses either is a lie only speakers of that language will
// ever see:
//
//  1. **Uploaded is not saved.** PRD §10 forbids one vague word covering both
//     "the ciphertext reached Relayium" and "the target device wrote the file to
//     disk". `uploadedNotSaved` is the sentence that keeps them apart, and it is
//     shown under EVERY non-saved server state.
//  2. **Offline is not rejected.** An offline device is still a valid target;
//     the file queues. Copy that reads as "cannot" would undo the entire reason
//     the asynchronous queue exists (PRD §7.3).
//
// The per-language tables are hand-written on purpose: "this translation still
// says that" only counts when someone has read it and written down how that
// language says it. A structural check that every key exists is the weaker
// second half of this file, not the whole of it.
import { describe, expect, it } from "vitest";
import en from "./i18n/en";
import zh from "./i18n/zh";
import ja from "./i18n/ja";
import ko from "./i18n/ko";
import de from "./i18n/de";
import fr from "./i18n/fr";
import ar from "./i18n/ar";
import es from "./i18n/es";
import pt from "./i18n/pt";
import type { Messages } from "./i18n/types";

const locales = { en, zh, ja, ko, de, fr, ar, es, pt };
type Code = keyof typeof locales;

const NAME = "Lily's MacBook — 家里那台";
const WHEN = "2026-08-09 10:00";

type Claims = {
  /** "…is on Relayium, the device has not saved it" — never a bare "sent". */
  notSaved: RegExp;
  /** Offline means the file WAITS, not that sending is refused. */
  queues: RegExp;
  /** The only string allowed to claim the file landed. */
  saved: RegExp;
  /** Cancelling a delivery destroys the queued ciphertext — the confirmation
   *  has to say so, in every language, before the button is pressed. */
  cancelDestroys: RegExp;
  /** Automatic receive can only be turned on at the device itself (PRD §8). */
  enableThere: RegExp;
  /** Names and folders never reach Relayium. */
  namesStayLocal: RegExp;
};

const claims: Record<Code, Claims> = {
  en: {
    notSaved: /not saved on the device yet/i,
    queues: /waits in the queue/i,
    saved: /Saved on the device/i,
    cancelDestroys: /deleted from the server/i,
    enableThere: /Turn it on there/i,
    namesStayLocal: /never receives them/i,
  },
  zh: {
    notSaved: /设备还没保存/,
    queues: /先排队/,
    saved: /已保存到设备/,
    cancelDestroys: /密文会被删除/,
    enableThere: /只能在那台设备上打开/,
    namesStayLocal: /从不接收它们/,
  },
  ja: {
    notSaved: /まだ保存されていません/,
    queues: /キューで待ち/,
    saved: /デバイスに保存されました/,
    cancelDestroys: /暗号文は削除され/,
    enableThere: /そのデバイス上だけ/,
    namesStayLocal: /受け取ることはありません/,
  },
  ko: {
    notSaved: /아직 저장되지 않았습니다/,
    queues: /대기열에서 기다렸다가/,
    saved: /기기에 저장됨/,
    cancelDestroys: /암호문이 삭제되고/,
    enableThere: /그 기기에서만 켤 수 있고/,
    namesStayLocal: /절대 받지 않습니다/,
  },
  de: {
    notSaved: /noch nicht gespeichert/i,
    queues: /wartet .* in der Warteschlange/i,
    saved: /Auf dem Gerät gespeichert/i,
    cancelDestroys: /vom Server gelöscht/i,
    enableThere: /nur dort einschalten/i,
    namesStayLocal: /erhält sie nie/i,
  },
  fr: {
    notSaved: /pas encore enregistré/i,
    queues: /attend dans la file/i,
    saved: /Enregistré sur l'appareil/i,
    cancelDestroys: /supprimées du serveur/i,
    enableThere: /ne s'active que là-bas/i,
    namesStayLocal: /ne les reçoit jamais/i,
  },
  ar: {
    notSaved: /لم يُحفَظ على الجهاز بعد/,
    queues: /ينتظر الملف في الطابور/,
    saved: /حُفِظ على الجهاز/,
    cancelDestroys: /ستُحذَف البيانات المشفّرة من الخادم/,
    enableThere: /لا يمكن تفعيله إلا هناك/,
    namesStayLocal: /لا يستلمها Relayium أبدًا/,
  },
  es: {
    notSaved: /todavía no está guardado/i,
    queues: /espera en la cola/i,
    saved: /Guardado en el dispositivo/i,
    cancelDestroys: /se borran del servidor/i,
    enableThere: /Solo se puede activar allí/i,
    namesStayLocal: /nunca los recibe/i,
  },
  pt: {
    notSaved: /ainda não salvo/i,
    queues: /espera na fila/i,
    saved: /Salvo no dispositivo/i,
    cancelDestroys: /são apagados do servidor/i,
    enableThere: /Só dá para ligar lá/i,
    namesStayLocal: /nunca os recebe/i,
  },
};

describe.each(Object.keys(locales) as Code[])("%s Device Inbox copy", (code) => {
  const m: Messages = locales[code];
  const d = m.deviceInbox;
  const c = claims[code];

  it("separates 'uploaded to Relayium' from 'saved on the device'", () => {
    expect(d.uploadedNotSaved).toMatch(c.notSaved);
    expect(d.stateSaved).toMatch(c.saved);
    expect(d.stateSavedAt(WHEN)).toContain(WHEN);
    // The queued state is about waiting; on its own it must not read as arrival.
    expect(d.stateQueued).not.toMatch(c.saved);
  });

  it("says an offline device queues rather than refuses", () => {
    expect(d.caveatQueued).toMatch(c.queues);
  });

  it("says automatic receive is enabled at the device, not from here", () => {
    expect(d.blockReceiveOff).toMatch(c.enableThere);
  });

  it("warns that cancelling destroys the queued ciphertext", () => {
    const text = d.cancelTaskConfirm(NAME);
    expect(text).toContain(NAME);
    expect(text).toMatch(c.cancelDestroys);
  });

  it("states that names and folders never reach Relayium", () => {
    expect(d.privacyNote).toMatch(c.namesStayLocal);
  });

  it("interpolates the device name into every control that names one", () => {
    for (const f of [d.sendButtonLabel, d.progressLabel, d.cancelLabel, d.cancelTaskLabel, d.cancelTaskConfirm]) {
      expect(f(NAME)).toContain(NAME);
    }
  });

  it("shows the percentage in both local phases", () => {
    expect(d.phaseEncrypting(42)).toContain("42");
    expect(d.phaseUploading(99)).toContain("99");
  });

  it("counts files in the summary without ever naming one", () => {
    expect(d.fileSummary(1, "1.2 MB")).toContain("1.2 MB");
    expect(d.fileSummary(3, "9 MB")).toContain("3");
  });
});

// The structural half: every key present, non-empty, and of the declared shape
// in every language. This is what catches a locale that was simply never
// updated, which the hand-written claims above cannot — they only run against
// the strings that exist.
describe("every locale carries the whole section", () => {
  const stringKeys = [
    "sectionHint", "online", "offline", "neverSeen", "policyLabel", "policyOff", "policyAsk",
    "policyAuto", "dirReady", "dirNotReady", "blockNotEnrolled", "blockRevoked",
    "blockCannotReceive", "blockUnsupportedKey", "blockUnsupportedCapability", "blockReceiveOff",
    "blockUnsupported", "caveatQueued", "caveatApproval", "caveatDirNotReady", "sendButton",
    "dropHint", "dropActive", "dropRejected", "phaseRegistering", "cancel", "uploadedNotSaved",
    "stateQueued", "stateNotified", "stateDownloading", "stateVerifying", "stateSaved",
    "stateAttention", "stateExpired", "stateRevoked", "stateFailedRetryable", "stateFailedTerminal",
    "stateUnknown", "errDownloadFailed", "errDecryptFailed", "errVerifyFailed", "errDiskFull",
    "errPermissionDenied", "errDirectoryUnavailable", "errNameConflict", "errUserDeclined",
    "errUnsupported", "errInternal", "errLeaseExpired", "errAttemptsExhausted", "errKeyRevoked",
    "errStoredObjectUnavailable", "errUnknown", "sendErrAutoReceiveDisabled",
    "sendErrDeviceCannotReceive", "sendErrDeviceInboxRevoked", "sendErrStaleTargetKey",
    "sendErrIdempotencyConflict", "sendErrStoredObjectUnavailable", "sendErrStoredObjectAlreadyBound",
    "sendErrQueueFull", "sendErrUnsupportedKeyAlgorithm", "sendErrUnsupportedAutoAcceptCapability",
    "sendErrMalformedWrappedKey", "sendErrInvalidIdempotencyKey", "sendErrTooLarge", "sendErrQuota",
    "sendErrSignedOut", "sendErrNetwork", "sendErrCancelled", "sendErrUnsupportedKey",
    "sendErrNoFiles", "sendErrUnknown", "cancelTask", "cancelTaskFailed", "dismiss", "privacyNote",
  ] as const;

  it.each(Object.keys(locales) as Code[])("%s", (code) => {
    const d = locales[code].deviceInbox as unknown as Record<string, unknown>;
    for (const k of stringKeys) {
      expect(typeof d[k], `${code}.deviceInbox.${k} is not a string`).toBe("string");
      expect(String(d[k]).trim().length, `${code}.deviceInbox.${k} is empty`).toBeGreaterThan(0);
    }
    for (const k of ["lastSeen", "platformLine", "sendButtonLabel", "phaseEncrypting", "phaseUploading",
      "progressLabel", "cancelLabel", "stateSavedAt", "cancelTaskLabel", "cancelTaskConfirm", "fileSummary"]) {
      expect(typeof d[k], `${code}.deviceInbox.${k} is not a function`).toBe("function");
    }
  });

  it("no two locales share a translated sentence by accident", () => {
    // A copy-pasted locale would pass every structural check above. Comparing
    // the section hint — one long, distinctive sentence — catches it. English
    // loan words legitimately repeat, so only this one string is compared.
    const hints = (Object.keys(locales) as Code[]).map((c) => locales[c].deviceInbox.sectionHint);
    expect(new Set(hints).size, "two locales carry the identical section hint").toBe(hints.length);
  });
});

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, beforeEach } from "vitest";
import {
  shownSasCode,
  needsSendConfirmation,
  autoAcceptsIncomingText,
  autoAcceptsIncomingFile,
} from "./verify-gates";
import { verifyPeers, setVerifyPeers, reloadVerifyPeers } from "./verify-pref.svelte";

const app = readFileSync(resolve(process.cwd(), "src/App.svelte"), "utf8");

describe("the advanced-verification preference", () => {
  beforeEach(() => {
    localStorage.clear();
    reloadVerifyPeers();
  });

  it("is OFF on a device that has never touched it", () => {
    expect(verifyPeers()).toBe(false);
  });

  it("turns on, persists, and turns back off", () => {
    setVerifyPeers(true);
    expect(verifyPeers()).toBe(true);
    // A fresh page load reads storage, not memory.
    reloadVerifyPeers();
    expect(verifyPeers()).toBe(true);

    setVerifyPeers(false);
    reloadVerifyPeers();
    expect(verifyPeers()).toBe(false);
    // Off is the ABSENCE of the key, not a "0" — an unreadable store then means
    // the same thing as a store that was never written, which is the default.
    expect(localStorage.getItem("relayium.verify.on")).toBeNull();
  });

  it("stays OFF when storage throws, rather than guessing", () => {
    const real = Storage.prototype.getItem;
    Storage.prototype.getItem = () => { throw new Error("blocked"); };
    try {
      reloadVerifyPeers();
      expect(verifyPeers()).toBe(false);
    } finally {
      Storage.prototype.getItem = real;
    }
  });
});

describe("what default-off changes", () => {
  it("shows no SAS at all, and opt-in restores the exact code", () => {
    expect(shownSasCode(false, "483920")).toBe("");
    expect(shownSasCode(true, "483920")).toBe("483920");
    // A link with no code yet renders nothing either way — the ON path must not
    // render an empty verification box while the handshake is still running.
    expect(shownSasCode(true, "")).toBe("");
  });

  it("auto-offers a queued batch in a code room, and opt-in restores the confirmation", () => {
    // LAN (no room code) was always frictionless and stays that way in both modes.
    expect(needsSendConfirmation(false, null)).toBe(false);
    expect(needsSendConfirmation(true, null)).toBe(false);
    // A cross-network code room is where the confirmation lived.
    expect(needsSendConfirmation(false, "483920")).toBe(false);
    expect(needsSendConfirmation(true, "483920")).toBe(true);
  });

  it("auto-accepts an incoming text request, and opt-in restores accept/reject", () => {
    expect(autoAcceptsIncomingText(false, "incomingRequest")).toBe(true);
    expect(autoAcceptsIncomingText(true, "incomingRequest")).toBe(false);
    // And only that one state: nothing else in the session is auto-driven.
    for (const status of ["idle", "connecting", "waitingAccept", "open", "ended", "refused"]) {
      expect(autoAcceptsIncomingText(false, status), status).toBe(false);
    }
  });

  // The line this whole change must not cross — in this client. The native app
  // has no equivalent step (see verify-gates.ts), so this is a browser rule.
  it("never auto-accepts a file in the browser, in any mode", () => {
    expect(autoAcceptsIncomingFile()).toBe(false);
    // Stated as a source contract too, because the risk is not that this
    // function starts returning true — it is that some future branch stops
    // asking it. The consent card and its buttons must remain unconditional.
    const surface = app.slice(
      app.indexOf("{#snippet transferSurface()}"),
      app.indexOf("{/snippet}", app.indexOf("{#snippet transferSurface()}")),
    );
    const card = surface.slice(surface.indexOf("{#if incoming}"), surface.indexOf("{#each [send, recv]"));
    expect(card).toContain("<ReceiveActions");
    expect(card).toContain("onAccept={() => workspace.acceptFile()}");
    // The preference may hide the legacy in-card SAS box and nothing else in
    // this card: no `verifyOn` guard may reach the manifest or the buttons.
    const afterSasBox = card.slice(card.indexOf("<ReceiveActions"));
    expect(afterSasBox).not.toMatch(/verifyOn|shownSas/);
    // The auto-accept effect targets text and nothing else. It reads and accepts
    // the session the panel is showing (`surfaceText`/`acceptSurfaceText`) so a
    // retained legacy conversation cannot be auto-accepted out of sight — see
    // workspace-orchestration.test.ts.
    expect(app).toContain("autoAcceptsIncomingText(verifyOn, surfaceText.status)) acceptSurfaceText()");
    expect(app).not.toMatch(/autoAccepts\w*\([^)]*\)\)\s*workspace\.acceptFile\(\)/);
  });
});

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
// The one section of this file that EXECUTES rather than reads: the relay
// commit rule is behaviour, and the two lanes' reads of it are three lines App
// declares and hands out. See the last describe block.
import { chooseRtcConfig, type RelayEntry } from "./ice";
import { createRelaySelection } from "./relay-selection";

// Source contract, like activity-visibility.test.ts and
// workspace-presentation.test.ts: these rules are about which nodes exist in
// which BRANCH, and about the order of statements inside one synchronous
// handler. A rendered snapshot of a single state cannot show either, and App
// itself is not mountable here (it owns the signalling socket, the ICE fetch and
// the service-worker registration).
//
// What behaviour is proved elsewhere, so this file does not have to fake it:
//   - the once-per-link launcher rule → unified-text-open.test.ts
//   - the routing/exclusion policy it reads → peer-workspace.test.ts
//   - the panel's unified mode, attachments and restart → MessagePanel.test.ts
const app = readFileSync(resolve(process.cwd(), "src/App.svelte"), "utf8");
/** The pre-upload lane decision App used to inline. Its behaviour is executed in
 *  handoff-lane.test.ts; what is asserted from the text here is only the pair of
 *  statements App's own contract depends on — which lane releases, and in which
 *  order it releases and drains. */
const lane = readFileSync(resolve(process.cwd(), "src/lib/handoff-lane.svelte.ts"), "utf8");
const surface = app.slice(
  app.indexOf("{#snippet transferSurface()}"),
  app.indexOf("{/snippet}", app.indexOf("{#snippet transferSurface()}")) + "{/snippet}".length,
);
const card = app.slice(
  app.indexOf("{#snippet peerCard("),
  app.indexOf("{/snippet}", app.indexOf("{#snippet peerCard(")) + "{/snippet}".length,
);
const fn = (name: string): string => {
  const at = app.indexOf(`function ${name}(`);
  expect(at, `${name} is missing from App.svelte`).toBeGreaterThan(-1);
  const open = app.indexOf("{", at);
  let depth = 0;
  for (let i = open; i < app.length; i++) {
    if (app[i] === "{") depth++;
    else if (app[i] === "}" && --depth === 0) return app.slice(at, i + 1);
  }
  throw new Error(`unbalanced braces in ${name}`);
};
/** Statements only: these rules are about what App DOES, and the prose beside a
 *  rule names the very calls it is a rule about. */
const code = (text: string) =>
  text.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
/** The statements between two anchors — a declaration block rather than a
 *  function body, which is what a dependency object is. */
const block = (from: string, to: string): string => {
  const at = app.indexOf(from);
  expect(at, `${from} is missing from App.svelte`).toBeGreaterThan(-1);
  const end = app.indexOf(to, at);
  expect(end, `${to} no longer follows ${from} in App.svelte`).toBeGreaterThan(at);
  return code(app.slice(at, end));
};

/** The room-binding effect's statements, up to the switch it ends with. */
const roomEffect = (): string => {
  const at = app.indexOf("if (key === socketRoomKey) return;");
  expect(at, "the room-binding effect is missing from App.svelte").toBeGreaterThan(-1);
  return code(app.slice(at, app.indexOf("void switchRoom();", at)));
};
/**
 * The auto-send effect's statements.
 *
 * Comment lines removed for the same reason as everywhere else here: the prose
 * beside these rules names the very expressions that were replaced, and a
 * substring search cannot tell a rule from the wrong question it forbids.
 */
const autoSendEffect = (): string => {
  const at = app.indexOf("let dismissedPeerId = $state<string | null>(null);");
  expect(at, "the auto-send effect is missing from App.svelte").toBeGreaterThan(-1);
  return code(app.slice(at, app.indexOf("});", app.indexOf("$effect(", at)) + 3));
};
const panel = surface.slice(
  surface.indexOf("<MessagePanel"),
  surface.indexOf("/>", surface.indexOf("<MessagePanel")) + 2,
);
const autoOpenEffect = app.slice(
  app.indexOf("$effect(", app.indexOf("const textOpener = createUnifiedTextOpener();")),
  app.indexOf("});", app.indexOf("$effect(", app.indexOf("const textOpener = createUnifiedTextOpener();"))) + 3,
);

describe("link-capable LAN peer card", () => {
  it("offers exactly one primary action and no file/folder/message fork", () => {
    expect(card).toContain("{@const unifiedPeer = workspace.routes(p.id)}");
    // One intentionally named action for E2E and for anyone reading the DOM.
    expect(app.match(/class="[^"]*\bopen-workspace\b/g)).toHaveLength(1);
    const actions = card.slice(card.indexOf('<div class="peer-actions">'));
    const branch = actions.indexOf("{#if unifiedPeer}");
    const fork = actions.indexOf("{:else}");
    expect(branch).toBeGreaterThan(-1);
    expect(fork).toBeGreaterThan(branch);
    // The single action is inside the unified branch…
    expect(actions.indexOf("open-workspace")).toBeGreaterThan(branch);
    expect(actions.indexOf("open-workspace")).toBeLessThan(fork);
    // …and every legacy control is behind the else, so a link-capable peer
    // cannot render both.
    for (const legacy of ["pa-files", "webkitdirectory", "workspace.openText(p.id)"]) {
      expect(actions.indexOf(legacy), legacy).toBeGreaterThan(fork);
    }
  });

  it("keeps the pairing/legacy card's file, folder and message controls exactly", () => {
    const actions = card.slice(card.indexOf('<div class="peer-actions">'));
    const legacy = actions.slice(actions.indexOf("{:else}"));
    // The three controls, their existing ids, their existing disabled rule and
    // the platform gate on the folder picker are all unchanged.
    expect(legacy).toContain('id={`pick-${p.id}`}');
    expect(legacy).toContain("onchange={(e) => pickFile(e, p.id)}");
    expect(legacy).toContain("{#if folderUploadSupported}");
    expect(legacy).toContain("{#if workspace.routes(p.id) || peerSupportsText(p.id)}");
    expect(legacy).toContain('{ textCompose = ""; void workspace.openText(p.id); }');
    expect(legacy).toContain("disabled={intentBlocked}");
    // A pairing room never routes link/1 (peer-caps' linkRoomActive), so
    // `unifiedPeer` is false there and this is the branch it renders.
    expect(card).toContain("{@const intentBlocked = workspace.blocksNewIntent(p.id)}");
  });

  it("routes the card's pointer shortcut to that same single action", () => {
    const pcard = card.slice(card.indexOf('class="pcard"'), card.indexOf('<span class="pavatar"'));
    expect(pcard).toContain("openWorkspace(p.id)");
    // The legacy shortcut (focus + click the hidden file input) survives only
    // for the legacy branch, and the selection-drag suppression still guards
    // both — a click that ends a text selection is not a tap.
    expect(pcard).toContain("picked.containsNode");
    expect(pcard).toContain("document.getElementById(`pick-${p.id}`)");
    expect(pcard.indexOf("openWorkspace(p.id)")).toBeLessThan(pcard.indexOf("document.getElementById"));
  });
});

describe("openWorkspace", () => {
  it("opens the workspace, and completes a waiting OS share instead of discarding it", () => {
    const body = fn("openWorkspace");
    expect(body).toContain("if (workspace.blocksNewIntent(peerId)) return;");
    // A queued share was handed to us by the OS with its destination still
    // missing. Choosing the peer completes THAT intent; it is never dropped.
    // `liveLinkFor(peerId)`, not `outbox().length`: a queue holding only
    // entries that are uploading has nothing for the live link and draining it
    // here would hand the peer an empty batch, while a queue that is entirely
    // uploaded is this lane's job precisely when the peer cannot be handed its
    // keys. `drainFor` is `takeOutbox` plus that old-peer fallback — see its
    // own doc comment.
    expect(body).toMatch(/if \(liveLinkFor\(peerId\)[^]*?\) \{[^]*?workspace\.sendFiles\(peerId, drainFor\(peerId\)\);[^]*?return;/);
    expect(body).toContain("void workspace.openText(peerId)");
    expect(body.indexOf("drainFor(peerId)")).toBeLessThan(body.indexOf("workspace.openText"));
    // Never a silent send of whatever is in the draft box.
    expect(body).not.toMatch(/sendText|clearOutbox/);
  });

  // The guessed-code boundary. Opening the workspace is how the verification
  // code gets ON SCREEN, so it must not also be the thing that sends: a
  // code-guesser who joined first would otherwise receive the batch as a direct
  // consequence of the user looking at the code they were told to compare.
  it("never drains the outbox before the send confirmation in a code room", () => {
    const body = fn("openWorkspace");
    expect(body).toContain("needsSendConfirmation(verifyOn, roomCode)");
    // The drain is the NEGATIVE branch of that gate, not a separate statement
    // after it — and the gate is the same tested predicate the auto-send effect
    // reads, so the two cannot disagree about when the stop applies.
    expect(body).toMatch(
      /if \(liveLinkFor\(peerId\) && !needsSendConfirmation\(verifyOn, roomCode\)\)/,
    );
    // With the stop in force it falls through to opening the lanes, leaving the
    // queue exactly where it was.
    expect(body.indexOf("needsSendConfirmation")).toBeLessThan(body.indexOf("drainFor("));
  });

  it("keeps a persistent release path for those files, reachable after Cancel", () => {
    // Cancel sets `dismissedPeerId`, which permanently suppresses the automatic
    // bar for that peer. Inside a workspace there is no peer card left either,
    // so without this control the batch is stranded on screen with no way to
    // send it and no way to know it is still queued.
    const body = fn("releaseQueued");
    expect(body).toContain("dismissedPeerId = null");
    expect(body).toContain("pendingPeer =");
    // It re-arms the confirmation; it never sends. The comparison is the whole
    // point of the stop, so the release must not be a way around it.
    expect(body).not.toMatch(/sendFiles|takeOutbox|drainFor/);
    expect(surface).toContain("onclick={releaseQueued}");
    expect(surface).toContain("t.workspace.queuedRelease(");
    expect(surface).toContain("{t.workspace.queuedReleaseBtn}");
  });

  // The control was clickable in a state where it could do nothing at all: it
  // rendered on `workspace.hasLink`, and its handler resolved the peer out of
  // `visiblePeers`. Those are two different sources of truth, and losing a
  // signalling socket separates them — the roster empties while the DataChannel
  // keeps carrying files. One derived value now feeds both.
  it("renders and acts on exactly one target, so it is never a clickable no-op", () => {
    const at = app.indexOf("const releaseTarget = $derived.by(");
    expect(at, "releaseTarget is missing from App.svelte").toBeGreaterThan(-1);
    const derived = app.slice(at, app.indexOf("\n  });", at) + 6);
    // The tested predicate, not an inline expression that could drift from it.
    expect(derived).toContain("queuedReleaseTarget({");
    // A LIVE link: an ended link has no code to compare, and releasing against
    // it would build a second link and send over a SAS nobody ever saw.
    expect(derived).toContain('const peerId = workspace.hasLink ? workspace.linkPeerId : ""');
    expect(derived).toContain("linkPeerId: peerId");
    // What THIS peer is still waiting on, over either transport. Not the queue
    // length (an entry still uploading is nobody's to release), not the
    // peer-independent staged count, and not the live lane's own question
    // either: for a peer that cannot be handed keys — or one whose keys have
    // not been released yet — the already-uploaded entries ARE this control's
    // batch, and a gate blind to them left a fully pre-uploaded queue with no
    // control anywhere that could reach it.
    expect(derived).toContain('queued: peerId === "" ? 0 : pendingCountFor(peerId, keysReleasedTo(peerId))');
    expect(derived).toContain('blocked: peerId !== "" && workspace.blocksNewIntent(peerId)');
    // Both the branch and the handler read it, and the handler reads NOTHING
    // else — in particular not the roster, which is what used to leave the
    // button on screen with nothing behind it.
    expect(surface).toContain("{#if releaseTarget && !pendingPeer}");
    const body = fn("releaseQueued");
    expect(body).toContain("const peerId = releaseTarget;");
    expect(body).toContain("if (!peerId) return;");
    expect(body).not.toContain("visiblePeers");
    // The armed bar is built from the link, so a peer that is no longer in the
    // roster still gets one.
    expect(body).toContain("pendingPeer = { id: peerId, name: nameOf(peerId) };");
  });

  // Re-arming has to survive the automatic bar's own effect, which clears
  // `pendingPeer` whenever its "exactly one visible peer" precondition stops
  // holding — and an empty roster is exactly the state a signalling drop leaves
  // behind while the link is still live.
  it("does not let the auto-arm effect clear a confirmation the release control just armed", () => {
    const at = app.indexOf("let dismissedPeerId = $state<string | null>(null);");
    const effect = app.slice(at, app.indexOf("});", app.indexOf("$effect(", at)) + 3);
    expect(effect).toContain("} else if (!pendingPeer || pendingPeer.id !== releaseTarget) {");
    expect(effect).toContain("pendingPeer = null;");
  });

  it("tells the user to compare the code in the confirmation itself", () => {
    // The bar states a risk ("a device calling itself X"); without the
    // instruction it offers no way to answer it, which is a click-through.
    // Gated on `shownSas` — "a code is on screen right now" — and not on the
    // preference: with verification on but no link yet there is nothing to
    // compare, and instructing a comparison that cannot be made is worse than
    // saying nothing. The no-code branch is not silence either: it says what to
    // do to GET one, next to the action that does it.
    expect(surface).toContain(
      "{#if shownSas} {t.confirmRecvCompare}{:else if !canRelease} {t.confirmRecvNeedsCode}{/if}",
    );
    expect(surface).toContain("t.confirmRecv(nameOf(pendingPeer.id))");
  });
});

// The preselected-batch hole: with advanced verification on, a code room and an
// OS share (or files picked before the code was minted), `pendingPeer` is armed
// the instant the one peer joins — which is before any link, and therefore
// before any SAS. Send used to work there.
describe("the send confirmation cannot release before its code exists", () => {
  it("fails closed in the handler, not only in the template", () => {
    const body = fn("confirmSend");
    // The guard is on the SAME derived the button branch reads, so the two
    // cannot disagree, and it comes before anything is drained.
    expect(body).toContain("if (!pendingPeer || !canRelease) return;");
    expect(body.indexOf("canRelease")).toBeLessThan(body.indexOf("drainFor(id)"));
    // The live half of the batch, and only when there is one — an all-keys
    // batch drains to nothing, and the peer's own consent prompt for an empty
    // manifest is not a transfer. The keys are the other half; see
    // "authorizes exactly what the user confirmed" below.
    expect(body).toContain("const files = drainFor(id);");
    expect(body).toContain("if (files.length) workspace.sendFiles(id, files);");
  });

  it("derives that answer from the tested predicate, against a LIVE link", () => {
    const at = app.indexOf("const canRelease = $derived.by(");
    expect(at, "canRelease is missing from App.svelte").toBeGreaterThan(-1);
    const derived = app.slice(at, app.indexOf("});", at) + 3);
    expect(derived).toContain("canReleaseConfirmedSend({");
    // The same confirmation gate the auto-send effect reads, so "is there a bar"
    // and "may the bar release" cannot answer differently.
    expect(derived).toContain("confirmed: needsSendConfirmation(verifyOn, roomCode)");
    expect(derived).toContain("unified: workspace.routes(target.id)");
    expect(derived).toContain("targetPeerId: target.id");
    // `linkPeerId` alone still names the peer of an ENDED link, whose code is no
    // longer on screen. A live link, or "".
    expect(derived).toContain('linkPeerId: workspace.hasLink ? workspace.linkPeerId : ""');
    // The code as RENDERED, not workspace.sasCode: the preference decides
    // whether it is on screen at all, and an invisible code is not comparable.
    expect(derived).toContain("shownSas,");
  });

  it("replaces Send with the action that puts a code on screen", () => {
    const bar = surface.slice(
      surface.indexOf('class="ui-callout ui-callout-accent confirm-send"'),
      surface.indexOf("{/if}", surface.indexOf("{t.confirmRecvCancel}")),
    );
    expect(bar).toContain("{#if canRelease}");
    // Send exists ONLY in the branch that may send.
    const send = bar.indexOf("onclick={confirmSend}");
    const otherwise = bar.indexOf("{:else}");
    expect(send).toBeGreaterThan(bar.indexOf("{#if canRelease}"));
    expect(send).toBeLessThan(otherwise);
    // …and the way forward is `openWorkspace`, which is separately pinned above
    // as never draining the outbox while the confirmation is in force.
    expect(bar.indexOf("openWorkspace(pendingTarget.id)")).toBeGreaterThan(otherwise);
    expect(surface).toContain("{@const pendingTarget = pendingPeer}");
    expect(bar.slice(otherwise)).not.toContain("confirmSend");
    // Cancel is outside the fork: dismissing is available in both states, and it
    // is what `releaseQueued` re-arms.
    expect(bar.indexOf("onclick={cancelSend}")).toBeGreaterThan(bar.indexOf("openWorkspace"));
  });
});

describe("the mixed workspace owns the screen", () => {
  it("hides the chooser, the old peer actions and the availability hint", () => {
    // `!mixed` is this test's subject and must stay the first term. The route
    // gate beside it belongs to the sibling-destination boundary and is owned
    // by transfer-surface.test.ts — a live workspace still hides this section
    // on both destinations either way.
    expect(surface).toMatch(/\{#if !mixed && showsPeerRoster\(.*\)\}\s*<section class="peers"/);
    // The hint lives inside that section, so it goes with it.
    const peers = surface.slice(surface.indexOf('<section class="peers"'), surface.indexOf("</section>", surface.indexOf('<section class="peers"')));
    expect(peers).toContain('class="ui-callout text-availability"');
    // The gate closes with the chooser: the advanced-verification panel below it
    // is NOT mixed-only, and neither is anything after this snippet.
    expect(surface).toMatch(/<\/section>\s*\{\/if\}/);
    expect(surface.indexOf("<details class=\"ui-card verify-pref\">"))
      .toBeGreaterThan(surface.lastIndexOf("{/if}", surface.indexOf("<details class=\"ui-card verify-pref\">")));
    // Legacy terminal/history UI is outside the snippet entirely and stays put.
    expect(app).toContain('<section class="ui-card history">');
    expect(app.indexOf('<section class="ui-card history">')).toBeGreaterThan(surface.length);
  });

  it("renders the unified panel for a mixed link even before its lane is open", () => {
    // A link built by the file lane has an idle text lane for a moment. The
    // workspace still owns the screen, so its composer/attachment surface has to
    // be the thing on it — the old condition rendered nothing at all.
    expect(surface).toContain('{#if mixed || activeText.status !== "idle"}');
    expect(surface.match(/<MessagePanel\b/g)).toHaveLength(1);
  });

  it("wires attachment, folder and restart through the existing pickers", () => {
    expect(surface).toContain("unified={mixed}");
    expect(surface).toContain("attachmentsEnabled={unifiedAttachments}");
    expect(surface).toContain("folderPickSupported={folderUploadSupported}");
    // The same picker the peer card uses; no second transfer entry point.
    expect(surface).toContain("onPickFiles={(e) => pickFile(e, workspace.linkPeerId)}");
    expect(surface).toContain("onPickFolder={(e) => pickFile(e, workspace.linkPeerId)}");
    expect(surface).toContain("onRestart={restartText}");
  });

  it("takes attachment enablement from the live same-peer policy, not from the conversation", () => {
    const derived = app.slice(app.indexOf("const unifiedAttachments = $derived("), app.indexOf(");", app.indexOf("const unifiedAttachments = $derived(")));
    expect(derived).toContain("workspace.usingMixed");
    expect(derived).toContain("workspace.blocksNewIntent(workspace.linkPeerId)");
    // "Is this conversation open?" is a different question from "can this link
    // take another file?" — answering the second with the first is what greys
    // the picker out during a live conversation.
    expect(derived).not.toMatch(/activeText|status/);
    // Teardown turns it off: with no mixed workspace there is no linked peer.
    expect(derived).toContain('workspace.linkPeerId !== ""');
  });

  it("scopes restart to the current link peer and refuses when the link is gone", () => {
    const body = fn("restartText");
    expect(body).toContain("const peerId = workspace.linkPeerId;");
    expect(body).toMatch(/if \(!peerId\) return;/);
    expect(body).toContain("void workspace.openText(peerId)");
    // Clear stays history-only; Disconnect belongs to the header.
    expect(surface).toContain("onClear={clearSurfaceText}");
    expect(surface).toContain("onEnd={endSurfaceText}");
  });
});

describe("the unified surface reads the link's own text lane", () => {
  // `workspace.text` is deliberately NOT this identity. It keeps a non-idle
  // LEGACY transcript on screen while the mixed lane is idle, which is right for
  // the legacy card and its history, and wrong the moment a link owns the
  // screen: a link established by the FILE lane has an idle text lane for a
  // while, and reading the legacy session there shows an EARLIER peer's
  // conversation under the linked peer's name and reports "the lane is already
  // busy" to a launcher whose whole job is to open the real one.
  const surfaceText = app.slice(
    app.indexOf("const surfaceText = $derived("),
    app.indexOf(";", app.indexOf("const surfaceText = $derived(")) + 1,
  );

  it("resolves the surface session to the mixed lane whenever the workspace owns the screen", () => {
    expect(surfaceText).toContain("workspace.usingMixed ? workspace.mixed.text");
    // The legacy branch is the ONLY place `workspace.text` may still answer.
    expect(surfaceText.indexOf("workspace.mixed.text"))
      .toBeLessThan(surfaceText.indexOf(":", surfaceText.indexOf("?")));
  });

  it("samples the mixed lane's own status for the once-per-link auto-open", () => {
    // The specific mutation this pins: sampling `activeText.status` lets a stale
    // legacy transcript ("ended", or merely retained history) read as non-idle
    // and permanently suppress the mixed workspace's one automatic open.
    expect(autoOpenEffect).toContain('textIdle: workspace.mixed.text.status === "idle"');
    expect(autoOpenEffect).not.toMatch(/activeText/);
  });

  it("renders the mixed lane's own conversation, identity, code and error in the panel", () => {
    for (const binding of [
      "status={surfaceText.status}",
      "sasCode={surfaceText.sasCode}",
      "history={surfaceText.history}",
      "errorKey={surfaceText.errorKey}",
      "peerName={nameOf(workspace.linkPeerId || surfaceText.peerId)}",
    ]) expect(panel, binding).toContain(binding);
    // Nothing in the panel may still read the legacy-preserving getter: that is
    // exactly how one peer's transcript gets rendered under another's name.
    expect(panel).not.toMatch(/activeText/);
  });

  it("lands every panel action on the session the panel is showing", () => {
    for (const [prop, handler] of [
      ["onSend", "sendSurfaceText"],
      ["onAccept", "acceptSurfaceText"],
      ["onReject", "rejectSurfaceText"],
      ["onClear", "clearSurfaceText"],
      ["onEnd", "endSurfaceText"],
    ]) expect(panel, prop).toContain(`${prop}={`), expect(panel, prop).toContain(handler);
    // Inside a mixed workspace each one addresses the link's lane directly;
    // outside one the workspace router decides exactly as before, keeping its
    // legacy/mixed ownership bookkeeping.
    for (const [name, mixedCall, legacyCall] of [
      ["sendSurfaceText", "workspace.mixed.text.send(body)", "workspace.sendText(body)"],
      ["acceptSurfaceText", "workspace.mixed.text.accept()", "workspace.acceptText()"],
      ["rejectSurfaceText", "workspace.mixed.text.reject()", "workspace.rejectText()"],
      ["clearSurfaceText", "workspace.mixed.text.clearHistory()", "workspace.clearText()"],
      ["endSurfaceText", "workspace.mixed.text.end()", "workspace.endText()"],
    ]) {
      const body = fn(name);
      expect(body, name).toContain("workspace.usingMixed");
      expect(body, name).toContain(mixedCall);
      expect(body, name).toContain(legacyCall);
      expect(body.indexOf(mixedCall), name).toBeLessThan(body.indexOf(legacyCall));
    }
  });

  // The panel's props were only half of the identity. A unified workspace also
  // has product SIDE EFFECTS — it accepts conversations by itself, it reveals and
  // reads out consent edges, and it raises OS notifications — and each of them
  // used to ask `workspace.text` who this is. Inside a mixed workspace that
  // getter can still answer with a retained legacy session that is not on the
  // screen and cannot be reached from it.
  const effectContaining = (needle: string): string => {
    const at = app.indexOf(needle);
    expect(at, `${needle} is missing from App.svelte`).toBeGreaterThan(-1);
    const start = app.lastIndexOf("$effect(() => {", at);
    expect(start, `no $effect encloses ${needle}`).toBeGreaterThan(-1);
    const open = app.indexOf("{", app.indexOf("=>", start));
    let depth = 0;
    for (let i = open; i < app.length; i++) {
      if (app[i] === "{") depth++;
      else if (app[i] === "}" && --depth === 0) return app.slice(start, i + 1);
    }
    throw new Error(`unbalanced braces in the effect containing ${needle}`);
  };

  it("auto-accepts only the conversation that is actually on the screen", () => {
    const effect = effectContaining("autoAcceptsIncomingText(");
    expect(effect).toContain("autoAcceptsIncomingText(verifyOn, surfaceText.status)");
    // …and the accept lands on that same session rather than being routed back
    // into the legacy lane by the workspace getter pair.
    expect(effect).toContain("acceptSurfaceText()");
    expect(effect).not.toContain("workspace.acceptText()");
    // The mutation this pins: a stale legacy `incomingRequest` driving an
    // automatic accept for a request the user was never shown.
    expect(effect).not.toMatch(/activeText/);
  });

  it("names the peer of the conversation on the screen when a message notifies", () => {
    const effect = effectContaining("lastNotifiedMsgId = last.id;");
    expect(effect).toContain("surfaceText.history.at(-1)");
    expect(effect).toContain("nameOf(surfaceText.peerId)");
    // A notification carries a name to the lock screen. Reading the retained
    // legacy transcript here attributes it to an earlier peer entirely.
    expect(effect).not.toMatch(/activeText/);
    // Still name-only: a protected body must never reach a notification.
    expect(effect).not.toMatch(/last\.body|\.text\b(?!\.newMessageFrom)/);
  });

  it("reveals, names and reads out the surface session's own edge and code", () => {
    const reveal = fn("activityReveal");
    for (const read of [
      "surfaceText.sasCode &&",
      'surfaceText.status === "waitingAccept"',
      'surfaceText.status === "incomingRequest"',
      "t.text.requestHead(nameOf(surfaceText.peerId))",
      "key: `text:${surfaceText.status}:${surfaceText.peerId}`",
      "sas: verifyOn ? surfaceText.sasCode : undefined",
    ]) expect(reveal, read).toContain(read);
    // This edge is a scroll, a spoken identity AND a verification code. Reading
    // a retained legacy session here scrolls to a card that is not on screen and
    // reads out ANOTHER connection's code under the linked peer's name — a
    // verification step pointed at the wrong link.
    expect(reveal).not.toMatch(/activeText/);
  });

  it("leaves the legacy history gates on the retaining getter, and uses it for nothing else", () => {
    // "Is there legacy text history still to render?" is the one question
    // `workspace.text` is the right answer to, precisely because it retains.
    expect(surface).toContain('{#if mixed || activeText.status !== "idle"}');
    expect(surface).toContain('activeText.status !== "idle" || mixed');
    // Its declaration plus those two gates — nothing else in App may read it.
    expect(app.match(/activeText/g)).toHaveLength(3);
  });
});

describe("one auto-open per authenticated link", () => {
  it("delegates the rule to the tested model rather than an inline flag", () => {
    expect(app).toContain("const textOpener = createUnifiedTextOpener();");
    expect(autoOpenEffect).toContain("textOpener.shouldOpen({");
    expect(autoOpenEffect).toContain("hasLink: workspace.hasLink");
    expect(autoOpenEffect).toContain('textIdle: workspace.mixed.text.status === "idle"');
    // One sample of the link identity per evaluation, used for both the question
    // and the answer — asking twice could mark a generation the decision was not
    // made for.
    expect(autoOpenEffect).toContain("const generation = workspace.linkGeneration;");
    expect(autoOpenEffect).toContain("linkGeneration: generation");
    expect(autoOpenEffect).toContain("textOpener.markOpened(generation)");
    expect(autoOpenEffect).toContain("void workspace.openText(peerId)");
  });

  it("cannot bypass the lane's own attempt/generation guards", () => {
    // The lane makes a stale resolution inert by comparing `attempt`/`generation`
    // after every await (mixed-text-session). An orchestration that awaited the
    // open and then wrote state of its own would run AFTER a Disconnect or room
    // switch had already invalidated it — so this effect writes nothing after the
    // call, sends nothing, and never touches the draft.
    expect(autoOpenEffect).not.toMatch(/await |\.then\(|sendText|textCompose/);
    expect(autoOpenEffect.indexOf("void workspace.openText(peerId)"))
      .toBeGreaterThan(autoOpenEffect.indexOf("textOpener.markOpened"));
  });

  it("clears draft and launcher state synchronously on explicit Disconnect", () => {
    expect(surface).toContain("onDisconnect={disconnectWorkspace}");
    const body = fn("disconnectWorkspace");
    expect(body).toContain('textCompose = ""');
    expect(body).toContain("textOpener.reset()");
    expect(body).toContain("workspace.disconnect()");
    // Local state first, and all of it synchronous: a Disconnect that tore the
    // lanes down while leaving these set is exactly how a stale composer and a
    // spent launcher survive into the next link.
    expect(body.indexOf('textCompose = ""')).toBeLessThan(body.indexOf("workspace.disconnect()"));
    expect(body.indexOf("textOpener.reset()")).toBeLessThan(body.indexOf("workspace.disconnect()"));
    expect(body).not.toMatch(/await |setTimeout|tick\(/);
  });

  it("remounts the unified panel per torn-down link so no draft survives into the next one", () => {
    // MessagePanel keeps its draft in component state and stays mounted across a
    // teardown (the transcript is still on screen), so without a remount the text
    // typed for one peer reappears in the composer of the NEXT link.
    expect(surface).toContain("{#key linkEpoch}");
    expect(surface.indexOf("{#key linkEpoch}")).toBeLessThan(surface.indexOf("<MessagePanel"));

    const epoch = app.slice(app.indexOf("let linkEpoch = $state(0);"), app.indexOf("// ── the unified workspace's one automatic step"));
    // Teardown only. Establishment is mid-compose — the unified composer is on
    // screen from "connecting…" onward on purpose — and `linkGeneration`
    // advances exactly there, so keying on the link identity would delete what
    // that composer exists to preserve. A held link across a transport
    // replacement is likewise not a teardown.
    expect(epoch).toContain("if (hadLink && !has) linkEpoch++;");
    expect(epoch).toContain("const has = workspace.hasLink;");
    expect(epoch).not.toContain("linkGeneration");
  });
});

// ── Pre-upload wiring in App ────────────────────────────────────────────────
//
// Source contract, for the same reason the rest of this file is one: these are
// statements about which expression a reactive block reads and in what order,
// and App is not mountable here. What the expressions THEMSELVES do is proved
// executably elsewhere — outbox.test.ts drives the staged/released transitions
// through a real effect, peer-workspace.test.ts refuses the empty batch, and
// mixed-file-session.test.ts carries the handoff over a real channel pair.
describe("pre-upload: the batch is split between two transports", () => {
  const autoSend = autoSendEffect();

  it("decides from what the live link owes THIS peer", () => {
    // Three wrong questions, one right one. `outbox().length` answers "is the
    // queue non-empty" and opens onto batches that are only in flight. The
    // peer-INDEPENDENT staged count answers "what would takeOutbox() return",
    // which is 0 for a batch that finished uploading before anyone joined — so
    // the gate never opened, drainFor was never reached, and the old-peer
    // fallback inside it was dead code for exactly the case it exists for.
    expect(autoSend).toContain("liveLinkFor(solo.id)");
    expect(autoSend).not.toContain("outbox().length");
    expect(autoSend).not.toContain("stagedCount()");
    // Peer first, then the count for that peer: the question cannot be asked
    // without knowing whose it is.
    expect(autoSend.indexOf("const solo =")).toBeLessThan(autoSend.indexOf("liveLinkFor(solo.id)"));
  });

  it("asks that peer-specific question at every gate in front of a drain", () => {
    // Each of these guards a drainFor. A gate that asks the peer-independent
    // question reopens the same hole on that one path.
    const all = code(app);
    expect(all).toContain("if (liveLinkFor(peerId) && !needsSendConfirmation(verifyOn, roomCode))");
    expect(all).toContain("if (liveLinkFor(p.id)) { e.preventDefault();");
    // The standing release control asks a WIDER question than the drain: a batch
    // whose entries are all pre-uploaded is not an empty batch, and measuring it
    // with the live lane's ruler renders no control at all for it.
    expect(all).toContain('queued: peerId === "" ? 0 : pendingCountFor(peerId, keysReleasedTo(peerId)),');
    // And nothing anywhere still asks the peer-independent one.
    expect(all).not.toContain("stagedCount()");
    expect(all).not.toContain("stagedFiles()");
    // The gate and the drain are ONE definition each, and neither is written here
    // any more: the answer they read has three states, and the middle one is a
    // state machine over two signalling frames whose order this component cannot
    // control. See handoff-lane.svelte.ts — and handoff-lane.test.ts, which
    // executes the sequence App cannot be mounted for.
    expect(all).toContain('} from "./lib/handoff-lane.svelte";');
    expect(all).not.toContain("function liveLinkFor(");
    expect(all).not.toContain("function drainFor(");
  });

  it("describes the release batch with the same question the drain will ask", () => {
    // The sentence and the send must mean the same files. A staged-only count
    // next to a drain that also releases the uploaded entries understates the
    // batch it is about to hand over — and an undecided lane must describe
    // nothing rather than name files it is not yet allowed to release. It counts
    // the pre-uploaded entries too while their keys are still unreleased: that
    // is what the Send this control re-arms would hand over.
    expect(surface).toContain("{@const releasing = pendingFilesFor(releaseTarget, keysReleasedTo(releaseTarget))}");
    expect(surface).toContain("releasing.length,");
    expect(surface).toContain("releasing.reduce((total, item) => total + item.file.size, 0)");
  });

  it("settles a peer's pre-upload lane from the two frames that can decide it", () => {
    // The roster names the peer and is where we announce TO it; the hello is what
    // comes back. App has to report both, because the ordering between them IS
    // the bug: the roster always wins, so a gate that reads the hello's absence
    // as an answer spends the handoff one round trip too early.
    const all = code(app);
    expect(all).toContain("noteRosterPeers(p.map((x) => x.id));");
    // The hello branch, whatever else it has grown to do. Matched as a BLOCK
    // rather than as one line because it also retires the bounded capability
    // re-announcement now — but the property being pinned is unchanged and is
    // still exact: the pre-upload lane is settled inside the branch that decided
    // the frame was a hello, and that branch still returns rather than falling
    // through to the relay-RTT and rename readers below it.
    const helloBranch = all.slice(
      all.indexOf("if (recordPeerCaps(from, data)) {"),
      all.indexOf("const d = data as {"),
    );
    expect(helloBranch, "the caps-hello branch moved out of onPeerRelayRtt").not.toBe("");
    expect(helloBranch).toContain("notePeerCaps(from);");
    expect(helloBranch).toContain("capsAnnouncer.didHearFrom(from);");
    expect(helloBranch).toContain("return;");
    // Each sits in the SAME handler as the peer-caps call it shadows, so a roster
    // or a hello can never update one and not the other.
    expect(all.indexOf("retainPeers(p.map((x) => x.id));"))
      .toBeLessThan(all.indexOf("noteRosterPeers(p.map((x) => x.id));"));
    expect(all).toContain("resetHandoffLanes();");
    expect(all.indexOf("resetPeerCaps();")).toBeLessThan(all.indexOf("resetHandoffLanes();"));
  });

  it("keeps the kind-12 frame gate exact, and separate from the lane", () => {
    // The lane is allowed to be optimistic — `wait` holds files back, it never
    // sends anything. What must NOT become optimistic is the frame gate: an
    // unknown kind is a hard error in every implementation, so the emitter still
    // asks the exact-match announcement and nothing else.
    expect(code(app)).toContain("supportsPreupload: peerSupportsPreupload,");
    expect(lane).toContain('return handoffLane(peerId) !== "live";');
  });

  it("hands an old peer the files it cannot be given keys for, and only then", () => {
    // Pre-upload happens before anyone joins, so the joiner may turn out not to
    // announce preupload/1. Its objects are then unreachable ciphertext, and
    // left `uploaded` they are drained by neither lane.
    const at = lane.indexOf("export function drainFor(");
    expect(at, "drainFor is missing from handoff-lane.svelte.ts").toBeGreaterThan(-1);
    const body = lane.slice(at, lane.indexOf("\n}", at));
    // On `live`, and on nothing else. `wait` is the state in which this one-way
    // step would be spent on a peer that was about to say it could take the keys.
    expect(body).toContain('if (handoffLane(peerId) === "live") releaseUploaded();');
    expect(body).toContain("return takeOutbox();");
    // The release must come BEFORE the drain, or the entries it moved are not in
    // the batch it just returned.
    expect(body.indexOf("releaseUploaded")).toBeLessThan(body.indexOf("takeOutbox"));
  });

  it("routes every live-link drain through that decision", () => {
    // A single takeOutbox() left anywhere with a peer in hand is a path on which
    // an old peer silently loses the pre-uploaded files. App no longer reaches
    // the raw drain or the one-way release at all — it cannot even name them.
    expect(code(app)).not.toContain("takeOutbox");
    expect(code(app)).not.toContain("releaseUploaded");
  });

  it("re-hands the key set whenever it changes on an open link", () => {
    // attach() covers "everything was uploaded before anyone joined". This
    // covers the one it cannot: an upload still in flight at the join is allowed
    // to finish, so a new object appears on a link nobody will re-establish.
    const at = app.indexOf("if (!uploadedIds || !workspace.hasLink) return;");
    expect(at, "the stored-key resend effect is missing from App.svelte").toBeGreaterThan(-1);
    const effect = app.slice(app.lastIndexOf("$effect(", at), app.indexOf("});", at) + 3);
    expect(effect).toContain("workspace.sendStoredKeys();");
    // Through a $derived over a PRIMITIVE, not over uploadedRefs(). A derived
    // that allocates never compares equal, so the effect would re-emit the whole
    // set on every unrelated state transition — O(N) frames per upload and
    // O(N²) over the batch, each one a seal and a send.
    expect(app).toContain("const uploadedIds = $derived(uploadedFingerprint());");
    expect(app).not.toContain("$derived(uploadedRefs())");
  });

  it("counts an active stored receive as work a reload would destroy", () => {
    // The one transfer that does not look like one from the workspace's side —
    // no peer, no link, no send/recv — so every guard derived from those misses
    // it. What it does have is an unanswered consent prompt and a download
    // writing to disk, and the keys for that ciphertext exist only in this tab:
    // a refresh, a Back or the update banner reloading the page ends it with
    // nothing on the server that could hand them over again.
    expect(app).toContain("const busy = $derived(workspace.warnsOnLeave || storedReceiver.active());");
    // busy is what the navigation guard, the unload prompt and the update
    // banner all read, so including it here reaches all three.
    expect(app).toContain("setNavGuard(() => (busy ?");
    expect(app).toContain("<UpdateNotice {busy} />");
    // And the screen wake lock, which is a separate reader: a phone that locks
    // its screen mid-download suspends a transfer that cannot be resumed from
    // the other side.
    const wake = app.slice(app.indexOf("const wake = createWakeLock();"));
    expect(wake.slice(0, wake.indexOf("});"))).toContain("|| storedReceiver.active()");
  });

  it("hands the receiver's own surface the peer's handoff, and resets it with the room", () => {
    expect(app).toContain("onStoredKeys: (items) => storedReceiver.offer(items),");
    expect(app).toContain("supportsPreupload: peerSupportsPreupload,");
    expect(surface).toContain("<StoredIncoming receiver={storedReceiver} />");
  });

  it("resets the receiver on EVERY room change, not only on the way out", () => {
    // A re-mint is code→code, and it used to change nothing here. The receiver
    // then leaked across a boundary that has no memory on the other side: it
    // kept the previous room's keys, prompts and dispositions, so an id the old
    // room had answered for was silently a no-op in the new one — a file the new
    // peer sent and the user never saw offered.
    //
    // This half stays App's, on every prior-nonempty change, because App is the
    // only holder of `storedReceiver`: nothing else can reset it, so there is no
    // second owner to race with.
    const effect = roomEffect();
    expect(effect).toContain("if (socketRoomKey) {");
    const guarded = effect.slice(effect.indexOf("if (socketRoomKey) {"));
    // Outside the `!key` block: it must fire for code→code too.
    expect(guarded.slice(0, guarded.indexOf("if (!key)"))).toContain("storedReceiver.reset();");
  });

  it("hands the code→code pre-upload boundary to the sender, and touches it here only on the way out", () => {
    // The race this shape exists to make impossible. A re-mint is TWO effects on
    // one roomCode change — App's, here, and CodePairing's, which calls
    // startPreupload(newCode). CodePairing.send() already crossed the sender's
    // boundary SYNCHRONOUSLY (resetPreupload() before enterRoom), and
    // startPreupload owns the other half (a different code runs leaveRoom).
    //
    // So a resetPreupload() here on code→code is a SECOND reset with no work
    // left to do — and, running in a later flush, it can land after the child
    // has already started the new room's driver. It would then abort the NEW
    // room's upload, release the NEW room's refs and blank `activeCode`, which
    // stops the driver at the top of its loop. Nothing re-arms it: CodePairing's
    // effect has already run for this roomCode and only wakes again if the user
    // stages another file. See preupload.test.ts for that sequence executed.
    //
    // The QUEUE goes on the way out for its own reason: ""→code and code→code
    // are the user still staging for the same send, but leaving the code room by
    // ANY path drops the batch rather than letting it surprise-send later.
    const effect = roomEffect();
    const exit = effect.slice(effect.indexOf("if (!key) {"));
    expect(exit, "the way-out branch is missing from the room-binding effect").toContain("clearOutbox();");
    expect(exit).toContain("resetPreupload();");
    // Exactly one, and it is that one: any other occurrence in this effect is a
    // code→code reset, which is the bug.
    expect(effect.match(/resetPreupload\(\)/g)).toHaveLength(1);
    expect(effect.indexOf("resetPreupload()")).toBeGreaterThan(effect.indexOf("if (!key) {"));
    // And App has no other pre-upload reset anywhere — the boundary is the
    // sender's everywhere else.
    expect(code(app).match(/resetPreupload\(\)/g)).toHaveLength(1);
  });

  it("never pulls the handoff set for a room the socket is not bound to", () => {
    // The set is pulled LATE — inside the send chain, at seal time — so the pull
    // itself has to answer for the room. `resetPreupload()` at the boundary
    // above is what keeps the set from ever holding another room's refs; this is
    // what covers the window before that boundary has run, when `roomCode` has
    // already changed and the link still belongs to the room being left.
    expect(app).toContain("roomCode && roomCode === socketRoomKey");
  });
});

// ── The sender-side stop in front of the key handoff ────────────────────────
//
// Behaviour is executed elsewhere: handoff-authorization.test.ts drives every
// way an authorization stops matching the world, mixed-file-session.test.ts
// proves the pull is peer-specific and re-asked at the wire boundary, and
// peer-workspace.test.ts proves the link intent sends nothing. What is asserted
// here is only what App WIRES to what — which is where the leak was.
describe("pre-upload: no key leaves before the sender confirms", () => {
  const all = code(app);
  const autoSend = autoSendEffect();

  it("gates the pull on an authorization for this exact peer", () => {
    // The leak, precisely: `attach()` pulls the set on every established
    // transport, and a link exists as soon as the workspace is OPENED — which is
    // the only way the verification code the sender is told to compare gets on
    // screen. So the keys went out one link before anybody was asked anything.
    expect(all).toContain("storedKeysToSend: (peerId) => (");
    expect(all).toContain("roomCode && roomCode === socketRoomKey && keysReleasedTo(peerId) ? uploadedRefs() : []");
    // Peer-specific on both halves. The pull is handed the peer, and the context
    // it is answered with is about a LIVE link to that SAME peer — an ended
    // link's generation is a number that still compares equal, and another
    // peer's link is not this peer's compared code.
    expect(all).toContain("function keysReleasedTo(peerId: string): boolean");
    expect(all).toContain("return handoffAllowed(handoffCtx(peerId));");
    const ctx = fn("handoffCtx");
    expect(ctx).toContain("linkGeneration: workspace.hasLink && workspace.linkPeerId === peerId");
    expect(ctx).toContain("? workspace.linkGeneration : -1,");
    expect(ctx).toContain("verifyOn,");
  });

  it("authorizes exactly what the user confirmed, before anything is released", () => {
    const body = fn("confirmSend");
    // Still fails closed on the same two conditions it always did.
    expect(body).toContain("if (!pendingPeer || !canRelease) return;");
    expect(body).toContain("authorizeHandoff(handoffCtx(id));");
    // BEFORE the drain and before the emission: the pull that seals the frame
    // reads the authorization, and it reads it late.
    expect(body.indexOf("authorizeHandoff(")).toBeLessThan(body.indexOf("drainFor(id)"));
    expect(body.indexOf("authorizeHandoff(")).toBeLessThan(body.indexOf("sendStoredKeys()"));
    // The live half only when there IS one. An all-keys batch drains to nothing,
    // and calling through with it seals a manifest with no files in it.
    expect(body).toContain("if (files.length) workspace.sendFiles(id, files);");
    // And the keys, once, on the link the code was compared on. `attach()`
    // already asked — before this authorization existed — and got nothing.
    expect(body).toContain("if (handoffOwed(id)) workspace.sendStoredKeys();");
  });

  it("cancels without releasing anything", () => {
    // Cancel is a decision not to send, not a decision to lose files: nothing is
    // drained, nothing is released to the live lane, and no authorization is
    // recorded — so the pull keeps answering "no". The way back is the standing
    // release control, which counts those entries (see the queued: gate above).
    const body = fn("cancelSend");
    expect(body).not.toContain("drainFor");
    expect(body).not.toContain("authorizeHandoff");
    expect(body).toContain("dismissedPeerId = pendingPeer.id;");
  });

  it("acts on the handoff debt, which no live-lane count can see", () => {
    // A batch that finished uploading before anybody joined owes the live lane
    // nothing, and that is the ordinary code room. Driven only by `liveLinkFor`
    // the sender does nothing at all with it: no link, no frame, silence.
    expect(autoSend).toContain("handoffOwed(solo.id) > 0");
    // "Owed AND not yet handed over" — a live link to this peer whose keys are
    // released is a debt that has been settled, and re-arming on it would put the
    // confirmation bar straight back after the user answered it.
    expect(autoSend).toContain("!(workspace.hasLink && workspace.linkPeerId === solo.id && keysReleasedTo(solo.id))");
  });

  it("builds the link for an all-keys batch instead of sending an empty one", () => {
    // Two rules on one line. The empty batch is refused (peer-workspace refuses
    // it too, and would seal a manifest with no files in it), and the link the
    // handoff needs is asked for as its own intent rather than by opening a
    // conversation nobody asked for.
    expect(autoSend).toContain("const files = drainFor(peer.id);");
    expect(autoSend).toContain("if (files.length) workspace.sendFiles(peer.id, files);");
    expect(autoSend).toContain("else workspace.prepareHandoff(peer.id);");
    // With the confirmation in force the link is prepared too — the code the
    // user is told to compare does not exist until one is up — but the batch is
    // NOT drained and no authorization is recorded, so the pull still says no.
    expect(autoSend).toContain("if (!pendingPeer && peer.id !== dismissedPeerId) pendingPeer = peer;");
    expect(autoSend).toContain("if (keysPending) workspace.prepareHandoff(peer.id);");
    expect(autoSend).not.toContain("authorizeHandoff");
  });

  it("withdraws the authorization with the thing it was about", () => {
    // Both are belt and braces — the context comparison in handoffAllowed
    // already fails closed on a room switch (the room changed) and on a
    // disconnect (there is no live link, so the generation is -1). They are here
    // because an authorization is the one piece of state whose stale form is a
    // disclosure rather than a glitch.
    // Alongside the room's other resets — the peer caps, the lanes — because a
    // new room has its own peers, and a decision made about one of the old
    // room's is not about anybody in it.
    expect(all).toContain("revokeHandoff();");
    expect(all.indexOf("resetHandoffLanes();")).toBeLessThan(all.indexOf("revokeHandoff();"));
    expect(fn("disconnectWorkspace")).toContain("revokeHandoff();");
  });
});

// ── the join and the configuration are started together ──────────────────────
//
// A source contract for the same reason everything else in this file is: these
// are rules about the ORDER of statements inside two async functions, and about
// which of them sit before an `await`. A rendered snapshot cannot show either,
// and App is not mountable here.
//
// What behaviour is proved elsewhere, so this file does not have to fake it:
//   - what suspend()/reset() do to the gate    → relay-selection.test.ts
//   - the first legal link/1 frame waiting on it → peer-link's own tests
describe("the room is joined while /api/ice is still in flight", () => {
  const APPLY = "applyRoomIce(await pending);";
  /**
   * The async onMount's statements, from its opening to the line that installs
   * the answer.
   *
   * Anchored on `APPLY` rather than brace-matched: the interesting property of
   * this function is precisely that the await is LAST, so the await is the
   * honest terminator — and everything this slice contains is by construction
   * something that runs before it. Brace counting would also have to be right
   * about braces inside string literals, which this does not have to be.
   */
  const mountBeforeApply = (): string => {
    const at = app.indexOf("onMount(async () => {");
    expect(at, "the async onMount is missing from App.svelte").toBeGreaterThan(-1);
    const end = app.indexOf(APPLY, at);
    expect(end, "onMount no longer installs the answer it did not wait for")
      .toBeGreaterThan(-1);
    return code(app.slice(at, end + APPLY.length));
  };

  it("starts the fetch, then rebinds the socket, then awaits the answer", () => {
    const body = code(fn("switchRoom"));
    const started = body.indexOf("const pending = fetchIceConfig(roomCode);");
    const rebound = body.indexOf("signaling.reconnect(wsURL(location, roomCode));");
    const awaited = body.indexOf("const ice = await pending;");
    expect(started, "switchRoom no longer starts the fetch without awaiting it")
      .toBeGreaterThan(-1);
    // The whole change, as one ordering: entering a code no longer waits a
    // serial round trip before the hub is told this page is in the room.
    expect(started).toBeLessThan(rebound);
    expect(rebound).toBeLessThan(awaited);
    expect(body).not.toContain("await fetchIceConfig(roomCode)");
  });

  it("closes the relay gate before the socket can deliver a frame", () => {
    const body = code(fn("switchRoom"));
    // `suspend()` lives in resetRelaySelection, whose own contract is that it
    // runs AFTER workspace.resetRoom(). Both must precede the rebind: a gate
    // still open when the new room's first frame arrives is a transport built
    // on the configuration of neither room.
    expect(body.indexOf("workspace.resetRoom();"))
      .toBeLessThan(body.indexOf("resetRelaySelection();"));
    expect(body.indexOf("resetRelaySelection();"))
      .toBeLessThan(body.indexOf("signaling.reconnect(wsURL(location, roomCode));"));
    const reset = code(fn("resetRelaySelection"));
    expect(reset).toContain("relaySelection.suspend();");
    expect(reset).toContain("roomIcePending = true;");
    // And the room being left takes its credentials with it. A TURN credential
    // is minted for ONE code, so a connection built in the window must not be
    // able to present the previous rendezvous's.
    for (const cleared of ["iceServers = [];", "relayPool = [];", "relayBound = null;"]) {
      const at = body.indexOf(cleared);
      expect(at, `${cleared} is missing from switchRoom`).toBeGreaterThan(-1);
      expect(at).toBeLessThan(body.indexOf("signaling.reconnect(wsURL(location, roomCode));"));
    }
  });

  it("does the same on the first join, where the gate starts open", () => {
    const body = mountBeforeApply();
    const started = body.indexOf("const pending = fetchIceConfig(roomCode);");
    const suspended = body.indexOf("resetRelaySelection();");
    const socket = body.indexOf("signaling = new SignalingClient(");
    expect(started, "onMount no longer starts the fetch without awaiting it")
      .toBeGreaterThan(-1);
    expect(started).toBeLessThan(suspended);
    // The gate is shut BEFORE the socket exists. `relaySelection` is created
    // open, which is right for a page holding its configuration and wrong for
    // one still fetching it — and onMount is the one entry with no room switch
    // ahead of it to have closed it.
    expect(suspended).toBeLessThan(socket);
    expect(body).not.toContain("await fetchIceConfig(roomCode)");
  });

  it("registers every listener before the answer is awaited", () => {
    // The slice ENDS at the await, so containment is the assertion: the socket
    // does not buffer, a frame delivered before its handler exists is dropped,
    // and in a code room the roster naming the peer is delivered once.
    const body = mountBeforeApply();
    for (const listener of [
      "signaling.onSelfId(",
      "signaling.onPeers(",
      "signaling.onPeerLeft(",
      "signaling.onSignal(onPeerRelayRtt);",
      "signaling.onClose(",
      "session.listenForIncoming();",
      "textSession.listenForRequests();",
      "workspace.start();",
    ]) {
      expect(body, `${listener} runs behind the ICE await, so its frames are dropped`)
        .toContain(listener);
    }
  });

  it("holds the peer's relay map instead of recording it into an empty pool", () => {
    const body = code(fn("onPeerRelayRtt"));
    // `reset` empties `theirs` against the room's real pool, so recording during
    // the window would record into a room one call away from forgetting it. And
    // a dropped map is not self-healing: a peer that finished probing sends its
    // greet once and nothing after it.
    expect(body).toContain("if (roomIcePending) {");
    expect(body).toContain("if (parseRelayRtt(data) && heldRelayRtt.length < HELD_RELAY_RTT_MAX) {");
    expect(body).toContain("} else if (relaySelection.receive(from, data)) {");
    // Replayed AFTER reset, which is what puts them into the first choice this
    // room makes rather than the one after it.
    const measure = code(fn("startRelayMeasurement"));
    expect(measure.indexOf("relaySelection.reset(relayPool);")).toBeLessThan(
      measure.indexOf("for (const held of heldRelayRtt) relaySelection.receive(held.from, held.data);"),
    );
    expect(measure).toContain("heldRelayRtt = [];");
    // And a departed peer's held map goes with it, exactly as `peerGone` drops
    // one that had already been merged — but only for a peer a PREVIOUS roster
    // named, because the hub can hand this socket a roster computed before the
    // peer whose map already arrived.
    expect(code(fn("noteRelayPeers"))).toContain(
      "heldRelayRtt = heldRelayRtt.filter((h) => present.has(h.from) || !heldRelayRoster.has(h.from));",
    );
    expect(code(fn("noteRelayPeers"))).toContain("heldRelayRoster = present;");
    expect(mountBeforeApply()).toContain("dropHeldRelayRtt(peerId);");
  });

  it("applies the whole answer in one place, and only there", () => {
    const body = code(fn("applyRoomIce"));
    for (const assignment of [
      "iceServers = ice.iceServers;",
      "relayPool = ice.relays;",
      "relayStatus = ice.relayStatus;",
      "relayBound = relayDeadline(ice, Date.now());",
      "roomIcePending = false;",
    ]) expect(body, `${assignment} is missing from applyRoomIce`).toContain(assignment);
    // The pool must be assigned before `reset` closes the gate against it.
    expect(body.indexOf("relayPool = ice.relays;"))
      .toBeLessThan(body.indexOf("startRelayMeasurement()"));
    // One writer: a second assignment of the room's pool is a second room
    // boundary nothing else knows about, and the flag would then be cleared by
    // a path the gate never heard from.
    // Anchored to an indented statement so the `let roomIcePending = false;`
    // declaration is not counted as a second writer of it.
    const all = code(app);
    expect(all.match(/relayPool = ice\.relays;/g)).toHaveLength(1);
    expect(all.match(/^\s+roomIcePending = false;$/gm)).toHaveLength(1);
  });
});

// ── nothing may be built before this room's own answer ───────────────────────
//
// The invariant the whole concurrency change rests on. Joining a round trip
// early is safe only while NOTHING can be built from the configuration the join
// did not wait for — and "nothing" has to mean the `link/1` path, the legacy
// file lane and the legacy text lane, because all three end at the same
// `rtcConfig()` and all three would snapshot the same empty answer into an
// `RTCPeerConnection` for the life of the connection.
//
// The rule these replace was a five-second timer that set a `roomIceWaitOver`
// flag and then returned `rtcConfig()` anyway. That is the defect stated as a
// design: the fallback it reached was the DEFAULT RTC configuration — no
// servers, no pool, no credential, `iceTransportPolicy` unset — for a room that
// had simply been answered slowly. There is no such timeout now, and the reason
// there does not need to be one is `fetchIceConfig`: it owns the retry, the
// `Retry-After` cap and the "which failures are worth repeating" decision, and
// it ALWAYS resolves — an unreadable `/api/ice` comes back as an `unavailable`
// STUN-only configuration. That answer is the fallback boundary, and it is
// installed by the same call that opens the gate.
//
// A source contract for the same reason the rest of this file is one: these are
// rules about which statements exist, in which order, inside one component that
// owns the socket, the ICE fetch and the service-worker registration. What the
// pieces DO is executed elsewhere:
//   - `suspend()`, its own bounded release, and `reset()` → relay-selection.test.ts
//   - holding the first legal `link/1` frame behind a gate → peer-link's tests
//   - the router's legacy/mixed fork these two lanes sit on → peer-workspace.test.ts
describe("no transport is built while the room has no configuration", () => {
  const all = code(app);
  /** The readiness block itself: its state, its settler, its wait, its gate. */
  const readiness = code(app.slice(
    app.indexOf("let roomIceWaiters"),
    app.indexOf("function applyRoomIce("),
  ));

  it("becomes ready only where the room's own answer is installed", () => {
    // ONE settler, and `applyRoomIce` is it. A second `settleRoomIce(true)`
    // anywhere would be a second way to become ready — which is precisely what
    // the deleted timer was, and it was a way that had no answer behind it.
    expect(all.match(/settleRoomIce\(true\)/g)).toHaveLength(1);
    const apply = code(fn("applyRoomIce"));
    expect(apply).toContain("settleRoomIce(true);");
    // Ordering, and every step of it is load bearing. The flag clears, then
    // `reset` puts THIS room's pool behind `takeChoice()`, then the peers that
    // arrived during the window are re-noted against a pool that now exists —
    // and only then is anything woken. A build released ahead of `reset` reads
    // the previous room's pool; one released ahead of the re-note hands itself
    // to a gate whose bounded grace nobody ever started.
    expect(apply.indexOf("roomIcePending = false;"))
      .toBeLessThan(apply.indexOf("startRelayMeasurement()"));
    expect(apply.indexOf("startRelayMeasurement()"))
      .toBeLessThan(apply.indexOf("noteRelayPeers("));
    expect(apply.indexOf("noteRelayPeers("))
      .toBeLessThan(apply.indexOf("settleRoomIce(true);"));
  });

  it("has no deadline of its own, so no elapsed time can permit a build", () => {
    // The mutation this exists to catch: any timer in here is a path to `ready`
    // that no `/api/ice` answer stands behind.
    expect(readiness).not.toMatch(/setTimeout|clearTimeout|setInterval|Date\.now/);
    const reset = code(fn("resetRelaySelection"));
    expect(reset).not.toMatch(/setTimeout|clearTimeout/);
    // …and the flag that timer wrote is gone with it, everywhere. While it
    // existed, `roomIcePending` was true and a build was still permitted.
    expect(all).not.toContain("roomIceWaitOver");
    expect(all).not.toContain("roomIceTimer");
    // The old caller, too: a helper that answers `rtcConfig()` while the room is
    // pending is the empty configuration by another name.
    expect(all).not.toContain("rtcConfigWhenReady");
  });

  it("waits on the answer and on nothing else, and does not wait once it is in", () => {
    const wait = code(fn("whenRoomIce"));
    // One condition. Not the relay agreement (the legacy lanes have never waited
    // for it, and starting would delay every transfer in a pooled room by up to
    // a peer's whole grace), and not a clock.
    expect(wait).toContain("if (!roomIcePending) return Promise.resolve(true);");
    expect(wait).toContain("new Promise<boolean>((resolve) => roomIceWaiters.push(resolve))");
    expect(wait).not.toMatch(/setTimeout|relaySelection|rtcConfig/);
  });

  it("wakes each parked build exactly once, and abandons it on a room switch", () => {
    const settle = code(fn("settleRoomIce"));
    // Taken before anything runs. A callback that parks again — a link waiter
    // handing itself on to the relay gate — must join the NEXT window rather
    // than the one being closed, and no waiter may be resolved twice.
    expect(settle).toContain("const parked = roomIceWaiters;");
    expect(settle).toContain("roomIceWaiters = [];");
    expect(settle.indexOf("roomIceWaiters = [];"))
      .toBeLessThan(settle.indexOf("for (const cb of parked)"));
    // The room boundary supersedes rather than carries: the peer, the socket and
    // the credentials a parked build was for all belong to the room being left.
    // First, so nothing is still parked when the next window opens below.
    const reset = code(fn("resetRelaySelection"));
    expect(reset).toContain("settleRoomIce(false);");
    expect(reset.indexOf("settleRoomIce(false);"))
      .toBeLessThan(reset.indexOf("roomIcePending = true;"));
    expect(reset.indexOf("roomIcePending = true;"))
      .toBeLessThan(reset.indexOf("relaySelection.suspend();"));
    // Exactly one supersede per boundary — `resetRelaySelection` is the only
    // caller, and it is the one function both entries go through.
    expect(all.match(/settleRoomIce\(false\)/g)).toHaveLength(1);
  });

  // ── link/1 ──────────────────────────────────────────────────────────────────
  it("gives the link manager the room's readiness, not only its relay agreement", () => {
    // `relaySelection` can only answer the half it owns, and during this window
    // it is being asked about a selection with no pool to agree on. Its own
    // deadline — a bound on a PEER that may never speak — then answers "ready"
    // five seconds in, for a room that has no configuration at all. That release
    // is still correct in relay-selection.test.ts and must not be corrected
    // there; what changes is that it is no longer the whole answer.
    expect(all).toContain("relayGate: () => roomGate,");
    expect(all).not.toContain("relayGate: () => relaySelection.gate");
    expect(readiness).toContain("const roomGate: RelayGate = {");
    expect(readiness).toContain("ready: () => !roomIcePending && relaySelection.gate.ready(),");
    // Parked on the answer first and handed on to the relay gate second, so the
    // relay CHOICE stays bounded exactly as it was — and that bound now starts
    // from `reset`, which is to say from the moment a real pool exists.
    expect(readiness).toContain("if (!roomIcePending) { relaySelection.gate.whenReady(cb); return; }");
    expect(readiness).toContain(
      "roomIceWaiters.push((live) => { if (live) relaySelection.gate.whenReady(cb); });",
    );
    // A superseded waiter is dropped rather than run, exactly as
    // `relaySelection.reset`/`suspend` drop their own: whoever parked it has
    // already been told, because `workspace.resetRoom()` runs first.
    expect(readiness).toContain("if (live)");
  });

  // ── the legacy file and text lanes ──────────────────────────────────────────
  it("parks the two ways this page STARTS a legacy transport", () => {
    // The router forks to these for every peer that does not route `link/1`, and
    // neither has ever gone through the relay gate. Parked rather than refused:
    // a satisfied wait goes on to build exactly once, and a superseded one
    // abandons, because the room the intent was for is gone.
    const files = block("const legacyFiles = {", "const legacyText = {");
    expect(files).toContain("async sendFiles(peerId: string, files: PickedFile[]) {");
    expect(files).toContain("if (!(await whenRoomIce())) return;");
    expect(files).toContain("await session.sendFiles(peerId, files);");
    expect(files.indexOf("await whenRoomIce()"))
      .toBeLessThan(files.indexOf("await session.sendFiles"));

    const text = block("const legacyText = {", "const workspace: PeerWorkspace = createPeerWorkspace({");
    expect(text).toContain("async openWith(peerId: string) {");
    expect(text).toContain("if (!(await whenRoomIce())) return;");
    expect(text).toContain("await textSession.openWith(peerId);");
    expect(text.indexOf("await whenRoomIce()"))
      .toBeLessThan(text.indexOf("await textSession.openWith"));

    // The router is handed the parked lanes, not the raw sessions — the fork
    // lives inside it, so this is the one place that reaches both branches.
    expect(all).toContain("legacyFiles,");
    expect(all).toContain("legacyText,");
    expect(all).not.toContain("legacyFiles: session,");
    expect(all).not.toContain("legacyText: textSession,");
  });

  // The INBOUND half of each lane cannot be gated from this component at all:
  // both snapshot `rtcConfig()` inside their own offer handler, which App never
  // reaches. The only two levers it has from here are the file lane's
  // `textActive` and the message lane's `canAccept` — and both mean "somebody
  // else has this lane", which every legacy sender reads as TERMINAL. Refusing
  // there turned a slow `/api/ice` into a deterministic failed transfer for a
  // peer that had done nothing wrong and was very likely already waiting.
  //
  // So the lanes take the gate itself and park the offer. What they DO with it —
  // park rather than refuse, at most one, retire exactly once, build exactly one
  // transport from the installed configuration, and still answer `busy` to a
  // genuine conflict — is executed, not restated:
  //   - transfer-session.routing.test.ts (the file lane, and `routeOffer`)
  //   - text-link.test.ts (the message lane)
  // What is asserted here is only the composition those tests cannot see: that
  // this component builds ONE gate and gives it to BOTH lanes.
  it("hands the room's readiness to both legacy lanes", () => {
    const gate = block("const roomIce: RoomIceGate = {", "const textLink = createTextLink({");
    // The same two facts the outbound wrappers use, so a lane and a wrapper can
    // never disagree about whether this room is ready.
    expect(gate).toContain("pending: () => roomIcePending,");
    expect(gate).toContain("whenReady: () => whenRoomIce(),");
    const textLinkDeps = block("const textLink = createTextLink({", "const textSession = createTextSession({");
    const fileDeps = block("const session = createTransferSession({", "const legacyFiles = {");
    expect(textLinkDeps).toContain("roomIce,");
    expect(fileDeps).toContain("roomIce,");
    // …and the refusal it replaces is gone from both levers. Either one would
    // put the pending room back where a sender reads it as "peer busy" — and
    // `textActive` would additionally carry it into `busy`, which is what
    // `warnsOnLeave` is built from, prompting on every reload.
    expect(textLinkDeps).toContain("canAccept: (from) => textSession.canAcceptFrom(from),");
    expect(textLinkDeps).not.toContain("roomIcePending");
    expect(fileDeps).not.toContain("roomIcePending");
    const files = block("const legacyFiles = {", "const legacyText = {");
    expect(files).toContain("get busy() { return session.busy; },");
    expect(files).toContain("get transferActive() { return session.transferActive; },");
  });

  it("retires parked inbound work at every boundary that ends the room", () => {
    // A parked offer outliving its room is the one way this could build a stale
    // transport, so every end-of-room event has to reach both lanes. The room
    // switch is covered twice over — `settleRoomIce(false)` supersedes the wait
    // itself — and that is deliberate: retirement is idempotent by identity, and
    // the explicit calls also cover a cancellation that does not switch rooms.
    const left = block("signaling.onPeerLeft((peerId) => {", "signaling.onSignal(onPeerRelayRtt);");
    expect(left).toContain("session.peerGone(peerId);");
    expect(left).toContain("textLink.peerGone(peerId);");
    // Before the branch: a code room that was never joined closes terminally and
    // never settles the window, so anything parked there would wait forever.
    const closed = block("signaling.onClose(() => {", "if (roomCode && !joinedRoom)");
    expect(closed).toContain("session.retireParkedInbound();");
    expect(closed).toContain("textLink.retireParkedInbound();");
    const switching = code(fn("switchRoom"));
    expect(switching).toContain("session.abortAll();"); // …which retires the file lane's
    expect(switching).toContain("session.reset();");
    expect(switching).toContain("textLink.retireParkedInbound();");
  });

  it("leaves a LAN room, a codeless page and a STUN-only code exactly as immediate", () => {
    // Every one of those is answered with a pool-less configuration, and
    // `reset([])` opens the relay gate in the same call. So `applyRoomIce`
    // settles a wait that hands its callback to an already-open gate, in the
    // turn the answer lands: no relay-map delay anywhere on those paths.
    const wait = code(fn("whenRoomIce"));
    expect(wait).toContain("Promise.resolve(true)");
    expect(readiness).toContain("if (!roomIcePending) { relaySelection.gate.whenReady(cb); return; }");
    // And nothing in the readiness block waits on the relay agreement itself,
    // which is what would have made a POOLED room slower than it was.
    expect(code(fn("settleRoomIce"))).not.toContain("relaySelection");
  });
});

// ── which config read COMMITS the room to a relay ────────────────────────────
//
// `relaySelection.takeChoice()` is not a read, it is a record: it marks this
// room as having built a transport on the agreed relay, and that record does
// exactly one thing — it FORBIDS `relock`, the departure re-lock that takes the
// gate back when the peer it opened for leaves before anything was built.
//
// Composing all three lanes onto one `rtcConfig()` therefore let a LEGACY
// construction spend the record. The legacy file and text lanes never go
// through the relay gate at all, so nothing `link/1` was ever built — and the
// room was nevertheless unable to re-lock, which is the very state `relock`
// exists to prevent: the replacement peer's first legal `link/1` frame goes out
// on the departed peer's relay, or on the fallback, before its own map can
// arrive.
//
// The split is the correction, and this section is its evidence in two halves:
// the first EXECUTES the two reads against the real `createRelaySelection` and
// the real `chooseRtcConfig`, and the second pins that model to the component
// by asserting the exact expressions App.svelte builds them from.
describe("the relay choice is committed by the link path and only by it", () => {
  const pool: RelayEntry[] = [
    { id: "tok", iceServers: [{ urls: ["turn:tok.example:3478"], username: "u", credential: "c" }] },
    { id: "fra", iceServers: [{ urls: ["turn:fra.example:3478"], username: "u", credential: "c" }] },
  ];

  /**
   * App's two readers over one selection, settled on `tok` for peer "first".
   *
   * The bodies are the ones App.svelte declares — asserted literally in the
   * source contract below, so this model cannot drift away from the component
   * without a test failing. `iceServers` is empty and the pool is real, which
   * is the pooled cross-network room these rules are about.
   */
  function room() {
    const selection = createRelaySelection({ publish: () => {} });
    selection.reset(pool);
    const relayRtcConfig = (relayId: string | null) =>
      chooseRtcConfig({ iceServers: [], relays: pool }, relayId);
    const linkRtcConfig = () => relayRtcConfig(selection.takeChoice());
    const legacyRtcConfig = () => relayRtcConfig(selection.selectedRelayId);

    selection.noteRoster(["first"]);
    selection.notePeer("first");
    selection.record("tok", 10);
    selection.record("fra", 90);
    selection.receive("first", { relayRtt: { tok: 15, fra: 400 } });
    selection.finishMeasurement();
    expect(selection.gate.ready()).toBe(true);
    expect(selection.selectedRelayId).toBe("tok");
    return { selection, linkRtcConfig, legacyRtcConfig };
  }

  it("gives both lanes the same configuration, so nothing else changes", () => {
    // The whole difference is the record. The pool, the credentials, the chosen
    // relay and the relay-only transport policy are identical, because both
    // readers end in the same `chooseRtcConfig` call over the same room state.
    const a = room();
    expect(a.legacyRtcConfig()).toEqual({
      iceServers: pool[0].iceServers, iceTransportPolicy: "relay",
    });
    expect(a.legacyRtcConfig()).toEqual(a.linkRtcConfig());

    // …and the fallback is shared too: with no choice settled, both fold the
    // whole advertised set together exactly as before.
    const fresh = createRelaySelection({ publish: () => {} });
    fresh.reset(pool);
    expect(fresh.selectedRelayId).toBeNull();
    expect(chooseRtcConfig({ iceServers: [], relays: pool }, fresh.selectedRelayId))
      .toEqual(chooseRtcConfig({ iceServers: [], relays: pool }, fresh.takeChoice()));
  });

  /** **The defect.** A legacy read must leave the departure re-lock available. */
  it("does not let a legacy construction spend the room's one commit", () => {
    const { selection, legacyRtcConfig } = room();
    // Both legacy lanes build, twice over — a file transfer and a message
    // session with the same peer, which is the ordinary sequence.
    legacyRtcConfig();
    legacyRtcConfig();

    // The peer they were built with leaves, and nothing `link/1` exists. The
    // gate goes back to waiting, and its choice with it.
    selection.peerGone("first");
    expect(selection.gate.ready()).toBe(false);
    expect(selection.selectedRelayId).toBeNull();

    // The replacement is held until its OWN map lands, which is the whole point:
    // its link is then built on the relay the two of them agree on.
    const run = vi.fn();
    selection.gate.whenReady(run);
    selection.notePeer("second");
    expect(run).not.toHaveBeenCalled();
    selection.receive("second", { relayRtt: { fra: 4 } });
    expect(selection.selectedRelayId).toBe("fra");
    expect(run).toHaveBeenCalledTimes(1);
  });

  /** …and the invariant the commit exists for is untouched: a gate must never
   *  reach a `link/1` transport that already exists. Stated here as the exact
   *  counterpart of the case above, so the two can only ever be changed
   *  together; `relay-selection.test.ts` owns the rule itself. */
  it("still forbids the re-lock once the link path has read the choice", () => {
    const { selection, linkRtcConfig } = room();
    expect(linkRtcConfig()).toEqual({
      iceServers: pool[0].iceServers, iceTransportPolicy: "relay",
    });

    selection.peerGone("first");
    expect(selection.gate.ready()).toBe(true);
    const run = vi.fn();
    selection.gate.whenReady(run);
    expect(run).toHaveBeenCalledTimes(1);
  });

  /** A legacy read before the link's does not consume the commit either: the
   *  link path's own read still records it, so the ordering of the two lanes
   *  inside one room cannot decide whether the invariant holds. */
  it("records the commit on the link read whichever lane read first", () => {
    const { selection, linkRtcConfig, legacyRtcConfig } = room();
    legacyRtcConfig();
    linkRtcConfig();

    selection.peerGone("first");
    expect(selection.gate.ready()).toBe(true);
  });

  // ── the composition itself ─────────────────────────────────────────────────
  it("wires the committing read to the link path and the plain read to the lanes", () => {
    const all = code(app);
    // The two readers, exactly as the model above builds them.
    expect(all).toContain(
      "const relayRtcConfig = (relayId: string | null): RtcConfig =>\n"
      + "    chooseRtcConfig({ iceServers, relays: relayPool }, relayId);",
    );
    expect(all).toContain(
      "const linkRtcConfig = (): RtcConfig => relayRtcConfig(relaySelection.takeChoice());",
    );
    expect(all).toContain(
      "const legacyRtcConfig = (): RtcConfig => relayRtcConfig(relaySelection.selectedRelayId);",
    );
    // ONE commit in the whole component, and it is the link reader's. A second
    // `takeChoice()` anywhere is another lane able to spend the record.
    expect(all.match(/takeChoice\(\)/g)).toHaveLength(1);
    // The dependency that reaches a `link/1` transport constructor
    // (peer-workspace → mixed-session → peer-link) takes the committing read…
    const workspaceDeps = block(
      "const workspace: PeerWorkspace = createPeerWorkspace({", "const storedReceiver =",
    );
    expect(workspaceDeps).toContain("rtcConfig: () => linkRtcConfig(),");
    expect(workspaceDeps).not.toContain("takeChoice");
    // …and both legacy lanes take the plain one. They are the two the router
    // forks to for every peer that does not route `link/1`.
    const textLinkDeps = block("const textLink = createTextLink({", "const textSession = createTextSession({");
    const fileDeps = block("const session = createTransferSession({", "const legacyFiles = {");
    expect(textLinkDeps).toContain("rtcConfig: () => legacyRtcConfig(),");
    expect(fileDeps).toContain("rtcConfig: () => legacyRtcConfig(),");
    // The composed reader they all used is gone, so a fourth consumer cannot
    // reappear on it and silently pick up the commit.
    expect(all).not.toContain("rtcConfig: () => rtcConfig(),");
    expect(all).not.toContain("const rtcConfig = (): RtcConfig");
  });
});

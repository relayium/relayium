import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Source contract, like activity-visibility.test.ts: the rules below are about
// which nodes exist in which branch, which is exactly what a rendered snapshot of
// one state cannot prove. `link/1` ships and every room now activates it — so the
// legacy branch is what a peer that does not speak the protocol still gets, in
// either kind of room, and it has to stay byte-for-behaviour identical.
const app = readFileSync(resolve(process.cwd(), "src/App.svelte"), "utf8");
const surface = app.slice(
  app.indexOf("{#snippet transferSurface()}"),
  app.indexOf("{/snippet}", app.indexOf("{#snippet transferSurface()}")) + "{/snippet}".length,
);
const panel = readFileSync(resolve(process.cwd(), "src/lib/MessagePanel.svelte"), "utf8");
const caps = readFileSync(resolve(process.cwd(), "src/lib/peer-caps.svelte.ts"), "utf8");

const indicesOf = (haystack: string, needle: string): number[] => {
  const out: number[] = [];
  for (let i = haystack.indexOf(needle); i >= 0; i = haystack.indexOf(needle, i + 1)) out.push(i);
  return out;
};

// The activity reveal/announcement effect, shared by the two contracts below.
const revealEffect = app.slice(
  app.indexOf("$effect(() => {", app.indexOf("function revealElement(")),
  app.indexOf("// ── ?debug=1"),
);

describe("unified mixed peer workspace presentation", () => {
  it("gates the whole unified branch on workspace.usingMixed", () => {
    expect(surface).toContain("{@const mixed = workspace.usingMixed}");
    // Every new node is mixed-only. A stray unguarded one would change the
    // production (legacy) surface.
    expect(surface).toMatch(/\{#if mixed\}\s*<WorkspaceHeader/);
    expect(surface).toContain("{#if mixed && workspace.queuedBatches.length}");
  });

  it("renders exactly one persistent trust header carrying the whole link identity", () => {
    expect(surface.match(/<WorkspaceHeader\b/g)).toHaveLength(1);
    const head = surface.indexOf("<WorkspaceHeader");
    // Decision-first order: the header (and therefore the SAS) precedes every
    // consent card and the peer chooser, so a phone shows it without scrolling.
    expect(head).toBeLessThan(surface.indexOf("{#if pendingPeer}"));
    expect(head).toBeLessThan(surface.indexOf("{#if incoming}"));
    expect(head).toBeLessThan(surface.indexOf("{#each [send, recv].filter(Boolean)"));
    // The message panel is also the unified workspace's activity surface, so its
    // gate now admits a mixed link whose text lane has not opened yet.
    expect(head).toBeLessThan(surface.indexOf('{#if mixed || surfaceText.status !== "idle"}'));
    expect(head).toBeLessThan(surface.indexOf('<section class="peers"'));

    for (const prop of [
      "peerName={nameOf(workspace.linkPeerId)}",
      "status={workspace.linkStatus}",
      "sasCode={shownSas}",
      "path={workspace.linkPath}",
      // Not an inline `workspace.disconnect()`: the action also has to clear
      // App's own draft and launcher state synchronously — see
      // workspace-orchestration.test.ts.
      "onDisconnect={disconnectWorkspace}",
    ]) expect(surface).toContain(prop);
  });

  it("shows one SAS: no lane card repeats the link code", () => {
    // File progress card.
    expect(surface).toContain("{#if shownSas && !xf.done && !mixed}");
    // Incoming file consent card: an anchor, never a second code box — and the
    // anchor precedes the card, so aligning it under the pinned header reveals
    // the filenames and the buttons rather than scrolling them behind it.
    expect(surface).toMatch(
      /\{#if mixed\}\s*<div class="activity-reveal-marker" bind:this=\{incomingReveal\}[^]*?\{\/if\}\s*<section class="ui-card request">/,
    );
    // Message panel. `verifyOn` is the advanced-verification preference: with it
    // off there is no SAS anywhere, and with it on the mixed header still owns
    // the one code, so the panel renders it only in the legacy branch.
    expect(surface).toContain("showSas={!mixed && verifyOn}");

    // And the panel really has no unguarded verification box.
    for (const at of indicesOf(panel, 'class="sas"')) {
      const before = panel.slice(0, at);
      expect(before.slice(before.lastIndexOf("{#if "))).toContain("showSas");
    }
    expect(indicesOf(panel, 'class="sas"')).toHaveLength(2);
  });

  // The lifecycle states are rendered by WorkspaceHeader (covered in its own
  // test) — what has to hold HERE is that App actually hands them over. Each of
  // these props defaults to the benign value, so a dropped binding does not
  // fail: it silently shows a healthy link that is expiring, unrecoverable, or
  // already dead.
  it("hands the header the relay boundary, the recovery answer and the end reason", () => {
    for (const prop of [
      "relayExpiring={workspace.relayExpiring}",
      "recoveryAvailable={workspace.recoveryAvailable}",
      "endReason={workspace.linkEndReason}",
      // Terminal cards state a problem; without this they would offer no way out.
      "onRestart={restartWorkspace}",
    ]) expect(surface, prop).toContain(prop);
  });

  it("shows one path label, owned by the header", () => {
    expect(surface).toContain("{@const path = mixed ? undefined : xf.dir");
    expect(surface).toContain("path={mixed ? undefined : workspace.textPath}");
  });

  it("announces through the tested announcer, keyed on link identity", () => {
    // The once-per-link rule itself is covered by activity-announcement.test.ts.
    // What has to hold *here* is that App still routes through it and hands it
    // the link identity rather than the six digits — passing shownSas
    // as the key would silently restore the "same code, new link, never
    // announced" bug that the announcer exists to prevent.
    expect(app).toContain("const announcer = createActivityAnnouncer();");
    const call = app.slice(
      app.indexOf("const announcement = announcer.announce("),
      app.indexOf("await tick();", app.indexOf("const announcement = announcer.announce(")),
    );
    expect(call).toContain("mixed: workspace.usingMixed");
    expect(call).toContain("linkGeneration: workspace.linkGeneration");
    expect(call).toContain("codeLabel: t.codeLabel");
    expect(call).toContain("activityAnnouncement = announcement.text;");
    // Consent is never auto-answered and protected bodies never reach the live
    // region — only the edge lead and the code.
    expect(call).not.toMatch(/\.accept\(|\.body\b/);
    // No second, untested copy of the rule left behind in the component.
    expect(app).not.toContain("announcedLinkSas");
  });

  it("clears the reveal key when no edge is live, so a relink is not swallowed", () => {
    // The reveal key is peer+lane and carries no link generation, so a second
    // link to the same peer computes the SAME key — and the guard below would
    // then suppress that new link's authentication edge before the announcer is
    // ever consulted. Deleting this one reset reproduces exactly that: verified
    // by mutation in a real browser, where the fresh link's consent announced
    // "wants to send 1 file(s)" with no code at all.
    const effect = app.slice(
      app.indexOf("$effect(() => {", app.indexOf("function revealElement(")),
      app.indexOf("// ── ?debug=1"),
    );
    expect(effect).toMatch(/if \(!candidate\) \{[^]*?revealedActivity = "";[^]*?return;/);
    // The reset is only *reachable* because every SAS-bearing candidate is gated
    // on a SAS that comes from the link itself: once the link is gone there is no
    // candidate, so the effect runs with null during every teardown gap.
    const reveal = app.slice(app.indexOf("function activityReveal()"), app.indexOf("function revealElement("));
    // The EDGE triggers the reveal; only the announced code is preference-gated,
    // so a consent card still scrolls into view with verification off.
    expect(reveal).toContain("incoming && workspace.sasCode");
    expect(reveal).toContain("sas: shownSas || undefined");
    expect(reveal).toContain("!x.done && workspace.sasCode");
    expect(reveal).toContain("surfaceText.sasCode &&");
  });

  it("only counts a code as announced once its sentence has actually rendered", () => {
    // A sentence is a pending state write. A newer edge that takes the live
    // region before the next flush coalesces both writes, so the earlier one
    // never reaches the DOM — and committing the once-per-link allowance while
    // composing let that unheard sentence spend it, leaving the edge that DID
    // land with no code. Real glare between two tabs opening the text lane at
    // once reproduces it (e2e/mixed-link.mjs).
    const effect = revealEffect;
    // The turn is taken where the region is cleared, i.e. synchronously in the
    // effect body — taking it inside the async block would let the superseding
    // edge's own clear go unnoticed.
    expect(effect).toMatch(/activityAnnouncement = "";\s*const turn = \+\+announcementTurn;/);
    // Confirmed only after the flush that renders it, and only if no newer edge
    // has taken the region since.
    expect(effect).toMatch(
      /activityAnnouncement = announcement\.text;\s*await tick\(\);[^]*?if \(announcementTurn === turn\) announcement\.confirm\(\);/,
    );
    // No copy of the rule that spends the allowance at compose time.
    expect(effect).not.toMatch(/activityAnnouncement = announcer\.announce\(/);
  });

  it("ships the announcement effect free of debug instrumentation", () => {
    // Diagnosing the glare above meant parking a live-region trace on `window`
    // (`__e2eSay`) plus a timer to sample it a task later. That probe was
    // briefly left in the candidate change and caught before commit, so it never
    // shipped. It is not harmless here: the effect runs on every authentication
    // and consent edge, so the array grows unboundedly with SAS-bearing text,
    // and the timer fires after the turn check the effect exists to make. E2E
    // reads the live region and the announcement log, never a debug global —
    // see e2e/mixed-link.mjs.
    expect(revealEffect).not.toMatch(/__e2e|__debug/);
    // The cast is how such a global gets written at all under TS.
    expect(revealEffect).not.toMatch(/as unknown as/);
    // Nothing in this effect may be deferred past the tick that confirms it.
    expect(revealEffect).not.toMatch(/setTimeout|setInterval|queueMicrotask|requestIdleCallback/);
    expect(revealEffect).not.toMatch(/console\./);
    // `window` here is scroll measurement only; assignment would be a global.
    const windowUses = revealEffect.match(/window\.\w+/g) ?? [];
    expect(windowUses.every((use) => use === "window.scrollY" || use === "window.scrollTo")).toBe(true);
  });

  it("renders the queue with a cancel control routed by batch id", () => {
    expect(surface.match(/<QueuedBatches\b/g)).toHaveLength(1);
    expect(surface).toContain("batches={workspace.queuedBatches}");
    expect(surface).toContain("onCancel={(id) => workspace.cancelQueuedBatch(id)}");
  });

  it("measures the header at scroll time rather than reserving a guess", () => {
    // Two cheaper versions of this were measured wrong on a real tab. A constant
    // in the stylesheet assumed 196px against a real 274px. A ResizeObserver
    // binding then reported 54px — the header BEFORE its SAS row exists — while
    // the reveal was already scrolling, putting the consent card 121px behind
    // the header. The height is therefore read in the same synchronous block as
    // the scroll, and no stylesheet pretends to know it.
    expect(app).toContain("bind:element={headEl}");
    expect(app).toContain("headEl.getBoundingClientRect().height");
    expect(app).toMatch(/window\.scrollTo\(\{ top: Math\.max\(0, top\), behavior: "auto" \}\)/);
    for (const source of [app, panel]) {
      expect(source).not.toMatch(/scroll-margin-block-start:\s*calc\(196px/);
      expect(source).not.toContain("--workspace-head-h");
    }
    // Legacy still goes through scrollIntoView, and still scrolls the minimum.
    expect(app).toContain('target?.scrollIntoView?.({ block: "nearest" })');
  });

  it("leaves the legacy file, text and peer surfaces untouched", () => {
    // The legacy in-card SAS render site and its reveal target still exist.
    // The legacy verification box is preference-gated; its reveal anchor is not.
    expect(surface).toContain('{#if shownSas}');
    expect(surface).toMatch(/\{:else\}\s*<div class="activity-reveal-marker" bind:this=\{incomingReveal\}/);
    expect(surface).toContain('class="sas activity-reveal-target" bind:this={incomingReveal}');
    // One message render site for both branches; no duplicated protocol wiring.
    expect(surface.match(/<MessagePanel\b/g)).toHaveLength(1);
    // Peer actions still gate purely on the existing mutual-exclusion predicate
    // (it lives in the peerCard snippet, outside this surface), so a legacy peer
    // keeps its old blocked/enabled behaviour exactly.
    expect(app).toContain("{@const intentBlocked = workspace.blocksNewIntent(p.id)}");
    // The panel prop defaults to the legacy behaviour, so nothing else that
    // mounts MessagePanel changes.
    expect(panel).toContain("showSas = true");
  });

  it("activates link/1 with no build flag and no runtime switch", () => {
    // Behavioural coverage lives in peer-caps.test.ts and peer-workspace.test.ts.
    // What this pins is the *shape* of the activation.
    //
    // The build half is a plain constant, so a release does not depend on an
    // environment variable somebody has to remember to set — and cannot ship
    // half-advertised because they forgot.
    expect(caps).toContain("export const LINK_BUILD_SUPPORT = true");
    expect(caps).not.toContain("VITE_RELAYIUM_LINK_E2E");
    expect(caps).not.toContain("import.meta.env");
    // The room no longer scopes it (DECISION-LOG 2026-08-10) — but nothing
    // reachable by a page script or a user may scope it either. A query
    // parameter, a stored setting or an exported setter here would be a runtime
    // switch over a protocol scope.
    expect(caps).not.toMatch(/localStorage|location\.|searchParams|setAdvertised/);
    // One expression decides it, and both the roster hello and the SDP
    // confirmation are derived from that one expression. Asymmetry here is the
    // failure mode: advertising a capability we then refuse to route (or the
    // reverse) strands a peer that believed us.
    expect(caps.match(/CAP_PREUPLOAD\]/g)).toHaveLength(1);
    expect(caps).toContain("return linkRoomActive() ? [CAP_LINK, CAP_PREUPLOAD] : [];");
    // …and the withdrawn lane is not in it. `text/1` is still a NAMED constant —
    // a native peer announces it and a fixture has to be able to say so — but
    // this build must never put it in its own hello, because the transport it
    // promised is gone. The constant surviving while the announcement does not
    // is the exact shape the contraction has.
    expect(caps).toContain('export const CAP_TEXT = "text/1";');
    expect(caps.slice(caps.indexOf("export function advertisedCaps"))).not.toContain("CAP_TEXT");
    // preupload/1 is inside the SAME expression, not a second announcement:
    // its frame travels on the link's file channel, so a scope that withdraws
    // link/1 must withdraw it too rather than leave a promise we cannot keep.
    expect(caps).toMatch(/export function peerSupportsPreupload[\s\S]{0,600}?linkRoomActive\(\)/);
    // The routing predicate still reads that same expression before it reads the
    // peer's claim, so a future scope cannot be applied to what we announce and
    // forgotten in what we route.
    expect(caps).toMatch(/export function peerSupportsLink[\s\S]{0,600}?linkRoomActive\(\)/);
    // Exact membership, never a prefix/`some`/`startsWith` match: "link/2" and
    // "link/1x" are different wires and must not read as this one.
    expect(caps).toMatch(/announced\[peerId\] \?\? \[\]\)\.includes\(CAP_LINK\)/);
    expect(app).not.toContain("CAP_LINK");
  });

  // Requirement, not housekeeping: until these run, the page still holds the
  // previous room's peer claims and a live mixed link, both of which name peer
  // ids the new room's server will hand out again.
  it("clears capabilities and mixed state before a room switch rebinds the socket", () => {
    const switchRoom = app.slice(
      app.indexOf("async function switchRoom()"),
      app.indexOf("$effect(", app.indexOf("async function switchRoom()")),
    );
    expect(switchRoom).not.toBe("");
    const reset = switchRoom.indexOf("resetPeerCaps()");
    const teardown = switchRoom.indexOf("workspace.resetRoom()");
    const rebind = switchRoom.indexOf("signaling.reconnect(");
    expect(teardown).toBeGreaterThan(-1);
    expect(reset).toBeGreaterThan(teardown);
    expect(rebind).toBeGreaterThan(reset);
  });
});

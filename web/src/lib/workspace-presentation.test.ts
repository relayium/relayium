import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Source contract, like activity-visibility.test.ts: the rules below are about
// which nodes exist in which branch, which is exactly what a rendered snapshot of
// one state cannot prove. `link/1` is still unadvertised, so the legacy branch is
// the production path and has to stay byte-for-behaviour identical.
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
    expect(head).toBeLessThan(surface.indexOf('{#if activeText.status !== "idle"}'));
    expect(head).toBeLessThan(surface.indexOf('<section class="peers"'));

    for (const prop of [
      "peerName={nameOf(workspace.linkPeerId)}",
      "status={workspace.linkStatus}",
      "sasCode={workspace.sasCode}",
      "path={workspace.linkPath}",
      "onDisconnect={() => workspace.disconnect()}",
    ]) expect(surface).toContain(prop);
  });

  it("shows one SAS: no lane card repeats the link code", () => {
    // File progress card.
    expect(surface).toContain("{#if workspace.sasCode && !xf.done && !mixed}");
    // Incoming file consent card: an anchor, never a second code box — and the
    // anchor precedes the card, so aligning it under the pinned header reveals
    // the filenames and the buttons rather than scrolling them behind it.
    expect(surface).toMatch(
      /\{#if mixed\}\s*<div class="activity-reveal-marker" bind:this=\{incomingReveal\}[^]*?\{\/if\}\s*<section class="ui-card request">/,
    );
    // Message panel.
    expect(surface).toContain("showSas={!mixed}");

    // And the panel really has no unguarded verification box.
    for (const at of indicesOf(panel, 'class="sas"')) {
      const before = panel.slice(0, at);
      expect(before.slice(before.lastIndexOf("{#if "))).toContain("showSas");
    }
    expect(indicesOf(panel, 'class="sas"')).toHaveLength(2);
  });

  it("shows one path label, owned by the header", () => {
    expect(surface).toContain("{@const path = mixed ? undefined : xf.dir");
    expect(surface).toContain("path={mixed ? undefined : workspace.textPath}");
  });

  it("announces through the tested announcer, keyed on link identity", () => {
    // The once-per-link rule itself is covered by activity-announcement.test.ts.
    // What has to hold *here* is that App still routes through it and hands it
    // the link identity rather than the six digits — passing workspace.sasCode
    // as the key would silently restore the "same code, new link, never
    // announced" bug that the announcer exists to prevent.
    expect(app).toContain("const announcer = createActivityAnnouncer();");
    const call = app.slice(
      app.indexOf("activityAnnouncement = announcer.announce("),
      app.indexOf("await tick();", app.indexOf("activityAnnouncement = announcer.announce(")),
    );
    expect(call).toContain("mixed: workspace.usingMixed");
    expect(call).toContain("linkGeneration: workspace.linkGeneration");
    expect(call).toContain("codeLabel: t.codeLabel");
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
    expect(reveal).toContain("incoming && workspace.sasCode");
    expect(reveal).toContain("!x.done && workspace.sasCode");
    expect(reveal).toContain("activeText.sasCode &&");
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
    expect(surface).toContain('{#if !mixed && workspace.sasCode}');
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

  it("still does not advertise link/1 outside the build-time E2E seam", () => {
    // Behavioural coverage of both branches lives in peer-caps.test.ts. What
    // this pins is the *shape* of the switch: exactly one guard, reading a
    // build-time constant, with no runtime setter beside it. A query parameter,
    // a localStorage read or an exported setter here would turn a test seam into
    // a shipped switch for a protocol that is not finished.
    // Plain member access, not optional chaining: only this form is substituted
    // by Vite, so only this form folds to a constant in a default bundle.
    expect(caps).toContain('import.meta.env.VITE_RELAYIUM_LINK_E2E === "1"');
    expect(caps.match(/CAP_LINK\]/g)).toHaveLength(1);
    expect(caps).toContain("linkE2E ? [CAP_TEXT, CAP_LINK] : [CAP_TEXT]");
    expect(caps).not.toMatch(/localStorage|location\.|searchParams|setAdvertised/);
    expect(app).not.toContain("CAP_LINK");
  });
});

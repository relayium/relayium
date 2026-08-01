import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const app = readFileSync(resolve(process.cwd(), "src/App.svelte"), "utf8");
const surface = app.slice(
  app.indexOf("{#snippet transferSurface()}"),
  app.indexOf("{/snippet}", app.indexOf("{#snippet transferSurface()}")) + "{/snippet}".length,
);
const styles = app.slice(app.lastIndexOf("<style>"));

describe("active transfer visibility contract", () => {
  it("keeps activity in real DOM order before peer selection with one message render site", () => {
    const peers = surface.indexOf('<section class="peers"');
    expect(surface.indexOf("{#if pendingPeer}")).toBeLessThan(peers);
    expect(surface.indexOf("{#if incoming}")).toBeLessThan(peers);
    expect(surface.indexOf("{#each [send, recv].filter(Boolean)")).toBeLessThan(peers);
    expect(surface.indexOf('{#if activeText.status !== "idle"}')).toBeLessThan(peers);
    expect(surface.match(/<MessagePanel\b/g)).toHaveLength(1);
    // CSS visual ordering would leave keyboard and reading order broken.
    expect(styles).not.toMatch(/\border\s*:/);
  });

  it("uses a persistent polite announcement and a non-focusing, instant reveal", () => {
    const effect = app.slice(app.indexOf("$effect(() => {", app.indexOf("function revealElement(")), app.indexOf("// ── ?debug=1"));
    expect(surface).toContain('role="status" aria-live="polite" aria-atomic="true"');
    // The legacy surface still scrolls the minimum, so a decision already on
    // screen never moves the page. Only the unified workspace, whose pinned
    // header makes "nearest" a no-op for an already-visible anchor, takes the
    // explicit branch — see workspace-presentation.test.ts.
    expect(effect).toContain('target?.scrollIntoView?.({ block: "nearest" })');
    expect(effect).not.toMatch(/\.focus\s*\(/);
    expect(effect).not.toMatch(/behavior:\s*["']smooth/);
    expect(surface).not.toContain('role="alertdialog"');
    expect(surface).toContain('class="sas activity-reveal-target" bind:this={incomingReveal}');
    expect(surface).toContain("bind:revealTarget={textReveal}");
    expect(surface).not.toContain('bind:this={textReveal} aria-hidden="true"');
  });

  it("reveals only verification and consent edges, never progress or terminal states", () => {
    const reveal = app.slice(app.indexOf("function activityReveal()"), app.indexOf("function revealElement("));
    expect(reveal).toContain('activeText.status === "waitingAccept"');
    expect(reveal).toContain('activeText.status === "incomingRequest"');
    expect(reveal).toContain("!x.done && workspace.sasCode");
    expect(reveal.match(/key: `file:recv:\$\{/g)).toHaveLength(1);
    expect(reveal).not.toMatch(/receiving|sending|finishing|ended|failed|refused/);
  });
});

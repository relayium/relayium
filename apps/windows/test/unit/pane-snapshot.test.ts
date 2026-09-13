// The timeout report is only worth anything if it describes a real screen.
//
// Its whole purpose is to be read once, months from now, by someone looking at
// a red Windows run they cannot reproduce. Three ways it could quietly stop
// doing that, all of which pass CI in the meantime:
//
//  - a marker name in the list that the renderer no longer renders, so the
//    snapshot is always empty and the report says "nothing on screen at all"
//    about a perfectly populated pane;
//  - a receipt the watch tests for but the snapshot does not name, so the one
//    state the round was closest to reaching is the one it does not mention;
//  - a driver that stopped calling it.

import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
// @ts-expect-error -- a plain .mjs the Electron smoke driver also imports
import { PANE_HOOKS, RECEIPT_MARKERS, SNAPSHOT_EXPR, stoppedBecauseFor } from "../smoke/pane-snapshot.mjs";

const hooks: string[] = PANE_HOOKS;
const receipts: string[] = RECEIPT_MARKERS;
const RENDERER = fileURLToPath(new URL("../../src/renderer", import.meta.url));
const DRIVER = fileURLToPath(new URL("../smoke/realtime-peer-main.mjs", import.meta.url));

/** Every `data-test` name the renderer actually renders. */
function renderedHooks(): Set<string> {
  const found = new Set<string>();
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(svelte|ts)$/.test(entry.name)) {
        for (const m of readFileSync(full, "utf8").matchAll(/data-test="([^"]+)"/g)) found.add(m[1]);
      }
    }
  };
  walk(RENDERER);
  return found;
}

describe("the pane snapshot", () => {
  it("names only markers the renderer renders", () => {
    const rendered = renderedHooks();
    // Guards the guard: a renderer scan that found nothing would let anything
    // through while reporting a clean pass.
    expect(rendered.size).toBeGreaterThan(30);
    expect(hooks.filter((h) => !rendered.has(h))).toEqual([]);
  });

  it("names every receipt the watch tests for", () => {
    expect(receipts.length).toBeGreaterThanOrEqual(5);
    expect(receipts.filter((r) => !hooks.includes(r))).toEqual([]);
  });

  it("has no duplicates", () => {
    expect([...new Set(hooks)]).toEqual(hooks);
  });

  it("reads the page in one pass", () => {
    // Twenty-two round trips against a live page would describe a state that
    // never existed. One `querySelectorAll`-free expression, one `filter`.
    expect(SNAPSHOT_EXPR.match(/\.filter\(has\)/g)).toHaveLength(1);
    for (const hook of hooks) expect(SNAPSHOT_EXPR).toContain(`"${hook}"`);
  });

  it("says nothing beyond which markers were present", () => {
    // No `textContent` harvesting beyond the app's own status line: this runs
    // against a real transfer, and file names and peer names must not reach a
    // CI log.
    expect(SNAPSHOT_EXPR.match(/textContent/g)).toHaveLength(1);
    expect(SNAPSHOT_EXPR).toContain('data-test="link-status"');
    expect(SNAPSHOT_EXPR).not.toContain("innerHTML");
    expect(SNAPSHOT_EXPR).not.toContain("body");
  });

  it("copies a status line that cannot carry a peer's details", () => {
    // The one piece of TEXT the snapshot takes. Safe today because the element
    // is a single `t(...)` over a total key map — no peer name, no file name,
    // no path. An edit that interpolated one would start leaking it into a
    // public CI log, and nothing else in the repository would notice.
    const pane = readFileSync(fileURLToPath(new URL("../../src/renderer/pages/LinkPane.svelte", import.meta.url)), "utf8");
    const line = pane.match(/data-test="link-status"[^>]*>([^<]*)</);
    expect(line).not.toBeNull();
    expect(line![1].trim()).toMatch(/^\{t\([A-Z_]+\[[a-z]+\]\)\}$/);
  });

  it("tells an empty screen apart from a stalled one", () => {
    expect(stoppedBecauseFor(120_000, [])).toBe(
      "the 120000ms watch budget elapsed with NO pane state on screen at all");
    expect(stoppedBecauseFor(120_000, ["link-status", "sas-pending"])).toBe(
      "the 120000ms watch budget elapsed while showing link-status, sas-pending");
  });

  it("is what the driver actually reports on a timeout", () => {
    const driver = readFileSync(DRIVER, "utf8");
    expect(driver).toContain("stoppedBecauseFor(budgetMs, snapshot.present)");
    // Only when the watch ran out. A round that worked prints what it always did.
    expect(driver).toContain("if (!timing.stoppedBecause) {");
    // And a read that threw is reported as a read that threw, never as an
    // empty screen — the failure mode this whole file exists to remove.
    expect(driver).toContain("the window could not be read");
  });
});

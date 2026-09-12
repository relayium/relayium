// A blocked build must not BUILD its product surfaces.
//
// Not hidden, not `disabled` - not built. The rule is `AppVersionGate.swift`'s
// and so is the reason: a below-minimum build must not open a room socket,
// stage a selection from Explorer, or register for anything while it shows the
// reader why it cannot run. Hiding a component still mounts it, and a mounted
// transfer page starts work in its own effects.
//
// ## Why this is a source assertion
//
// The property is structural: it is about which branch each surface lives in,
// not about what any of them does. Executing it would mean launching the real
// app with a blocked policy, which the App smoke cannot do today without a
// second spawn - that is recorded as owed, and this holds the line meanwhile.
// A source check is the wrong tool for behaviour and the right one for shape.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const APP = "src/renderer/App.svelte";

/** Everything that must be inside the `{:else}`, by the name it is used under. */
const SURFACES = [
  "PendingSelection",
  "LanPage",
  "PairPage",
  "StoredPage",
  "InboxPage",
  "AccountPage",
  "Help",
];

describe("a build the product has withdrawn support for", () => {
  const source = readFileSync(APP, "utf8");
  const markup = source.slice(source.lastIndexOf("</script>"));

  it("has exactly one blocked branch, at the top of the shell", () => {
    // A second one would mean two answers to the same question, and the reader
    // of this file could not tell which governs a given surface.
    const opens = [...markup.matchAll(/\{#if support\?\.state === "blocked"\}/g)];
    expect(opens.length).toBe(1);
    // Before every product surface, so the `{:else}` can contain them all.
    const gateAt = opens[0]!.index!;
    for (const name of SURFACES) {
      const at = markup.indexOf(`<${name}`);
      expect(at, `${name} is not rendered at all`).toBeGreaterThan(-1);
      expect(at, `${name} is rendered before the gate`).toBeGreaterThan(gateAt);
    }
  });

  it("renders every product surface inside the else, never beside it", () => {
    // The branch's own `{:else}` is the first one after it at the same depth.
    const gateAt = markup.indexOf('{#if support?.state === "blocked"}');
    const elseAt = markup.indexOf("{:else}", gateAt);
    expect(elseAt, "the blocked branch has no else").toBeGreaterThan(gateAt);
    for (const name of SURFACES) {
      expect(markup.indexOf(`<${name}`), `${name} is outside the else`).toBeGreaterThan(elseAt);
    }
  });

  it("offers no action that a policy document could aim", () => {
    // The blocked card is reached BECAUSE of a document fetched over the
    // network. An update button here would be the one place that document
    // could influence what gets installed - so the card has no buttons, and
    // where an update comes from stays the shipped updater's pinned feed.
    const cardStart = markup.indexOf('{#if support?.state === "blocked"}');
    const cardEnd = markup.indexOf("{:else}", cardStart);
    const card = markup.slice(cardStart, cardEnd);
    expect(card).not.toMatch(/<button/);
    expect(card).not.toMatch(/<a\s/);
    expect(card).not.toMatch(/https?:/);
  });

  it("says which version is required and which to move to", () => {
    const cardStart = markup.indexOf('{#if support?.state === "blocked"}');
    const card = markup.slice(cardStart, markup.indexOf("{:else}", cardStart));
    // A card that only said "unsupported" would leave a person with nothing to
    // do. All three values come from the report, never from the document text.
    for (const field of ["current", "minimum", "latest"]) {
      expect(card, `the card does not name ${field}`).toContain(`${field}: support.${field}`);
    }
  });

  it("recommends inside the else, never over the blocked card", () => {
    // A build the product has withdrawn support for must not ALSO be told a
    // newer one is available: it is not a recommendation, it is a stop. The
    // banner therefore lives inside the same `{:else}` as the product.
    const gateAt = markup.indexOf('{#if support?.state === "blocked"}');
    const elseAt = markup.indexOf("{:else}", gateAt);
    const bannerAt = markup.indexOf('{#if support?.state === "recommended"');
    expect(bannerAt, "the recommendation banner is not rendered at all").toBeGreaterThan(-1);
    expect(bannerAt, "the banner is outside the else").toBeGreaterThan(elseAt);
  });

  it("offers no action a policy document could aim, on the banner either", () => {
    // Same rule as the blocked card and for the same reason. The one button
    // here dismisses; it goes nowhere.
    const at = markup.indexOf('{#if support?.state === "recommended"');
    const banner = markup.slice(at, markup.indexOf("{/if}", at));
    expect(banner).not.toMatch(/<a\s/);
    expect(banner).not.toMatch(/https?:/);
    expect(banner).toContain("update-dismiss");
  });

  it("treats an absent report as supported", () => {
    // Failing open includes the moment before `appInfo` has answered, and a
    // composition that never opened a gate. `support?.state === "blocked"` is
    // false for `null`, and this pins the `?.` that makes it so.
    expect(markup).toContain('{#if support?.state === "blocked"}');
    expect(markup).not.toContain('{#if support.state === "blocked"}');
  });
});

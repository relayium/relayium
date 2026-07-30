import { describe, it, expect } from "vitest";
import { pricing } from "./content/spa-pages.mjs";

describe("/pricing static shell covers files and ephemeral text", () => {
  it("positions file and text transfer in metadata and the hero", () => {
    expect(pricing.description).toMatch(/file and live-text/i);
    expect(pricing.hero.pitch).toMatch(/file and live-text/i);
  });

  it("keeps direct text free while metering browser relay bandwidth", () => {
    const direct = pricing.how.steps.join(" ");
    expect(direct).toMatch(/ephemeral text/i);
    expect(direct).toMatch(/send or text code/i);
    expect(direct).toMatch(/never stored/i);

    const relay = pricing.why.items.find((item) => item.title === "Relay bandwidth");
    expect(relay?.desc).toMatch(/file or text/i);
    expect(relay?.desc).toMatch(/browser/i);
    expect(relay?.desc).toMatch(/monthly allowance/i);
  });

  it("documents the online-only text boundary in the FAQ", () => {
    const free = pricing.faq.items.find((item) => item.q === "Is it really free?");
    expect(free?.a).toMatch(/both devices online/i);
    expect(free?.a).toMatch(/never stored/i);
  });
});

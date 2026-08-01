import { describe, it, expect, vi, afterEach } from "vitest";
import { mount, unmount, flushSync } from "svelte";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import PricingPage from "./PricingPage.svelte";
import { setLang, messages as liveMessages } from "./i18n.svelte";

const TIERS = [
  { id: "free", name: "Free", storageBytes: 1e9, trafficBytes: 1e9, retentionSecs: 86400, priceMonthly: 0, priceYearly: 0, purchasableMonthly: false, purchasableYearly: false },
  { id: "plus", name: "Plus", storageBytes: 5e9, trafficBytes: 3e11, retentionSecs: 30 * 86400, priceMonthly: 390, priceYearly: 2900, purchasableMonthly: true, purchasableYearly: true },
  { id: "pro", name: "Pro", storageBytes: 5e10, trafficBytes: 1e12, retentionSecs: 90 * 86400, priceMonthly: 890, priceYearly: 7900, purchasableMonthly: true, purchasableYearly: true },
  { id: "max", name: "Max", storageBytes: 2e11, trafficBytes: 4e12, retentionSecs: 14 * 86400, priceMonthly: 1990, priceYearly: 19900, purchasableMonthly: true, purchasableYearly: true },
];

let target: HTMLDivElement;
let app: unknown;

async function mountPage() {
  // Load and select the table before mount: PricingPage and Pricing both read
  // messages[lang()] synchronously in a $derived (mirrors main.ts's bootstrap).
  await setLang("en");
  target = document.createElement("div");
  document.body.appendChild(target);
  app = mount(PricingPage, { target });
  // Drain Pricing's onMount fetch()+json() chain, then flush the $state write.
  await new Promise((r) => setTimeout(r, 0));
  flushSync();
}

/** true when `a` precedes `b` in document order. */
function precedes(a: Element, b: Element): boolean {
  return !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
}

afterEach(() => {
  if (app) unmount(app as never);
  target?.remove();
  vi.unstubAllGlobals();
});

describe("PricingPage hierarchy", () => {
  // The defect this batch fixes: the whole free-vs-paid essay came first, so a
  // visitor at 1440x900 never saw a price or a billing cycle in the first
  // viewport. Order is the fix, so order is what's pinned here — a DOM-order
  // assertion survives any amount of CSS churn.
  it("puts the billing-cycle control and the tiers before the free-vs-paid explainer", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => TIERS })) as unknown as typeof fetch);
    await mountPage();

    const head = target.querySelector("header")!;
    const pricing = target.querySelector(".pricing")!;
    const explainer = target.querySelector(".explainer")!;
    const selfhost = target.querySelector(".selfhost")!;
    const faq = target.querySelector(".faq")!;
    for (const el of [head, pricing, explainer, selfhost, faq]) expect(el).toBeTruthy();

    expect(precedes(head, pricing), "header must precede the tiers").toBe(true);
    expect(precedes(pricing, explainer), "tiers must precede the explainer").toBe(true);
    expect(precedes(explainer, selfhost), "explainer must precede self-hosting").toBe(true);
    expect(precedes(selfhost, faq), "self-hosting must precede the FAQ").toBe(true);

    // The cycle control and a real price are both inside that first block.
    expect(pricing.querySelector('[role="group"]')).not.toBeNull();
    expect(pricing.textContent).toContain("$3.90");
  });

  it("adopts the shared page header and still shows title, subtitle and the signed-out CTA", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => TIERS })) as unknown as typeof fetch);
    await mountPage();

    const p = liveMessages.en.pricingPage;
    const head = target.querySelector("header")!;
    expect(head.classList.contains("ui-page-head")).toBe(true);
    expect(head.querySelector("h1")?.textContent).toBe(p.title);
    expect(head.textContent).toContain(p.subtitle);
    // No session in this test's store, so the sign-in nudge is present.
    expect(head.textContent).toContain(p.signedOutCta);
  });

  // Reordering is only safe if nothing was dropped on the way. Every explainer
  // bullet, the self-host block and all six FAQ entries are still rendered.
  it("keeps the complete explainer, self-host block and all six FAQ entries", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => TIERS })) as unknown as typeof fetch);
    await mountPage();

    const p = liveMessages.en.pricingPage;
    const explainer = target.querySelector(".explainer")!;
    for (const s of [p.freeTitle, p.freeLead, p.free1, p.free2, p.free3, p.freeWhy,
                     p.paidTitle, p.paidLead, p.paid1, p.paid2, p.paid3, p.paidWhy]) {
      expect(explainer.textContent, `explainer lost: ${s.slice(0, 32)}…`).toContain(s);
    }
    expect(explainer.querySelectorAll(".card").length).toBe(2);
    expect(explainer.querySelectorAll("li").length).toBe(6);

    const selfhost = target.querySelector(".selfhost")!;
    expect(selfhost.textContent).toContain(p.selfhostTitle);
    expect(selfhost.textContent).toContain(p.selfhostBody);
    expect(selfhost.querySelector("button")?.textContent?.trim()).toBe(p.selfhostCta);

    const faq = target.querySelector(".faq")!;
    expect(faq.textContent).toContain(p.faqTitle);
    const qa = faq.querySelectorAll(".qa");
    expect(qa.length).toBe(6);
    for (const [q, a] of [[p.q1, p.a1], [p.q2, p.a2], [p.q3, p.a3], [p.q4, p.a4], [p.q5, p.a5], [p.q6, p.a6]]) {
      expect(faq.textContent).toContain(q);
      expect(faq.textContent).toContain(a);
    }
  });

  it("uses the shared card/stack surfaces on the explainer and self-host blocks", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => TIERS })) as unknown as typeof fetch);
    await mountPage();

    for (const card of target.querySelectorAll(".explainer .card")) {
      expect(card.classList.contains("ui-card")).toBe(true);
      expect(card.classList.contains("ui-stack")).toBe(true);
    }
    const selfhost = target.querySelector(".selfhost")!;
    expect(selfhost.classList.contains("ui-card")).toBe(true);
    expect(selfhost.classList.contains("ui-stack")).toBe(true);
  });
});

// These four variables are not defined anywhere in app.css, so every reference
// silently fell through to its page-local fallback — which is exactly how the
// paid price ended up at ~22.5px, barely above body copy. A source-level check
// is the only thing that catches them coming back: jsdom does not resolve
// custom properties, so no rendered assertion can.
describe("pricing components reference no phantom design tokens", () => {
  const PHANTOM = ["--fs-xl", "--fs-lg", "--fs-md", "--text-muted"];
  for (const file of ["PricingPage.svelte", "Pricing.svelte"]) {
    it(`${file} defines or reads none of ${PHANTOM.join(", ")}`, () => {
      const src = readFileSync(join(import.meta.dirname, file), "utf8");
      for (const token of PHANTOM) {
        expect(src, `${file} still references ${token}`).not.toContain(token);
      }
    });
  }
});

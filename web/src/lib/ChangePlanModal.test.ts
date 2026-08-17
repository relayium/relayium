import { it, expect, vi, afterEach } from "vitest";
import { mount, unmount, flushSync } from "svelte";
import ChangePlanModal from "./ChangePlanModal.svelte";
import { loadLang } from "./i18n.svelte";

let target: HTMLDivElement;
let app: unknown;

// Stripe's projected renewal, rendered the way the modal renders it. Comparing
// against a hard-coded string would fail on a machine with another locale/zone
// without the modal being wrong.
const RENEWAL = 1789999999;
const renewalText = new Date(RENEWAL * 1000).toLocaleDateString("en");

async function mountModal(preview: Record<string, unknown>) {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url === "/api/billing/preview") return { ok: true, status: 200, json: async () => preview };
    throw new Error(`unexpected ${url}`);
  }) as unknown as typeof fetch);
  await loadLang("en");
  target = document.createElement("div");
  document.body.appendChild(target);
  app = mount(ChangePlanModal, { target, props: { planId: "pro", planName: "Pro", cycle: "yearly", onclose: () => {} } });
  await new Promise((r) => setTimeout(r, 0)); flushSync();
  await new Promise((r) => setTimeout(r, 0)); flushSync();
  return target.textContent ?? "";
}

afterEach(() => { if (app) unmount(app as never); target?.remove(); vi.restoreAllMocks(); });

it("shows the immediate charge and Stripe's renewal date for an upgrade", async () => {
  const text = await mountModal({
    effective: "now", immediateChargeCents: 734, immediateAdjustmentCents: 734,
    nextAmountCents: 9999, nextCycle: "yearly", effectiveDate: RENEWAL,
  });
  expect(text).toContain("$7.34");
  expect(text).toContain("$99.99");
  // The projected renewal, not the stale current-period anchor.
  expect(text).toContain(renewalText);
});

it("reports a negative proration as a credit, not as a $0 charge", async () => {
  // Stripe floors the invoice at zero, so the charge really is $0 while the
  // customer is owed $12.50. Saying "charged $0.00" would be the misleading part.
  const text = await mountModal({
    effective: "now", immediateChargeCents: 0, immediateAdjustmentCents: -1250,
    nextAmountCents: 9999, nextCycle: "yearly", effectiveDate: RENEWAL,
  });
  expect(text).toContain("$12.50");
  expect(text).toMatch(/credit/i);
  expect(text).not.toMatch(/charged/i);
  expect(text).not.toContain("$0.00");
  expect(text).not.toContain("-$");
});

it("states a zero adjustment without inventing a charge or a credit", async () => {
  const text = await mountModal({
    effective: "now", immediateChargeCents: 0, immediateAdjustmentCents: 0,
    nextAmountCents: 9999, nextCycle: "yearly", effectiveDate: RENEWAL,
  });
  expect(text).toMatch(/no extra cost/i);
  expect(text).not.toMatch(/charged|credit/i);
  expect(text).not.toContain("$0.00");
  expect(text).toContain("$99.99");
  expect(text).toContain(renewalText);
});

it("names both stages of a composite yearly-then-monthly change", async () => {
  const text = await mountModal({
    effective: "now_then_period_end", immediateChargeCents: 4200, immediateAdjustmentCents: 4200,
    nextAmountCents: 999, nextCycle: "monthly", effectiveDate: RENEWAL,
    immediateCycle: "yearly", immediateAmountCents: 9999,
    scheduledCycle: "monthly", scheduledAmountCents: 999,
  });
  expect(text).toContain("$42.00"); // charged today
  expect(text).toContain("$99.99"); // the yearly stage applied now
  expect(text).toContain("$9.99"); // the monthly stage that follows
  expect(text).toMatch(/Yearly/);
  expect(text).toMatch(/Monthly/);
  expect(text).toContain(renewalText); // when the monthly stage lands
});

it("shows a period-end summary with no charge for a downgrade", async () => {
  const text = await mountModal({
    effective: "period_end", immediateChargeCents: 0, immediateAdjustmentCents: 0,
    nextAmountCents: 199, nextCycle: "monthly", effectiveDate: RENEWAL,
  });
  expect(text).toMatch(/period end|Takes effect/i);
  expect(text).not.toContain("charged");
  expect(text).toContain(renewalText);
});

it("keeps the dialog open and explains an incomplete payment", async () => {
  let calls = 0;
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    calls++;
    if (url === "/api/billing/preview") return { ok: true, json: async () => ({
      effective: "now", immediateChargeCents: 734, immediateAdjustmentCents: 734,
      nextAmountCents: 9999, nextCycle: "yearly", effectiveDate: RENEWAL,
    }) };
    if (url === "/api/billing/change-plan") return { ok: true, status: 202, json: async () => ({ status: "payment_pending" }) };
    throw new Error(`unexpected ${url}`);
  }) as unknown as typeof fetch);
  await loadLang("en");
  target = document.createElement("div"); document.body.appendChild(target);
  app = mount(ChangePlanModal, { target, props: { planId: "pro", planName: "Pro", cycle: "yearly", onclose: vi.fn() } });
  await new Promise((r) => setTimeout(r, 0)); flushSync();
  (target.querySelector("button.btn-primary") as HTMLButtonElement).click();
  await new Promise((r) => setTimeout(r, 0)); flushSync();
  expect(calls).toBe(2);
  expect(target.textContent).toMatch(/needs action and may expire/i);
});

it("says a pending composite has not scheduled its second stage", async () => {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url === "/api/billing/preview") return { ok: true, json: async () => ({
      effective: "now_then_period_end", immediateChargeCents: 734,
      immediateAdjustmentCents: 734, nextAmountCents: 999,
      nextCycle: "monthly", effectiveDate: RENEWAL,
      immediateCycle: "yearly", immediateAmountCents: 9999,
      scheduledCycle: "monthly", scheduledAmountCents: 999,
    }) };
    if (url === "/api/billing/change-plan") return {
      ok: true, status: 202, json: async () => ({
        status: "payment_pending", effective: "payment_pending",
        requestedEffect: "now_then_period_end",
      }),
    };
    throw new Error(`unexpected ${url}`);
  }) as unknown as typeof fetch);
  await loadLang("en");
  target = document.createElement("div"); document.body.appendChild(target);
  app = mount(ChangePlanModal, { target, props: {
    planId: "pro", planName: "Pro", cycle: "monthly", onclose: vi.fn(),
  } });
  await new Promise((r) => setTimeout(r, 0)); flushSync();
  (target.querySelector("button.btn-primary") as HTMLButtonElement).click();
  await new Promise((r) => setTimeout(r, 0)); flushSync();
  expect(target.textContent).toMatch(/later cycle switch was not scheduled/i);
});

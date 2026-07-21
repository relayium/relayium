import { describe, it, expect, vi, afterEach } from "vitest";
import { mount, unmount, flushSync } from "svelte";
import ChangePlanModal from "./ChangePlanModal.svelte";
import { loadLang } from "./i18n.svelte";

let target: HTMLDivElement;
let app: unknown;

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
}

afterEach(() => { if (app) unmount(app as never); target?.remove(); vi.restoreAllMocks(); });

it("shows the immediate charge for an upgrade", async () => {
  await mountModal({ effective: "now", immediateChargeCents: 734, nextAmountCents: 9999, nextCycle: "yearly", effectiveDate: 1789999999 });
  expect(target.textContent ?? "").toContain("$7.34");
});

it("shows a period-end summary with no charge for a downgrade", async () => {
  await mountModal({ effective: "period_end", immediateChargeCents: 0, nextAmountCents: 199, nextCycle: "monthly", effectiveDate: 1789999999 });
  const text = target.textContent ?? "";
  expect(text).toMatch(/period end|Takes effect/i);
  expect(text).not.toContain("charged");
});

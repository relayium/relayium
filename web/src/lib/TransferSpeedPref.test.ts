import { afterEach, describe, expect, it } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import TransferSpeedPref from "./TransferSpeedPref.svelte";
import { loadLang, setLang } from "./i18n.svelte";
import { reloadSpeedPref, speedPref } from "./transfer-speed-pref.svelte";

let target: HTMLDivElement;
let app: unknown;

async function render(lang: "en" | "zh" = "en", props: { open?: boolean } = { open: true }) {
  await loadLang(lang);
  await setLang(lang);
  target = document.createElement("div");
  document.body.appendChild(target);
  app = mount(TransferSpeedPref, { target, props });
  flushSync();
}

/** What a user's click on <summary> does natively: flip `open`, fire `toggle`. */
function userToggle(open: boolean) {
  const d = target.querySelector("details")!;
  d.open = open;
  d.dispatchEvent(new Event("toggle"));
  flushSync();
}
function chooseRadio(mode: "fast" | "background" | "cap") {
  const r = target.querySelector<HTMLInputElement>(`input[value="${mode}"]`)!;
  r.checked = true;
  r.dispatchEvent(new Event("change", { bubbles: true }));
  flushSync();
}
function chooseCap(bps: number) {
  const sel = target.querySelector("select")!;
  sel.value = String(bps);
  sel.dispatchEvent(new Event("change", { bubbles: true }));
  flushSync();
}

afterEach(() => {
  if (app) unmount(app as never);
  app = null;
  target?.remove();
  localStorage.removeItem("relayium.transfer.speed");
  reloadSpeedPref();
});

describe("TransferSpeedPref keeps the user's expanded state (Root L1-UI-REVIEW B1)", () => {
  it("default-collapsed card opened by the user stays open through mode, limit and language changes", async () => {
    await render("en", {});
    const d = target.querySelector("details")!;
    expect(d.open, "collapsed by default").toBe(false);
    userToggle(true);
    chooseCap(256 * 1024);
    expect(d.open, "still open after choosing a limit").toBe(true);
    expect(target.textContent, "the limit's note is visible").toContain("short burst");
    chooseRadio("background");
    expect(d.open, "still open after choosing background").toBe(true);
    chooseRadio("fast");
    expect(d.open).toBe(true);
    chooseRadio("cap");
    expect(d.open).toBe(true);
    await setLang("zh");
    flushSync();
    expect(d.open, "still open after a language change").toBe(true);
    expect(target.querySelector("summary")?.textContent).toBe("上传速度");
  });

  it("a card the user collapsed stays collapsed across unrelated updates", async () => {
    await render("en", { open: true });
    const d = target.querySelector("details")!;
    expect(d.open).toBe(true);
    userToggle(false);
    chooseCap(512 * 1024);
    expect(d.open).toBe(false);
    await setLang("zh");
    flushSync();
    expect(d.open).toBe(false);
  });
});

describe("TransferSpeedPref", () => {
  it("defaults to Fastest and says which uploads it governs", async () => {
    await render();
    const checked = target.querySelector<HTMLInputElement>('input[type="radio"]:checked');
    expect(checked?.value).toBe("fast");
    expect(target.textContent).toContain("Live device-to-device transfers are not limited by this setting yet");
  });

  it("choosing a limit drives the preference the uploader reads, and explains bursts", async () => {
    await render();
    const select = target.querySelector("select")!;
    select.value = String(256 * 1024);
    select.dispatchEvent(new Event("change", { bubbles: true }));
    flushSync();
    expect(speedPref()).toEqual({ mode: "cap", capBytesPerSec: 256 * 1024 });
    expect(target.textContent).toContain("short burst");
    expect(target.querySelector("select option:checked")?.textContent).toBe("2.1 Mbit/s");
  });

  it("background choice is persisted", async () => {
    await render();
    const bg = target.querySelector<HTMLInputElement>('input[value="background"]')!;
    bg.checked = true;
    bg.dispatchEvent(new Event("change", { bubbles: true }));
    flushSync();
    expect(speedPref().mode).toBe("background");
  });

  it("renders in Simplified Chinese", async () => {
    await render("zh");
    expect(target.querySelector("summary")?.textContent).toBe("上传速度");
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mount, unmount } from "svelte";
import MePage from "./MePage.svelte";
import { loadLang } from "./i18n.svelte";

// 后端一直有列出/吊销 CLI 设备的接口，界面上却一直没有入口——用户既看不到哪几台
// 机器持有能代表自己传输/上传的令牌，也没法吊销任何一台。丢了笔记本时这是唯一能
// 自救的地方，所以这几条用例守的是"它真的渲染出来了、按钮真的打到了删除接口"。
const DEVICES = {
  devices: [
    { ID: "d-cli-1", Name: "work-laptop", CreatedAt: 1_700_000_000, LastSeenAt: 1_700_100_000, Kind: "cli" },
    { ID: "d-cli-2", Name: "old-vps", CreatedAt: 1_690_000_000, LastSeenAt: 0, Kind: "cli" },
    { ID: "d-browser", Name: "Chrome", CreatedAt: 1_700_000_000, LastSeenAt: 1_700_000_000, Kind: "browser" },
  ],
};

function stubFetch(overrides: Record<string, unknown> = {}) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const body =
      url.startsWith("/api/devices") && init?.method === "DELETE" ? {} :
      url.startsWith("/api/devices") ? DEVICES :
      url.startsWith("/api/nodes/mine") ? { nodes: [] } :
      url.startsWith("/api/files") ? { files: [] } :
      url.startsWith("/api/stats") ? { transfers: 0, downloads: 0, uploadBytes: 0, downloadBytes: 0, relayBytes: 0 } :
      // QuotaMeters 会自己去拉这个；不给它正确形状的话组件会在渲染里抛异常，
      // 表现为"用例过了但有未处理错误"——那种噪音会掩盖真正的失败。
      url.startsWith("/api/me/usage") ? {
        period: "202607", resetsAt: 0,
        traffic: { used: 0, cap: 0 }, storage: { used: 0, cap: 0 },
      } :
      url.startsWith("/api/me") ? { user: { id: "u1", email: "a@b.c", displayName: "", hasPassword: true } } :
      (overrides[url] ?? {});
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  });
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, calls };
}

const settle = () => new Promise((r) => setTimeout(r, 30));

beforeEach(async () => { await loadLang("en"); document.body.innerHTML = ""; });
afterEach(() => vi.unstubAllGlobals());

async function render() {
  const target = document.createElement("div");
  document.body.appendChild(target);
  const app = mount(MePage, { target });
  await settle();
  return { target, app };
}

describe("MePage 的 CLI 设备列表", () => {
  it("列出 CLI 设备，并把浏览器设备排除在外", async () => {
    stubFetch();
    const { target, app } = await render();
    const text = target.textContent ?? "";
    expect(text).toContain("work-laptop");
    expect(text).toContain("old-vps");
    expect(text, "浏览器设备不该出现在这个列表里").not.toContain("Chrome");
    unmount(app);
  });

  it("从未使用过的设备明确标出来 —— 那种最值得吊销", async () => {
    stubFetch();
    const { target, app } = await render();
    expect(target.textContent).toContain("never used");
    unmount(app);
  });

  it("吊销按钮打到 DELETE /api/devices/<id>，并把该行移除", async () => {
    const { calls } = stubFetch();
    vi.stubGlobal("confirm", () => true); // confirmDialog 走的是应用内弹窗，见下
    const { target, app } = await render();

    const btn = [...target.querySelectorAll("button")].find(
      (b) => b.textContent?.trim() === "Revoke",
    );
    expect(btn, "没有渲染吊销按钮").toBeTruthy();
    btn!.click();
    await settle();

    // 应用内的确认弹窗需要点一下"确认"
    const confirmBtn = [...document.querySelectorAll("button")].find(
      (b) => /confirm/i.test(b.textContent ?? ""),
    );
    confirmBtn?.click();
    await settle();

    const del = calls.find((c) => c.init?.method === "DELETE");
    expect(del, "没有发出删除请求").toBeTruthy();
    expect(del!.url).toBe("/api/devices/d-cli-1");
    expect(target.textContent, "吊销后该行仍在列表里").not.toContain("work-laptop");
    unmount(app);
  });
});

// 这个区块列的是能代表账号行事的令牌，必须只在已登录时出现——放错了地方就成了
// 一个未登录也能看见的空壳（或者更糟，泄漏上一个账号残留的列表）。
it("未登录时不渲染 CLI 设备区块", async () => {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    // /api/me 返回未登录
    if (String(url).startsWith("/api/me/usage")) {
      return new Response(JSON.stringify({ period: "", resetsAt: 0, traffic: { used: 0, cap: 0 }, storage: { used: 0, cap: 0 } }), { status: 200 });
    }
    if (String(url).startsWith("/api/me")) return new Response("unauthorized", { status: 401 });
    return new Response(JSON.stringify({}), { status: 200 });
  }));
  const target = document.createElement("div");
  document.body.appendChild(target);
  const app = mount(MePage, { target });
  await settle();
  expect(target.querySelector(".clidevices"), "未登录也渲染了 CLI 设备区块").toBeNull();
  unmount(app);
});

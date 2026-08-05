import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mount, unmount } from "svelte";
import MePage from "./MePage.svelte";
import ConfirmModal from "./ConfirmModal.svelte";
import { loadLang } from "./i18n.svelte";
import { refreshSession } from "./auth.svelte";

// GET /api/devices 返回的是「账号级、可吊销的持令牌设备」，两类：CLI（relayium
// login）和 App（macOS/iOS 原生登录，走 issueBearer，Kind = "app"）。两类持有的是
// 同一种能代表账号传输/上传的 bearer 令牌，丢设备时都只能在这里自救。界面上却只
// 认 "cli"——于是原生 App 的登录在网页上既看不见也吊销不掉。
//
// 浏览器那一类不在这里：它持的是会话 cookie，不是能拷走的令牌，而且是本机自动
// 登记的。空 Kind 和将来才出现的新 Kind 同样不列——它们的后果这一版说不清楚，
// 与其给一个含义不明的吊销按钮，不如不给。
const DEVICES = {
  devices: [
    // ID 里带空格和斜杠：吊销要走路径拼接，没编码就会打到别的路径上。
    { ID: "d app/1", Name: "Lily's MacBook", CreatedAt: 1_700_200_000, LastSeenAt: 1_700_300_000, Kind: "app" },
    { ID: "d-cli-1", Name: "work-laptop", CreatedAt: 1_700_000_000, LastSeenAt: 1_700_100_000, Kind: "cli" },
    { ID: "d-app-2", Name: "Lily's iPhone", CreatedAt: 1_699_000_000, LastSeenAt: 1_700_050_000, Kind: "app" },
    { ID: "d-cli-2", Name: "old-vps", CreatedAt: 1_690_000_000, LastSeenAt: 0, Kind: "cli" },
    { ID: "d-app-3", Name: "spare iPad", CreatedAt: 1_695_000_000, LastSeenAt: 0, Kind: "app" },
    { ID: "d-browser", Name: "Chrome", CreatedAt: 1_700_000_000, LastSeenAt: 1_700_000_000, Kind: "browser" },
    { ID: "d-empty", Name: "kindless-row", CreatedAt: 1_700_000_000, LastSeenAt: 1_700_000_000, Kind: "" },
    { ID: "d-future", Name: "future-kind-row", CreatedAt: 1_700_000_000, LastSeenAt: 1_700_000_000, Kind: "robot" },
    // 「允许的 Kind」如果是拿对象做查表、再用 `in` 判断，这两个会命中
    // Object.prototype 上的成员而被当成已知类型放行——然后行内标签会渲染成一个
    // 内置函数的字符串。名单必须只认自有键。
    { ID: "d-proto-1", Name: "proto-toString-row", CreatedAt: 1_700_000_000, LastSeenAt: 1_700_000_000, Kind: "toString" },
    { ID: "d-proto-2", Name: "proto-ctor-row", CreatedAt: 1_700_000_000, LastSeenAt: 1_700_000_000, Kind: "constructor" },
  ],
};

const B_DEVICES = {
  devices: [
    // 故意复用 A 的设备 ID：旧账号吊销请求若迟到，按 ID 过滤就会误删这行。
    { ID: "d app/1", Name: "Grace's iPhone", CreatedAt: 1_710_000_000, LastSeenAt: 1_710_100_000, Kind: "app" },
  ],
};

const USER_A = { id: "u1", email: "a@b.c", displayName: "A", hasPassword: true };
const USER_B = { id: "u2", email: "b@c.d", displayName: "B", hasPassword: true };
let currentUser: typeof USER_A | null = USER_A;
let devicesReply: () => Promise<Response>;
let deleteReply: () => Promise<Response>;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

function stubFetch() {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (url.startsWith("/api/devices") && init?.method === "DELETE") return deleteReply();
    if (url.startsWith("/api/devices")) return devicesReply();
    const body =
      url.startsWith("/api/nodes/mine") ? { nodes: [] } :
      url.startsWith("/api/files") ? { files: [] } :
      url.startsWith("/api/stats") ? { transfers: 0, downloads: 0, uploadBytes: 0, downloadBytes: 0, relayBytes: 0 } :
      // QuotaMeters 会自己去拉这个；不给它正确形状的话组件会在渲染里抛异常，
      // 表现为"用例过了但有未处理错误"——那种噪音会掩盖真正的失败。
      url.startsWith("/api/me/usage") ? {
        period: "202607", resetsAt: 0,
        traffic: { used: 0, cap: 0 }, storage: { used: 0, cap: 0 },
      } :
      url.startsWith("/api/me") && currentUser ? { user: currentUser } : {};
    if (url.startsWith("/api/me") && !currentUser) return new Response("unauthorized", { status: 401 });
    return json(body);
  });
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, calls };
}

const settle = () => new Promise((r) => setTimeout(r, 30));

beforeEach(async () => {
  await loadLang("en");
  document.body.innerHTML = "";
  currentUser = USER_A;
  devicesReply = async () => json(DEVICES);
  deleteReply = async () => json({});
  // auth.svelte 的会话跨用例存活；先清掉，避免上一条用例的账号抢跑渲染。
  vi.stubGlobal("fetch", vi.fn(async () => new Response("unauthorized", { status: 401 })));
  await refreshSession();
  vi.unstubAllGlobals();
});
afterEach(() => vi.unstubAllGlobals());

// ConfirmModal lives in App now, not inside MePage — one shared dialog for the
// whole app, because the navigation guard can ask its question from any route.
// These tests mount MePage on its own, so they have to supply it the same way
// App does; otherwise every confirm() here opens a dialog nothing renders.
let confirmDialogHost: ReturnType<typeof mount> | null = null;
function mountSharedDialog(target: HTMLElement) {
  confirmDialogHost = mount(ConfirmModal, { target });
}
afterEach(() => {
  if (confirmDialogHost) { unmount(confirmDialogHost); confirmDialogHost = null; }
});

async function render() {
  const target = document.createElement("div");
  document.body.appendChild(target);
  const app = mount(MePage, { target });
  mountSharedDialog(target);
  mountSharedDialog(target);
  await settle();
  return { target, app };
}

/** 列表里每一行的 [设备名, 类型标签]，顺序即渲染顺序。 */
function rows(target: HTMLElement): [string, string][] {
  return [...target.querySelectorAll(".devicelist li")].map((li) => [
    li.querySelector(".devicename")?.textContent?.trim() ?? "",
    li.querySelector(".devicekind")?.textContent?.trim() ?? "",
  ]);
}

function rowFor(target: HTMLElement, name: string): Element | undefined {
  return [...target.querySelectorAll(".devicelist li")].find(
    (li) => li.querySelector(".devicename")?.textContent?.includes(name),
  );
}

function clickConfirm(pattern: RegExp) {
  const btn = [...document.querySelectorAll('[role="dialog"] button')].find(
    (b) => pattern.test(b.textContent ?? ""),
  ) as HTMLButtonElement | undefined;
  expect(btn, `确认框里没有匹配 ${pattern} 的按钮`).toBeTruthy();
  btn!.click();
}

describe("MePage 的账号设备列表", () => {
  it("同时列出 App 和 CLI 设备", async () => {
    stubFetch();
    const { target, app } = await render();
    const names = rows(target).map(([name]) => name);
    expect(names, "原生 App 的登录没有出现在列表里").toContain("Lily's MacBook");
    expect(names).toContain("Lily's iPhone");
    expect(names).toContain("work-laptop");
    expect(names).toContain("old-vps");
    unmount(app);
  });

  it("浏览器、空 Kind、未知 Kind 都不列", async () => {
    stubFetch();
    const { target, app } = await render();
    const text = target.textContent ?? "";
    expect(text, "浏览器设备不该出现在这个列表里").not.toContain("Chrome");
    expect(text, "Kind 为空的行含义不明，不该给它一个吊销按钮").not.toContain("kindless-row");
    expect(text, "将来才出现的 Kind 这一版说不清楚后果，不该列").not.toContain("future-kind-row");
    expect(text, "Kind = \"toString\" 蹭到了 Object.prototype 上，被当成已知类型放行").not.toContain("proto-toString-row");
    expect(text, "Kind = \"constructor\" 蹭到了 Object.prototype 上，被当成已知类型放行").not.toContain("proto-ctor-row");
    unmount(app);
  });

  it("每一行都标出自己是 App 还是 CLI", async () => {
    stubFetch();
    const { target, app } = await render();
    const byName = new Map(rows(target));
    // 两类持有的是同一种全权令牌，用户要能一眼看出这一行是哪台设备的哪种登录。
    expect(byName.get("Lily's MacBook")).toBe("App");
    expect(byName.get("Lily's iPhone")).toBe("App");
    expect(byName.get("work-laptop")).toBe("CLI");
    expect(byName.get("old-vps")).toBe("CLI");
    unmount(app);
  });

  it("按最后使用时间倒序、其次按创建时间倒序 —— 跨类型统一排", async () => {
    stubFetch();
    const { target, app } = await render();
    // 混排是关键：加入 App 之后如果分组显示或者按类型稳定排序，"最近用过的排在
    // 最上面"这个唯一的排序承诺就不成立了。
    expect(rows(target).map(([name]) => name)).toEqual([
      "Lily's MacBook", // 最后使用最新
      "work-laptop",
      "Lily's iPhone",
      "spare iPad",     // 从未使用，创建更晚
      "old-vps",        // 从未使用，创建最早
    ]);
    unmount(app);
  });

  it("从未使用过的设备明确标出来 —— 那种最值得吊销", async () => {
    stubFetch();
    const { target, app } = await render();
    expect(target.textContent).toContain("never used");
    unmount(app);
  });

  it("吊销 App 设备：ID 经过 URL 编码，且只有那一行消失", async () => {
    const { calls } = stubFetch();
    const { target, app } = await render();

    const btn = rowFor(target, "MacBook")?.querySelector("button.del") as HTMLButtonElement | undefined;
    expect(btn, "App 那一行没有吊销按钮").toBeTruthy();
    btn!.click();
    await settle();
    clickConfirm(/confirm/i); // 应用内的确认弹窗
    await settle();

    const deletes = calls.filter((c) => c.init?.method === "DELETE");
    expect(deletes, "没有发出删除请求").toHaveLength(1);
    // 没编码的话 "d app/1" 会把请求打到 /api/devices/d app/1 —— 另一个路径。
    expect(deletes[0].url).toBe("/api/devices/d%20app%2F1");

    const names = rows(target).map(([name]) => name);
    expect(names, "吊销后该行仍在列表里").not.toContain("Lily's MacBook");
    // 只删掉点中的那一行：其余四行——包括另外两台 App——必须原样留着。
    expect(names).toEqual(["work-laptop", "Lily's iPhone", "spare iPad", "old-vps"]);
    unmount(app);
  });

  it("吊销 CLI 设备仍然走同一条 DELETE 路径", async () => {
    const { calls } = stubFetch();
    const { target, app } = await render();

    (rowFor(target, "work-laptop")!.querySelector("button.del") as HTMLButtonElement).click();
    await settle();
    clickConfirm(/confirm/i);
    await settle();

    expect(calls.find((c) => c.init?.method === "DELETE")!.url).toBe("/api/devices/d-cli-1");
    expect(rows(target).map(([name]) => name)).not.toContain("work-laptop");
    unmount(app);
  });

  it("取消确认框不发任何删除请求", async () => {
    const { calls } = stubFetch();
    const { target, app } = await render();
    (target.querySelector(".devicelist li button.del") as HTMLButtonElement).click();
    await settle();
    clickConfirm(/cancel/i);
    await settle();
    expect(calls.some((c) => c.init?.method === "DELETE"), "取消之后仍然发了删除请求").toBe(false);
    expect(rows(target)).toHaveLength(5);
    unmount(app);
  });

  it("每个吊销按钮都有指名道姓的可访问名称", async () => {
    stubFetch();
    const { target, app } = await render();
    // 五个按钮的可见文字都是 "Revoke"：读屏用户在按钮列表里听到的必须是五个不同
    // 的名字，否则无从判断自己正在吊销哪一台。
    const labels = [...target.querySelectorAll(".devicelist li button.del")].map(
      (b) => b.getAttribute("aria-label") ?? "",
    );
    expect(labels).toHaveLength(5);
    expect(new Set(labels).size, "吊销按钮的可访问名称互相重复").toBe(5);
    expect(labels[0]).toContain("Lily's MacBook");
    unmount(app);
  });

  it("同名的 App 与 CLI 登录仍有不同的可访问名称", async () => {
    devicesReply = async () => json({
      devices: [
        { ID: "same-app", Name: "shared-name", CreatedAt: 2, LastSeenAt: 2, Kind: "app" },
        { ID: "same-cli", Name: "shared-name", CreatedAt: 1, LastSeenAt: 1, Kind: "cli" },
      ],
    });
    stubFetch();
    const { target, app } = await render();

    const labels = [...target.querySelectorAll(".devicelist button.del")].map(
      (button) => button.getAttribute("aria-label") ?? "",
    );
    expect(labels).toHaveLength(2);
    expect(labels.every((label) => label.includes("shared-name"))).toBe(true);
    expect(labels.some((label) => label.includes("App"))).toBe(true);
    expect(labels.some((label) => label.includes("CLI"))).toBe(true);
    expect(new Set(labels).size, "同名 App/CLI 的吊销按钮仍无法区分").toBe(2);
    unmount(app);
  });

  it("确认框指名要吊销哪一台，且不把每一份凭据都说成 CLI 令牌", async () => {
    stubFetch();
    const { target, app } = await render();
    (target.querySelector(".devicelist li button.del") as HTMLButtonElement).click();
    await settle();

    const msg = document.querySelector('[role="dialog"]')?.textContent ?? "";
    expect(msg, "确认框没说要吊销的是哪一台").toContain("Lily's MacBook");
    expect(msg, "把 App 的登录凭据说成了 CLI 令牌").not.toMatch(/CLI/i);
    unmount(app);
  });

  it("切换账号会立即清掉旧设备，不等新账号的列表返回", async () => {
    const second = deferred<Response>();
    let requestCount = 0;
    devicesReply = async () => (++requestCount === 1 ? json(DEVICES) : second.promise);
    stubFetch();
    const { target, app } = await render();
    expect(target.textContent).toContain("Lily's MacBook");

    currentUser = USER_B;
    await refreshSession();
    await settle();
    expect(target.textContent, "新账号等待自己的列表时仍显示旧账号设备").not.toContain("Lily's MacBook");
    expect(rows(target), "新账号请求未返回时应该是空列表").toHaveLength(0);

    second.resolve(json(B_DEVICES));
    await settle();
    expect(target.textContent).toContain("Grace's iPhone");
    unmount(app);
  });

  it("旧账号的迟到列表响应不会覆盖新账号设备", async () => {
    const first = deferred<Response>();
    let requestCount = 0;
    devicesReply = async () => (++requestCount === 1 ? first.promise : json(B_DEVICES));
    stubFetch();
    const { target, app } = await render();

    currentUser = USER_B;
    await refreshSession();
    await settle();
    expect(target.textContent).toContain("Grace's iPhone");

    first.resolve(json(DEVICES));
    await settle();
    expect(target.textContent, "旧账号的迟到响应覆盖了新账号列表").toContain("Grace's iPhone");
    expect(target.textContent).not.toContain("Lily's MacBook");
    unmount(app);
  });

  it("旧账号的迟到吊销响应不会删掉新账号同 ID 的设备", async () => {
    const deletion = deferred<Response>();
    deleteReply = () => deletion.promise;
    stubFetch();
    const { target, app } = await render();

    (rowFor(target, "MacBook")!.querySelector("button.del") as HTMLButtonElement).click();
    await settle();
    clickConfirm(/confirm/i);
    await settle();

    devicesReply = async () => json(B_DEVICES);
    currentUser = USER_B;
    await refreshSession();
    await settle();
    expect(target.textContent).toContain("Grace's iPhone");

    deletion.resolve(json({}));
    await settle();
    expect(target.textContent, "旧账号的吊销响应删掉了新账号同 ID 的设备").toContain("Grace's iPhone");
    unmount(app);
  });

  it("吊销失败会保留设备行并显示可重试错误", async () => {
    deleteReply = async () => json({ error: "failed" }, 500);
    stubFetch();
    const { target, app } = await render();

    (rowFor(target, "MacBook")!.querySelector("button.del") as HTMLButtonElement).click();
    await settle();
    clickConfirm(/confirm/i);
    await settle();

    expect(target.textContent, "失败后设备行被错误移除").toContain("Lily's MacBook");
    expect(target.querySelector(".action-err")?.textContent).toContain("Something went wrong");
    unmount(app);
  });
});

// 这个区块列的是能代表账号行事的令牌，必须只在已登录时出现——放错了地方就成了
// 一个未登录也能看见的空壳（或者更糟，泄漏上一个账号残留的列表）。
it("未登录时不渲染账号设备区块", async () => {
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
  mountSharedDialog(target);
  mountSharedDialog(target);
  await settle();
  expect(target.querySelector(".accountdevices"), "未登录也渲染了账号设备区块").toBeNull();
  unmount(app);
});

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mount, unmount } from "svelte";
import MagicLink from "./MagicLink.svelte";
import { loadLang } from "./i18n.svelte";

// 这一页存在的唯一理由是**它需要一次点击**。邮件网关（Proofpoint / Mimecast /
// Defender Safe Links）会在投递前预取邮件里的链接；只要令牌是被"打开页面"消费掉的，
// 用户点开时就会看到"链接已过期"，而那张 30 天的会话 cookie 已经发给扫描器了。
// 所以下面第一条用例守的是「挂载不能自动登录」——那是最容易在后续改动里被"优化"掉的
// 一步（"让用户少点一次"）。
beforeEach(async () => {
  await loadLang("en");
  history.replaceState(null, "", "/magic-link?token=tok-123");
  document.body.innerHTML = "";
});
afterEach(() => vi.unstubAllGlobals());

function render() {
  const target = document.createElement("div");
  document.body.appendChild(target);
  const app = mount(MagicLink, { target });
  return { target, app };
}

const clickSignIn = async (target: HTMLElement) => {
  const btn = [...target.querySelectorAll("button")].find((b) => /sign in/i.test(b.textContent ?? ""));
  btn?.click();
  await new Promise((r) => setTimeout(r, 0));
};

describe("MagicLink 页面", () => {
  it("挂载时不发任何请求 —— 自动提交会把防线搬回被预取的那一步", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { app } = render();
    await new Promise((r) => setTimeout(r, 20));
    expect(fetchMock, "页面一加载就消费了令牌").not.toHaveBeenCalled();
    unmount(app);
  });

  it("把令牌从 URL 里抹掉（否则它会进历史记录、并经 Referer 漏出去）", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const { app } = render();
    await new Promise((r) => setTimeout(r, 0));
    expect(location.search).toBe("");
    unmount(app);
  });

  it("点击之后才 POST 令牌", async () => {
    const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
      if (url === "/api/auth/magic/verify") return new Response(JSON.stringify({ status: "ok" }), { status: 200 });
      return new Response(JSON.stringify({ user: { id: "u", email: "a@b.c" } }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const { target, app } = render();
    await new Promise((r) => setTimeout(r, 0));
    await clickSignIn(target);

    const call = fetchMock.mock.calls.find((c) => c[0] === "/api/auth/magic/verify");
    expect(call, "点击没有触发验证请求").toBeTruthy();
    const init = call![1]!;
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ token: "tok-123" });
    unmount(app);
  });

  it("令牌无效时给出可读的过期提示，而不是静默失败", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({ error: "invalid_or_expired_token" }), { status: 400 })));
    const { target, app } = render();
    await new Promise((r) => setTimeout(r, 0));
    await clickSignIn(target);
    expect(target.textContent).toMatch(/invalid or has expired/i);
    unmount(app);
  });

  it("没有令牌时不渲染登录按钮", async () => {
    history.replaceState(null, "", "/magic-link");
    vi.stubGlobal("fetch", vi.fn());
    const { target, app } = render();
    await new Promise((r) => setTimeout(r, 0));
    expect([...target.querySelectorAll("button")].some((b) => /^sign in$/i.test(b.textContent?.trim() ?? ""))).toBe(false);
    expect(target.textContent).toMatch(/only reachable from a sign-in link/i);
    unmount(app);
  });
});

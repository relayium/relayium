// 个人中心的注销账户入口。
//
// 服务端的双重确认流程早就完整了（POST /api/account/delete/request 只发一封确认邮件，
// 所有破坏性动作都发生在邮件里的链接被打开之后），隐私政策也已经白纸黑字写着「可以在
// 账户设置里删除账户，App 或网页端都行」——但网页上一直没有这个按钮，只有原生 App 有。
// 这几条用例守的就是这个入口本身，以及它最容易说谎的三个地方：
//
//  1. 按下去只发一封邮件，所以成功文案不能读成「已删除／已发送／已排期」；
//  2. 它不登出、也不动页面上的任何数据——账号还得能用，用户可能正要用它改主意；
//  3. 在途的响应必须绑定在发起它的那段会话上，否则登出或换账号之后，一条关于别人
//     账号的提示会画到当前页面上。
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mount, unmount } from "svelte";
import MePage from "./MePage.svelte";
import { loadLang } from "./i18n.svelte";
import { session, refreshSession } from "./auth.svelte";

const DELETE_PATH = "/api/account/delete/request";

const USER_A = { id: "u1", email: "ada@example.com", displayName: "Ada", hasPassword: true };
const USER_B = { id: "u2", email: "grace@example.com", displayName: "Grace", hasPassword: true };

/** 当前 /api/me 应该回的用户；null = 未登录（401）。 */
let currentUser: Record<string, unknown> | null = USER_A;
/** 注销请求的应答。默认立刻 200，需要卡住在途状态的用例换成自己的 deferred。 */
let deleteReply: () => Promise<Response> = async () => json({ status: "sent" });

let calls: { url: string; init?: RequestInit }[] = [];

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
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (url === DELETE_PATH) return deleteReply();
      if (url.startsWith("/api/nodes/mine")) return json({ nodes: [] });
      if (url.startsWith("/api/devices")) return json({ devices: [] });
      if (url.startsWith("/api/files")) return json({ files: [] });
      if (url.startsWith("/api/stats")) {
        return json({ transfers: 0, downloads: 0, uploadBytes: 0, downloadBytes: 0, relayBytes: 0 });
      }
      // QuotaMeters 自己会拉这个；形状不对会在渲染里抛，表现为「用例过了但有未处理错误」。
      if (url.startsWith("/api/me/usage")) {
        return json({ period: "202608", resetsAt: 0, traffic: { used: 0, cap: 0 }, storage: { used: 0, cap: 0 } });
      }
      if (url.startsWith("/api/me")) {
        return currentUser ? json({ user: currentUser }) : new Response("unauthorized", { status: 401 });
      }
      return json({});
    }),
  );
}

const settle = () => new Promise((r) => setTimeout(r, 30));

let app: unknown;
let target: HTMLDivElement;

beforeEach(async () => {
  await loadLang("en");
  document.body.innerHTML = "";
  currentUser = USER_A;
  deleteReply = async () => json({ status: "sent" });
  // 会话是模块级 rune，跨用例存活。每个用例都从「未登录」起步，免得上一个用例的
  // 账号在 onMount 的 refreshSession 落地之前先渲染出一版别人的页面。
  vi.stubGlobal("fetch", vi.fn(async () => new Response("unauthorized", { status: 401 })));
  await refreshSession();
  vi.unstubAllGlobals();
  stubFetch();
});

afterEach(() => {
  if (app) unmount(app as never);
  app = undefined;
  target?.remove();
  vi.unstubAllGlobals();
});

async function render() {
  target = document.createElement("div");
  document.body.appendChild(target);
  app = mount(MePage, { target });
  await settle();
  return target;
}

function byText(label: string): HTMLButtonElement | undefined {
  return [...target.querySelectorAll("button")].find((b) => b.textContent?.trim() === label);
}

function deleteButton(): HTMLButtonElement | undefined {
  return target.querySelector<HTMLButtonElement>(".danger-zone .danger-btn") ?? undefined;
}

function statusText(): string {
  return target.querySelector(".del-status")?.textContent?.trim() ?? "";
}

function deleteCalls() {
  return calls.filter((c) => c.url === DELETE_PATH);
}

/** 点开注销确认弹窗。返回后弹窗已经在 DOM 里。 */
async function openConfirm() {
  deleteButton()!.click();
  await settle();
}

describe("MePage 的注销账户入口", () => {
  it("已登录时渲染出来，并说清楚邮件会发到哪个地址", async () => {
    await render();
    const zone = target.querySelector(".danger-zone");
    expect(zone, "个人中心里找不到注销区块").toBeTruthy();
    expect(zone!.textContent).toContain("Delete account");
    expect(zone!.textContent, "没告诉用户确认邮件会发到哪里").toContain("ada@example.com");
    expect(deleteButton(), "没有可见的注销按钮").toBeTruthy();
    // 承诺「打开链接之前什么都不会删」的那句话，在按下之前就得读得到。
    expect(zone!.textContent).toContain("Nothing is removed until that link is opened");
  });

  it("未登录时整个区块都不渲染", async () => {
    currentUser = null;
    await render();
    expect(target.querySelector(".danger-zone"), "未登录也渲染了注销区块").toBeNull();
    expect(target.querySelector(".danger-btn")).toBeNull();
  });

  it("走的是应用内确认弹窗，不是 window.confirm", async () => {
    const nativeConfirm = vi.fn(() => true);
    vi.stubGlobal("confirm", nativeConfirm);
    await render();
    await openConfirm();
    expect(nativeConfirm, "用了 window.confirm——那玩意儿不可定制、不可翻译、也不可访问").not.toHaveBeenCalled();
    const dialog = target.querySelector("[role='dialog']");
    expect(dialog, "没有打开应用内确认弹窗").toBeTruthy();
    // 弹窗的可访问名就是它在问的那句话，后果必须写在里面。
    const said = dialog!.textContent ?? "";
    expect(said).toContain("Nothing is removed until that link is opened");
    expect(said).toContain("30-day grace period");
    expect(said).toContain("sign in again");
    // 肯定按钮说的是它真正会做的事：发一封邮件。
    expect(byText("Send the confirmation email"), "确认按钮没说自己会做什么").toBeTruthy();
  });

  it("取消确认时一个请求都不发", async () => {
    await render();
    await openConfirm();
    byText("Cancel")!.click();
    await settle();
    expect(deleteCalls(), "取消之后仍然发出了注销请求").toHaveLength(0);
    expect(statusText(), "取消不该留下任何提示").toBe("");
    expect(target.querySelector("[role='dialog']")).toBeNull();
  });

  it("弹窗打开时切换账号会取消并清掉旧账号信息", async () => {
    await render();
    await openConfirm();
    expect(target.querySelector("[role='dialog']")?.textContent).toContain("ada@example.com");

    currentUser = USER_B;
    await refreshSession();
    await settle();

    expect(target.querySelector("[role='dialog']"), "切换账号后旧账号的确认弹窗仍然可见").toBeNull();
    expect(target.textContent, "切换账号后页面仍泄露旧账号邮箱").not.toContain("ada@example.com");
    expect(target.querySelector(".danger-zone")?.textContent).toContain("grace@example.com");
    expect(deleteCalls(), "切换账号时意外发出了删除请求").toHaveLength(0);
  });

  it("确认后只发一条 POST /api/account/delete/request，且带上 cookie", async () => {
    await render();
    await openConfirm();
    byText("Send the confirmation email")!.click();
    await settle();

    const sent = deleteCalls();
    expect(sent).toHaveLength(1);
    expect(sent[0].init?.method).toBe("POST");
    expect(sent[0].init?.credentials).toBe("include");
  });

  it("请求在途时按钮停用，而且即便绕过 disabled 也不会发第二条", async () => {
    const gate = deferred<Response>();
    deleteReply = () => gate.promise;
    await render();
    await openConfirm();
    byText("Send the confirmation email")!.click();
    await settle();

    const btn = deleteButton()!;
    expect(btn.disabled, "请求在途时按钮仍可点").toBe(true);
    expect(btn.textContent?.trim()).toBe("Asking for the confirmation email…");
    // disabled 只是第一道闸。把它摘掉再点一次，验的是组件自己也拒绝并发请求——
    // 端点按账号节流，第二条请求什么也换不来，只会把一次成功变成被吞掉的一次。
    btn.removeAttribute("disabled");
    btn.click();
    await settle();
    expect(deleteCalls(), "同一时刻发出了两条注销请求").toHaveLength(1);

    gate.resolve(json({ status: "sent" }));
    await settle();
    expect(deleteButton()!.disabled, "结束后按钮没恢复").toBe(false);
  });

  it("成功只说『已请求』，不说已发送／已删除／已排期", async () => {
    await render();
    await openConfirm();
    byText("Send the confirmation email")!.click();
    await settle();

    const said = statusText();
    expect(said).toContain("Requested.");
    expect(said).toContain("Nothing is removed until that link is opened");
    // 端点无论真发了邮件、被节流吞掉还是发信失败都回同一个 200，所以这几个词一个都
    // 不能出现——它们声称的是这个界面观察不到的事。
    expect(said, "声称邮件已经发出去了").not.toMatch(/\bsent\b/i);
    expect(said, "声称账号已经被删了").not.toMatch(/\bdeleted\b/i);
    expect(said, "声称删除已经排期了").not.toMatch(/\bscheduled\b/i);
    expect(said, "声称流程已经走完了").not.toMatch(/\bcomplete/i);
  });

  it("成功之后用户仍然登录着，页面数据也还在", async () => {
    await render();
    await openConfirm();
    byText("Send the confirmation email")!.click();
    await settle();

    expect(session().user?.id, "请求把用户登出了——什么都还没删，这个会话正是他改主意要用的").toBe("u1");
    expect(calls.some((c) => c.url.includes("/api/auth/logout")), "发了登出请求").toBe(false);
    expect(target.querySelector(".danger-zone"), "注销区块自己消失了").toBeTruthy();
    expect(target.querySelector(".files"), "页面数据被清掉了").toBeTruthy();
    expect(target.querySelector(".clidevices")).toBeTruthy();
  });

  it("失败是明确的，而且可以再试一次", async () => {
    deleteReply = async () => json({ error: "server error" }, 500);
    await render();
    await openConfirm();
    byText("Send the confirmation email")!.click();
    await settle();

    const said = statusText();
    expect(said, "请求失败了却什么都没说").not.toBe("");
    expect(said).toContain("Couldn't ask for the confirmation email");
    expect(said, "失败文案没有说清楚什么都没被删").toContain("Nothing has been deleted");
    expect(deleteButton()!.disabled, "失败后按钮卡在停用状态，用户没法重试").toBe(false);

    // 重新打开再取消，什么都不该动：那句失败说的是上一次请求的事实，取消没有推翻它。
    await openConfirm();
    byText("Cancel")!.click();
    await settle();
    expect(deleteCalls(), "取消却发出了请求").toHaveLength(1);
    expect(statusText(), "取消把上一次的失败结论抹掉了").toContain("Couldn't ask for the confirmation email");

    // 真的能重试：再走一遍就是第二条请求。
    deleteReply = async () => json({ status: "sent" });
    await openConfirm();
    byText("Send the confirmation email")!.click();
    await settle();
    expect(deleteCalls()).toHaveLength(2);
    expect(statusText()).toContain("Requested.");
  });

  it("网络层直接失败（fetch 抛）也给出可重试的失败，而不是静默", async () => {
    deleteReply = async () => { throw new Error("offline"); };
    await render();
    await openConfirm();
    byText("Send the confirmation email")!.click();
    await settle();
    expect(statusText()).toContain("Couldn't ask for the confirmation email");
    expect(deleteButton()!.disabled).toBe(false);
  });
});

// 在途请求必须绑定在发起它的那段会话上。这两条是对抗性的：把 MePage 里那句
// `if (!deleteStillCurrent(gen)) return;` 删掉，两条都会红。
describe("迟到的注销响应不会画到别人的页面上", () => {
  it("登出再登回同一个账号之后，上一段会话的响应不再作数", async () => {
    const gate = deferred<Response>();
    deleteReply = () => gate.promise;
    await render();
    await openConfirm();
    byText("Send the confirmation email")!.click();
    await settle();
    expect(deleteCalls()).toHaveLength(1);

    // 登出……
    currentUser = null;
    await refreshSession();
    await settle();
    expect(target.querySelector(".danger-zone")).toBeNull();

    // ……再用同一个账号登回来。到这里 uid 又对上了，只有「代号」还能证明那条响应
    // 属于上一段会话。
    currentUser = USER_A;
    await refreshSession();
    await settle();
    expect(target.querySelector(".danger-zone"), "重新登录后注销区块没回来").toBeTruthy();
    expect(statusText(), "跨越登出的提示残留到了新会话").toBe("");

    // 现在那条请求才回来。
    gate.resolve(json({ status: "sent" }));
    await settle();
    expect(statusText(), "上一段会话的结果画到了新会话的页面上").toBe("");
    expect(target.textContent).not.toContain("Requested.");
  });

  it("在途时换成另一个账号，结果不会画到新账号的页面上", async () => {
    const gate = deferred<Response>();
    deleteReply = () => gate.promise;
    await render();
    await openConfirm();
    byText("Send the confirmation email")!.click();
    await settle();

    // 同一个标签页里换了个账号（另一个窗口登录 / 会话被顶掉后重新登录）。
    currentUser = USER_B;
    await refreshSession();
    await settle();
    expect(target.querySelector(".danger-zone")!.textContent).toContain("grace@example.com");

    gate.resolve(json({ status: "sent" }));
    await settle();
    expect(statusText(), "一个账号的注销请求结果画到了另一个账号的页面上").toBe("");
    expect(target.textContent).not.toContain("Requested.");
  });
});

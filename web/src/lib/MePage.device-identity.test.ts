// 一行设备必须**认得出来**（DECISION-LOG 2026-08-04）。
//
// 上线时的样子是：三台服务器 = 三行一模一样的 `CLI / CLI / 从未使用 / 吊销`。用户
// 面对的是一个不可撤销的按钮和四个完全相同的标签，没有任何办法判断按下去会断掉
// 哪一台。这里断言的就是让它们能被区分的那几样东西：标签、类型、ID 短后缀、登录
// 时间，以及行内改名。
//
// 还有一条同等重要的反向断言：**不能**多说。完整设备 ID、令牌、来源 IP、命令历史
// 都不许出现在这个列表里。
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mount, unmount } from "svelte";
import MePage from "./MePage.svelte";
import ConfirmModal from "./ConfirmModal.svelte";
import { loadLang } from "./i18n.svelte";
import { refreshSession } from "./auth.svelte";
import { deviceSuffix, normalizeDeviceName, DEVICE_NAME_MAX } from "./device-identity";
import { CAP_RECEIVE_V2, INBOX_KEY_ALGORITHM } from "./device-inbox";

const USER = { id: "u1", email: "a@b.c", displayName: "A", hasPassword: true };

// 两台同名设备：改名之前它们本来就都叫 "CLI"。ID 长得很像，只有尾部不同——所以
// 「短后缀取的是**尾部**」这件事必须是真的，取头部的话这两行照样无法区分。
const SAME_NAME = {
  devices: [
    { ID: "0123456789abcdef0123456789aaa111", Name: "CLI", CreatedAt: 1_700_000_000, LastSeenAt: 0, Kind: "cli" },
    { ID: "0123456789abcdef0123456789bbb222", Name: "CLI", CreatedAt: 1_690_000_000, LastSeenAt: 0, Kind: "cli" },
  ],
};

let devicesReply: () => Promise<Response>;
let patchReply: () => Promise<Response>;
let deleteReply: () => Promise<Response>;
let signedIn = true;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

// 每条用例都装桩，而不是"需要的时候再装"：MePage 的 onMount 会自己去拉一次会话，
// 没装桩的那条用例会用真的 fetch 去请求相对路径，报的错还落在下一条用例头上。
let calls: { url: string; init?: RequestInit }[] = [];

function stubFetch() {
  calls = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const u = String(url);
    if (u.startsWith("/api/devices") && init?.method === "PATCH") return patchReply();
    if (u.startsWith("/api/devices") && init?.method === "DELETE") return deleteReply();
    if (u.startsWith("/api/devices")) return devicesReply();
    if (u.startsWith("/api/nodes/mine")) return json({ nodes: [] });
    if (u.startsWith("/api/files")) return json({ files: [] });
    if (u.startsWith("/api/stats")) return json({ transfers: 0, downloads: 0, uploadBytes: 0, downloadBytes: 0, relayBytes: 0 });
    if (u.startsWith("/api/me/usage")) {
      return json({ period: "202608", resetsAt: 0, traffic: { used: 0, cap: 0 }, storage: { used: 0, cap: 0 } });
    }
    if (u.startsWith("/api/me")) {
      return signedIn ? json({ user: USER }) : new Response("unauthorized", { status: 401 });
    }
    return json({});
  }));
}

const settle = () => new Promise((r) => setTimeout(r, 30));

let mounted: ReturnType<typeof mount>[] = [];

async function render() {
  const target = document.createElement("div");
  document.body.appendChild(target);
  // 每次都记下来统一卸载：断言失败会跳过测试体里剩下的语句，靠尾部的 unmount()
  // 收尾的话，一个失败就会把一个还挂着的 MePage 留给下一条用例——它的会话 effect
  // 和 presence 定时器会去抢下一条用例 stub 的那个响应，于是失败会传染。
  mounted.push(mount(MePage, { target }));
  mounted.push(mount(ConfirmModal, { target }));
  await settle();
  return target;
}

beforeEach(async () => {
  await loadLang("en");
  document.body.innerHTML = "";
  signedIn = true;
  devicesReply = async () => json(SAME_NAME);
  patchReply = async () => json({ status: "ok" });
  deleteReply = async () => json({ status: "ok" });
  vi.stubGlobal("fetch", vi.fn(async () => new Response("unauthorized", { status: 401 })));
  await refreshSession();
  vi.unstubAllGlobals();
  stubFetch();
});

afterEach(() => {
  for (const app of mounted) unmount(app);
  mounted = [];
  vi.unstubAllGlobals();
});

function rows(target: HTMLElement): HTMLElement[] {
  return [...target.querySelectorAll<HTMLElement>(".devicelist li")];
}

describe("deviceSuffix", () => {
  it("取的是尾部，而且两个只有尾部不同的 ID 会得到不同的后缀", () => {
    const a = deviceSuffix(SAME_NAME.devices[0].ID);
    const b = deviceSuffix(SAME_NAME.devices[1].ID);
    expect(a).toBe("aaa111");
    expect(b).toBe("bbb222");
    expect(a, "两个 ID 的后缀撞了，等于没区分").not.toBe(b);
  });

  it("永远只是完整 ID 的一小截", () => {
    const id = SAME_NAME.devices[0].ID;
    const suffix = deviceSuffix(id);
    expect(suffix.length).toBeLessThan(id.length);
    expect(id.endsWith(suffix)).toBe(true);
  });

  it("大小写原样保留 —— 归一化会把只差大小写的两个 ID 合成同一个后缀", () => {
    expect(deviceSuffix("00000000000000000000000000aAbBcC")).toBe("aAbBcC");
    expect(deviceSuffix("00000000000000000000000000aabbcc")).not.toBe(
      deviceSuffix("00000000000000000000000000aAbBcC"),
    );
  });

  it("ID 里带空格和斜杠也能切出干净的后缀", () => {
    // 这种 ID 会被塞进 URL 路径，也会被渲染成文字。切出来的东西不该带着分隔符，
    // 那会看起来像结构而其实不是。
    expect(deviceSuffix("d app/1")).toBe("dapp1");
    expect(deviceSuffix("../../etc/passwd")).toBe("passwd");
  });

  it("短到切不出东西时返回空串，由调用方决定不渲染", () => {
    expect(deviceSuffix("")).toBe("");
    expect(deviceSuffix("/")).toBe("");
    expect(deviceSuffix("a")).toBe("");
    expect(deviceSuffix("ab")).toBe("ab");
  });
});

describe("normalizeDeviceName", () => {
  it("只做空白归一化 —— Unicode 规则由服务端一处说了算", () => {
    expect(normalizeDeviceName("  prod   backup  ")).toBe("prod backup");
    expect(normalizeDeviceName("prod\nbackup")).toBe("prod backup");
    expect(normalizeDeviceName("   ")).toBe("");
    // 方向覆盖**不**在浏览器里处理：在这儿再写一遍规则就是第二份定义，两份定义
    // 迟早会漂移，而漂移的后果是界面收下了服务端会拒绝的名字。
    expect(normalizeDeviceName("prod‮kcab")).toBe("prod‮kcab");
  });

  it("输入框的长度上限和服务端的一致", () => {
    expect(DEVICE_NAME_MAX).toBe(64);
  });
});

describe("同名两行的可区分性", () => {
  it("每一行都带类型、ID 尾号、登录时间和自登录以来的使用状态", async () => {
    const target = await render();
    const [first, second] = rows(target);
    expect(first.querySelector(".devicekind")?.textContent).toBe("CLI");
    expect(first.querySelector(".deviceref")?.textContent).toContain("aaa111");
    expect(second.querySelector(".deviceref")?.textContent).toContain("bbb222");
    for (const row of [first, second]) {
      expect(row.querySelector(".devicesigned")?.textContent).toMatch(/Signed in/);
      expect(row.querySelector(".deviceseen")?.textContent).toBe("Not used since sign-in");
    }
  });

  it("两个吊销按钮的可访问名称互不相同，且四样齐全", async () => {
    const target = await render();
    const labels = rows(target).map((r) => r.querySelector("button.del")?.getAttribute("aria-label") ?? "");
    expect(labels).toHaveLength(2);
    expect(new Set(labels).size, "同名两行的吊销按钮听起来一模一样").toBe(2);
    for (const label of labels) {
      expect(label).toContain("CLI"); // 标签和类型在这一行里恰好同字，两者都在
      expect(label).toMatch(/Signed in/);
    }
    expect(labels[0]).toContain("aaa111");
    expect(labels[1]).toContain("bbb222");
  });

  it("确认框里也带着这四样", async () => {
    const target = await render();
    (rows(target)[1].querySelector("button.del") as HTMLButtonElement).click();
    await settle();
    const msg = document.querySelector('[role="dialog"]')?.textContent ?? "";
    expect(msg).toContain("bbb222");
    expect(msg).toMatch(/Signed in/);
    expect(msg, "确认框指向的是另一行").not.toContain("aaa111");
  });

  it("同名两行里吊销一行，只删掉被点中的那个完整 ID", async () => {
    const target = await render();
    (rows(target)[1].querySelector("button.del") as HTMLButtonElement).click();
    await settle();
    (
      [...document.querySelectorAll('[role="dialog"] button')].find((b) =>
        /confirm/i.test(b.textContent ?? ""),
      ) as HTMLButtonElement
    ).click();
    await settle();

    const deletes = calls.filter((c) => c.init?.method === "DELETE");
    expect(deletes).toHaveLength(1);
    // 完整 ID，不是后缀：真正决定删哪一行的始终是 ID，不是那几个用来"看"的字段。
    expect(deletes[0].url).toBe(`/api/devices/${SAME_NAME.devices[1].ID}`);
    const left = rows(target).map((r) => r.querySelector(".deviceref")?.textContent ?? "");
    expect(left).toHaveLength(1);
    expect(left[0], "删错了行").toContain("aaa111");
  });

  it("列表里不出现完整 ID、令牌或来源 IP", async () => {
    const target = await render();
    const text = target.textContent ?? "";
    const html = target.innerHTML;
    for (const d of SAME_NAME.devices) {
      expect(text, "完整设备 ID 被渲染出来了").not.toContain(d.ID);
    }
    // aria-label / title 之类的属性也算暴露。
    expect(html).not.toContain(SAME_NAME.devices[0].ID);
    expect(html).not.toContain(SAME_NAME.devices[1].ID);
    expect(text).not.toMatch(/rlm_cli_/);
    expect(text, "列表里出现了 IP 地址").not.toMatch(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/);
  });

  it("带空格和斜杠的 ID 在吊销时被正确编码", async () => {
    devicesReply = async () => json({
      devices: [{ ID: "d app/1", Name: "odd", CreatedAt: 1, LastSeenAt: 0, Kind: "cli" }],
    });
    const target = await render();
    (rows(target)[0].querySelector("button.del") as HTMLButtonElement).click();
    await settle();
    (
      [...document.querySelectorAll('[role="dialog"] button')].find((b) =>
        /confirm/i.test(b.textContent ?? ""),
      ) as HTMLButtonElement
    ).click();
    await settle();
    expect(calls.find((c) => c.init?.method === "DELETE")?.url).toBe("/api/devices/d%20app%2F1");
  });
});

describe("行内改名", () => {
  async function openEditor(target: HTMLElement, index = 0) {
    const row = rows(target)[index];
    const btn = [...row.querySelectorAll("button")].find((b) =>
      /rename/i.test(b.getAttribute("aria-label") ?? ""),
    ) as HTMLButtonElement | undefined;
    expect(btn, "这一行没有改名按钮").toBeTruthy();
    btn!.click();
    await settle();
    return row.querySelector(".renameinput") as HTMLInputElement;
  }

  function save(row: HTMLElement) {
    (row.querySelector(".renameform") as HTMLFormElement).requestSubmit();
  }

  it("PATCH 到那一行的完整 ID，成功后行内立刻显示新名字", async () => {
    const target = await render();
    const input = await openEditor(target, 1);
    input.value = "prod-backup-1";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    save(rows(target)[1]);
    await settle();

    const patch = calls.find((c) => c.init?.method === "PATCH");
    expect(patch?.url).toBe(`/api/devices/${SAME_NAME.devices[1].ID}`);
    expect(JSON.parse(String(patch?.init?.body))).toEqual({ name: "prod-backup-1" });
    expect(rows(target)[1].querySelector(".devicename")?.textContent).toBe("prod-backup-1");
    // 另一行不许被顺手改掉。
    expect(rows(target)[0].querySelector(".devicename")?.textContent).toBe("CLI");
  });

  it("重名是允许的 —— 靠后缀区分，不靠禁止同名", async () => {
    const target = await render();
    const input = await openEditor(target, 0);
    input.value = "CLI"; // 与另一行同名
    input.dispatchEvent(new Event("input", { bubbles: true }));
    save(rows(target)[0]);
    await settle();
    // 名字没变，所以这一步应该当作取消：不值得为"改成原样"发一次请求。
    expect(calls.some((c) => c.init?.method === "PATCH")).toBe(false);
    expect(rows(target)[0].querySelector(".renameinput")).toBeNull();

    const again = await openEditor(target, 0);
    again.value = "backup";
    again.dispatchEvent(new Event("input", { bubbles: true }));
    save(rows(target)[0]);
    await settle();
    const second = await openEditor(target, 1);
    second.value = "backup";
    second.dispatchEvent(new Event("input", { bubbles: true }));
    save(rows(target)[1]);
    await settle();
    expect(rows(target).map((r) => r.querySelector(".devicename")?.textContent)).toEqual([
      "backup",
      "backup",
    ]);
    // 同名之后，能区分它们的只剩后缀。
    const refs = rows(target).map((r) => r.querySelector(".deviceref")?.textContent);
    expect(new Set(refs).size).toBe(2);
  });

  it("服务端说名字不能用：编辑器留着、草稿留着、说的是「换一个名字」", async () => {
    patchReply = async () => json({ error: "invalid_device_name" }, 400);
    const target = await render();
    const input = await openEditor(target, 0);
    input.value = "prod‮kcab";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    save(rows(target)[0]);
    await settle();

    const row = rows(target)[0];
    const still = row.querySelector(".renameinput") as HTMLInputElement | null;
    expect(still, "失败后编辑器被关掉了，用户输入的东西也没了").toBeTruthy();
    expect(still!.value).toBe("prod‮kcab");
    expect(still!.getAttribute("aria-invalid")).toBe("true");
    expect(row.querySelector(".renameerr")?.textContent).toMatch(/can't be used/i);
    expect(row.querySelector(".devicename"), "名字那一格在编辑时不该同时存在").toBeNull();
  });

  it("请求失败和名字被拒是两句不同的话", async () => {
    patchReply = async () => { throw new TypeError("offline"); };
    const target = await render();
    const input = await openEditor(target, 0);
    input.value = "prod-1";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    save(rows(target)[0]);
    await settle();

    const err = rows(target)[0].querySelector(".renameerr")?.textContent ?? "";
    expect(err).toMatch(/unchanged/i);
    expect(err, "把网络故障说成了名字不能用 —— 用户会去反复改名字").not.toMatch(/can't be used/i);
  });

  it("失败之后可以重试成功", async () => {
    let attempt = 0;
    patchReply = async () => (++attempt === 1 ? json({ error: "x" }, 500) : json({ status: "ok" }));
    const target = await render();
    const input = await openEditor(target, 0);
    input.value = "prod-1";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    save(rows(target)[0]);
    await settle();
    expect(rows(target)[0].querySelector(".renameerr")).toBeTruthy();

    save(rows(target)[0]); // 同一个草稿，再存一次
    await settle();
    expect(rows(target)[0].querySelector(".renameinput")).toBeNull();
    expect(rows(target)[0].querySelector(".devicename")?.textContent).toBe("prod-1");
  });

  it("取消不发请求，也不动名字", async () => {
    const target = await render();
    const input = await openEditor(target, 0);
    input.value = "throwaway";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    const cancel = [...rows(target)[0].querySelectorAll("button")].find(
      (b) => b.textContent?.trim() === "Cancel",
    ) as HTMLButtonElement;
    cancel.click();
    await settle();
    expect(calls.some((c) => c.init?.method === "PATCH")).toBe(false);
    expect(rows(target)[0].querySelector(".devicename")?.textContent).toBe("CLI");
  });

  it("空名字当作取消，不去撞服务端的拒绝", async () => {
    const target = await render();
    const input = await openEditor(target, 0);
    input.value = "   ";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    save(rows(target)[0]);
    await settle();
    expect(calls.some((c) => c.init?.method === "PATCH")).toBe(false);
    expect(rows(target)[0].querySelector(".devicename")?.textContent).toBe("CLI");
  });

  it("输入框有指名道姓的可访问名称和长度上限", async () => {
    const target = await render();
    const input = await openEditor(target, 0);
    expect(input.getAttribute("aria-label")).toContain("CLI");
    expect(input.getAttribute("maxlength")).toBe(String(DEVICE_NAME_MAX));
  });

  it("编辑期间改名按钮消失 —— 再按一次会把草稿清掉", async () => {
    const target = await render();
    const input = await openEditor(target, 0);
    input.value = "half-typed";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await settle();
    const row = rows(target)[0];
    const rename = [...row.querySelectorAll("button")].find((b) =>
      /rename/i.test(b.getAttribute("aria-label") ?? ""),
    );
    expect(rename, "编辑期间改名按钮还在，按下去会丢掉正在输入的名字").toBeUndefined();
    // 吊销按钮**不**消失：编辑名字不该挡住一个安全操作。
    expect(row.querySelector("button.del")).toBeTruthy();
    expect((row.querySelector(".renameinput") as HTMLInputElement).value).toBe("half-typed");
  });
});

describe("发送入口的可发现性", () => {
  it("一台设备都没有时，说清楚下一步并给出去 /cli 的入口", async () => {
    devicesReply = async () => json({ devices: [] });
    const target = await render();
    const text = target.textContent ?? "";
    expect(text).toContain("No apps or CLI devices signed in.");
    expect(text, "空状态没说怎么让一台机器出现在这里").toMatch(/relayium login/);
    const link = target.querySelector(".accountdevices .setup a") as HTMLAnchorElement | null;
    expect(link, "空状态没有通往设置说明的链接").toBeTruthy();
    expect(link!.getAttribute("href")).toBe("/cli#device-inbox");
  });

  it("有设备但一台都没开收件箱时，解释为什么没有发送按钮", async () => {
    const target = await render();
    const text = target.textContent ?? "";
    expect(text, "没解释为什么一个发送入口都看不到").toMatch(/None of these devices has an inbox turned on/);
    expect(target.querySelector(".accountdevices .setup a")?.getAttribute("href")).toBe("/cli#device-inbox");
    // 没有收件箱就没有发送控件 —— 这条安全性质不能被"讲清楚"给讲没了。
    expect(target.querySelector(".sendzone"), "未登记的设备上出现了发送控件").toBeNull();
  });

  it("说明「发送文件」按钮什么时候出现", async () => {
    const target = await render();
    expect(target.textContent).toMatch(/A Send files button appears on a device once/);
  });

  it("有设备已登记收件箱时，不再说「一台都没开」，并且真的有发送控件", async () => {
    devicesReply = async () => json({
      devices: [
        {
          ID: "0123456789abcdef0123456789ccc333",
          Name: "build-server",
          CreatedAt: 1_700_000_000,
          LastSeenAt: 1_700_100_000,
          Kind: "cli",
          // 与 DeviceCard.test.ts 的夹具同形：`sendAvailability` 要求登记、未撤销、
          // 具备 inbox.receive.v2 能力、算法受支持、公钥合法，缺一个就没有发送控件。
          Inbox: {
            Presence: "online",
            LastHeartbeatAt: 1_700_000_000,
            PresenceExpiresAt: 1_700_000_090,
            HeartbeatIntervalSeconds: 30,
            ProtocolVersion: 1,
            Capabilities: [CAP_RECEIVE_V2, "inbox.autoaccept.v1"],
            ReceiveCapability: CAP_RECEIVE_V2,
            AutoAccept: "auto",
            ReceiveDirReady: true,
            Platform: "linux",
            AppVersion: "0.15.0",
            Revoked: false,
            CanReceive: true,
            RegisteredAt: 1_699_000_000,
            Key: {
              ID: "k1",
              Algorithm: INBOX_KEY_ALGORITHM,
              PublicKey: "A".repeat(43),
              Generation: 1,
              CreatedAt: 1,
              SupersededAt: 0,
              RevokedAt: 0,
            },
          },
        },
      ],
    });
    const target = await render();
    expect(target.textContent).not.toMatch(/None of these devices has an inbox turned on/);
    expect(target.querySelector(".sendzone"), "已登记设备上没有发送控件").toBeTruthy();
  });

  it("未登录时整个区块都不渲染", async () => {
    signedIn = false;
    const target = await render();
    expect(target.querySelector(".accountdevices")).toBeNull();
  });
});

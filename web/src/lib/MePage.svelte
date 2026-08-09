<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { confirmDialog, resolveConfirm } from "./confirm-dialog.svelte";
  import { session, refreshSession } from "./auth.svelte";
  import { setLoginOpen } from "./login.svelte";
  import { lang, messages, type Messages } from "./i18n.svelte";
  import { navigate, CLI_PATH } from "./router.svelte";
  import { formatSize, formatRemaining } from "./format";
  import { nodeRunCommand, nodePortsCommand } from "./nodes";
  import { buildDownloadLink } from "./stored-file";
  import { copyFeedback } from "./clipboard.svelte";
  import { uploadKey, forgetUploadKey, pruneUploadKeys } from "./upload-keys";
  import WhyAccount from "./WhyAccount.svelte";
  import CommandBlock from "./CommandBlock.svelte";
  import { reveal, countUp } from "./reveal";
  import PlanCard from "./PlanCard.svelte";
  import QuotaMeters from "./QuotaMeters.svelte";
  import DeviceCard, { type RenameOutcome } from "./DeviceCard.svelte";
  import { DEVICE_REFRESH_MS, parseDeviceInbox } from "./device-inbox";
  import { deviceSuffix } from "./device-identity";
  import { invalidateUsage } from "./usage.svelte";

  // 每次进入 /me 都要拿新的用量数字：/me 是懒加载路由（App.svelte 的
  // `{#if currentRoute() === "me"}`），离开再回来会真的重新挂载本组件，所以在
  // 组件初始化时丢掉共享缓存，让页内的 QuotaMeters 重新请求一次。没有这一句，
  // 用量数字会在整个 SPA 会话内冻结——上传完文件回到个人中心，存储数字不动。
  //
  // 必须放在 <script> 顶层，不能放进 onMount：实测过（不是推理），放 onMount
  // 时子组件的 $effect 已经先跑完并建立了在途缓存，这里再清一次会让同一次访问
  // 多打一次 /api/me/usage 请求（测试实测 2 次而不是 1 次）。顶层代码在子组件
  // 初始化之前执行，清的是上一次访问留下的缓存，两条契约才能同时成立。
  invalidateUsage();

  const t = $derived<Messages>(messages[lang()]);

  interface Stats {
    transfers: number; downloads: number;
    uploadBytes: number; downloadBytes: number; relayBytes: number;
  }
  interface FileRow {
    id: string; size: number; createdAt: number; expiresAt: number;
    burnAfterRead: boolean; downloadCount: number;
  }
  interface NodeRow {
    id: string; name: string; host: string; region: string; online: boolean;
    relayedBytes: number; storedBytes: number;
    storageFree: number; storageTotal: number; lastSeen: number;
  }

  let stats = $state<Stats | null>(null);
  let files = $state<FileRow[]>([]);
  // Local id→key map for files this browser uploaded, so their share link (whose
  // key the server never holds) can be rebuilt and re-copied from here.
  let fileKeys = $state<Record<string, string>>({});
  const linkCopy = copyFeedback(); // file id whose "copy link" just fired, for the ✓ state
  // Transient failure notice for the write actions below. Without it a failed
  // request was completely silent: the row simply didn't change and the user had
  // no way to tell a rejected request from one that never left the browser.
  let actionErr = $state("");
  function failed() {
    actionErr = t.me.actionFailed;
    setTimeout(() => (actionErr = ""), 5000);
  }
  let loading = $state(true);
  let nowSec = $state(Math.floor(Date.now() / 1000));
  let loadedFor = ""; // user id we last loaded data for; guards against refetch loops

  // 账号级、可吊销的持令牌设备。后端一直有这两个接口（列出 + 删除，删设备会级联
  // 删掉它的令牌），丢了笔记本或手机时这是唯一能自救的地方。
  // `Inbox` is the additive Device Inbox subtree (protocol §9): null for every
  // device that never enrolled, and typed `unknown` here on purpose — this page
  // does not interpret it, it hands it to DeviceCard, which parses it
  // defensively in one place.
  interface DeviceRow { ID: string; Name: string; CreatedAt: number; LastSeenAt: number; LastIP?: string; Kind: string; Inbox?: unknown }

  // 列进来的 Kind，以及它们各自的行内标签。只有这两类：它们持有的是同一种能代表
  // 账号传输/上传的 bearer 令牌（CLI 走 relayium login，App 走原生登录），吊销的
  // 后果对两者是同一句话。
  //
  // 浏览器那一类不列：本机自动登记，持有的是会话 cookie 而不是能拷走的令牌。空
  // Kind 和将来才出现的新 Kind 同样不列——这一版说不清楚吊销它们意味着什么，与其
  // 给一个含义不明的破坏性按钮，不如不给。
  //
  // Map 而不是普通对象：Kind 是从服务端拿来的字符串，拿对象查表就得用 `in` 或
  // `?.` 判断，两者都会走到 Object.prototype 上——Kind = "toString"/"constructor"
  // 会被当成已知类型放行，还会把行内标签渲染成一个内置函数。Map 只有自有键。
  const DEVICE_KINDS = new Map<string, () => string>([
    ["app", () => t.me.deviceKindApp],
    ["cli", () => t.me.deviceKindCli],
  ]);

  let devices = $state<DeviceRow[]>([]);
  // 设备请求属于哪一段登录会话。账号切换、登出后再登录同一账号，甚至组件销毁，
  // 都会换一个代号；旧列表/旧吊销请求的迟到响应因此不能改写当前页面。
  let deviceSessionGen = 0;

  async function loadDevices(gen: number) {
    if (gen !== deviceSessionGen) return;
    try {
      const res = await fetch("/api/devices", { credentials: "include" });
      // This function is also the 30-second presence refresh. A transient
      // failure must preserve the last trustworthy list: clearing it would
      // unmount every DeviceCard and abort an upload already in progress.
      // Initial/account-switch loads already clear `devices` before calling us,
      // so retaining here cannot expose a previous account's rows.
      if (!res.ok) return;
      const all: DeviceRow[] = (await res.json()).devices ?? [];
      if (gen !== deviceSessionGen) return;
      // 跨类型统一排序：这个列表唯一的排序承诺是「最近用过的在最上面」，按类型
      // 分组会让它不成立。从未使用过的（LastSeenAt = 0）之间按创建时间倒序。
      devices = all
        .filter((d) => DEVICE_KINDS.has(d.Kind))
        .sort((a, b) => b.LastSeenAt - a.LastSeenAt || b.CreatedAt - a.CreatedAt);
    } catch {
      // Keep the last trustworthy list. Presence may be briefly stale, but an
      // explicit failed refresh is not evidence that the devices disappeared.
    }
  }

  async function revokeDevice(d: DeviceRow) {
    const gen = deviceSessionGen;
    // 确认框指名要吊销的是哪一台：一屏里可能有好几行，可见文字又都是同一个"吊销"。
    // 名字**不足以**指名——两台机器可以同名，而且改名之前它们全都叫 "CLI"。所以这句
    // 话要带上类型、ID 尾号和登录时间；真正被删的始终是那一行的完整 ID。
    if (!(await confirmDialog(t.me.deviceConfirmRevoke(d.Name, kindText(d), refText(d), signedInText(d))))) return;
    if (gen !== deviceSessionGen) return;
    try {
      const res = await fetch(`/api/devices/${encodeURIComponent(d.ID)}`, {
        method: "DELETE", credentials: "include",
      });
      if (gen !== deviceSessionGen) return;
      if (!res.ok) { failed(); return; }
      // 按 ID 摘掉那一行。等确认框期间列表可能已经被重新拉过，所以过滤的是当时
      // 的 `devices`，不是发起吊销时的那份快照。
      devices = devices.filter((x) => x.ID !== d.ID);
    } catch {
      if (gen === deviceSessionGen) failed();
    }
  }

  /** 行内类型标签：App 还是 CLI。两类持有同等权限的令牌，用户得能一眼分开。 */
  function kindText(d: DeviceRow): string {
    return DEVICE_KINDS.get(d.Kind)?.() ?? "";
  }

  /** 最后使用时间。0 不是"从未使用"那种故障感的说法——刚批准完的令牌本来就还没用过，
   *  说成「自登录以来没用过」才是它真正的意思。 */
  function lastUsedText(d: DeviceRow): string {
    if (!d.LastSeenAt) return t.me.deviceNotUsedSinceSignIn;
    return t.me.deviceLastUsed(new Date(d.LastSeenAt * 1000).toLocaleString(lang()));
  }

  /** 这枚凭据是什么时候被批准的。对那些没有标签、全叫 "CLI" 的老行来说，这是不需要
   *  回填数据库就能拿到的两个区分依据之一。 */
  function signedInText(d: DeviceRow): string {
    return t.me.deviceSignedIn(new Date(d.CreatedAt * 1000).toLocaleString(lang()));
  }

  /** 另一个：设备 ID 的短后缀。ID 太短切不出东西时返回空串，由行内决定不渲染。 */
  function refText(d: DeviceRow): string {
    const suffix = deviceSuffix(d.ID);
    return suffix ? t.me.deviceRef(suffix) : "";
  }

  /** 行内改名，走本来就有的 PATCH /api/devices/{id}。
   *
   *  返回值分三种而不是一个布尔：服务端说这个名字不能用（控制字符、方向覆盖、太长）
   *  是**用户能改**的事，请求本身失败则值得重试，两句话不该混成一句。 */
  async function renameDevice(d: DeviceRow, name: string): Promise<RenameOutcome> {
    const gen = deviceSessionGen;
    try {
      const res = await fetch(`/api/devices/${encodeURIComponent(d.ID)}`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      if (gen !== deviceSessionGen) return "failed";
      if (res.status === 400) return "rejected";
      if (!res.ok) return "failed";
      // 改的是当下这份 `devices`，不是发起时的快照——等请求期间列表可能已经被
      // 后台的 presence 刷新换过一轮了。
      devices = devices.map((x) => (x.ID === d.ID ? { ...x, Name: name } : x));
      return "ok";
    } catch {
      return "failed"; // 离线/断线：fetch 直接 reject，不会走到 !res.ok
    }
  }

  /** 有没有哪一台真的开了收件箱。全是"没开"时，页面必须自己说清楚为什么一个
   *  「发送文件」按钮都看不见——这正是这个功能上线后没人找得到的原因。 */
  const anyInboxEnrolled = $derived(devices.some((d) => parseDeviceInbox(d.Inbox) !== null));

  /** 去 /cli 上「设备收件箱」那一节。
   *
   *  **不加语言前缀。** `/cli` 是 SPA 路由，语言来自 localStorage；带前缀的
   *  `/ar/cli` 根本不存在（构建产物里只有 /ar/apps、/ar/cross-network 这些静态页），
   *  九种语言里有八种会 404。页内其他去 /cli 的入口（Nav、AppsPage、CliCallout）
   *  用的也都是裸 CLI_PATH。 */
  const cliInboxHref = `${CLI_PATH}#device-inbox`;

  // "My Nodes" — BYO relay node section.
  let nodes = $state<NodeRow[]>([]);
  let strict = $state(false);
  let addingNode = $state(false); // add-node mini-form open
  let newNodeName = $state("");
  let newToken = $state<string | null>(null); // shown exactly once, right after provisioning

  // Per-node live connectivity probe: distinct from the passive online dot, this
  // asks central to actually reach the node right now.
  interface CheckResult { reachable: boolean; online: boolean; latencyMs: number; error?: string }
  let checking = $state<Record<string, boolean>>({});
  let checkResult = $state<Record<string, CheckResult>>({});

  // Inline node rename: which node id is being edited, and the draft label.
  let renamingId = $state<string | null>(null);
  let renameDraft = $state("");
  function startRename(n: NodeRow) { renamingId = n.id; renameDraft = n.name; }
  function focusRename(node: HTMLInputElement) { node.focus(); node.select(); }
  async function saveRename(id: string) {
    const label = renameDraft.trim();
    renamingId = null;
    try {
      const res = await fetch(`/api/nodes/${id}/label`, {
        method: "PUT", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: label }),
      });
      if (!res.ok) { failed(); return; }
      nodes = nodes.map((n) => (n.id === id ? { ...n, name: label } : n));
    } catch {
      failed(); // offline / connection dropped — fetch rejects rather than returning !ok
    }
  }

  async function loadNodes() {
    try {
      const res = await fetch("/api/nodes/mine", { credentials: "include" });
      nodes = res.ok ? ((await res.json()).nodes ?? []) : [];
    } catch {
      nodes = [];
    }
  }

  async function checkNode(id: string) {
    checking = { ...checking, [id]: true };
    try {
      const res = await fetch(`/api/nodes/${id}/check`, { method: "POST", credentials: "include" });
      checkResult = { ...checkResult, [id]: res.ok ? await res.json() : { reachable: false, online: false, latencyMs: 0, error: "error" } };
    } catch {
      checkResult = { ...checkResult, [id]: { reachable: false, online: false, latencyMs: 0, error: "error" } };
    } finally {
      checking = { ...checking, [id]: false };
    }
  }

  async function load(deviceGen: number) {
    loading = true;
    try {
      const [sr, fr, mr] = await Promise.all([
        fetch("/api/stats", { credentials: "include" }),
        fetch("/api/files", { credentials: "include" }),
        fetch("/api/me", { credentials: "include" }),
      ]);
      stats = sr.ok ? await sr.json() : null;
      files = fr.ok ? ((await fr.json()).files ?? []) : [];
      strict = mr.ok ? Boolean((await mr.json()).user?.onlyOwnNodes) : false;
      // Recover locally-held keys for the current files, and drop keys for files
      // the server no longer lists (expired/deleted) so the store can't grow forever.
      const ids = files.map((f) => f.id);
      pruneUploadKeys(ids);
      const km: Record<string, string> = {};
      for (const id of ids) {
        const k = uploadKey(id);
        if (k) km[id] = k;
      }
      fileKeys = km;
    } catch {
      stats = null;
      files = [];
      strict = false;
      fileKeys = {};
    } finally {
      loading = false;
    }
    await loadNodes();
    await loadDevices(deviceGen);
  }

  async function copyLink(id: string) {
    const key = fileKeys[id];
    if (!key) return;
    await linkCopy.copy(buildDownloadLink(location.origin, id, key), id);
  }

  async function addNode() {
    const name = newNodeName.trim();
    try {
      const res = await fetch("/api/nodes/provision", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      if (!res.ok) { failed(); return; }
      const body = (await res.json()) as { token: string };
      newToken = body.token;
      newNodeName = "";
      addingNode = false;
      await loadNodes();
    } catch {
      failed();
    }
  }

  async function deleteNode(id: string) {
    if (!(await confirmDialog(t.me.confirmDelNode))) return;
    try {
      const res = await fetch(`/api/nodes/${id}`, { method: "DELETE", credentials: "include" });
      if (!res.ok) { failed(); return; }
      nodes = nodes.filter((n) => n.id !== id);
    } catch {
      failed();
    }
  }

  async function setStrict(next: boolean) {
    if (next === strict) return;
    const prev = strict;
    strict = next; // optimistic — matches the option the user just picked
    try {
      const res = await fetch("/api/me/strict-nodes", {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ onlyOwnNodes: next }),
      });
      if (!res.ok) { strict = prev; failed(); } // revert on failure
    } catch {
      // A rejected fetch left the optimistic toggle showing a setting the server
      // never received — the one case where silence is actively misleading.
      strict = prev;
      failed();
    }
  }

  async function del(id: string) {
    if (!(await confirmDialog(t.me.confirmDel))) return;
    let res: Response;
    try {
      res = await fetch(`/api/files/${id}`, { method: "DELETE", credentials: "include" });
    } catch {
      failed();
      return;
    }
    if (!res.ok) failed();
    if (res.ok) {
      files = files.filter((f) => f.id !== id);
      forgetUploadKey(id);
      const { [id]: _drop, ...rest } = fileKeys;
      fileKeys = rest;
      // A deleted link can no longer be downloaded, but its past downloads still
      // count toward lifetime stats — so refresh the numbers, not just the list.
      try {
        const sr = await fetch("/api/stats", { credentials: "include" });
        if (sr.ok) stats = await sr.json();
      } catch { /* keep stale stats on a transient error */ }
    }
  }

  const totalTraffic = $derived(
    stats ? stats.uploadBytes + stats.downloadBytes + stats.relayBytes : 0,
  );

  // 账户注销。服务端的双重确认流程一直都在（POST /api/account/delete/request 只发一封
  // 确认邮件，删除动作全部发生在邮件里的链接被打开之后），法律文本也已经写明可以在网页
  // 端的账户设置里注销——但网页上从来没有这个入口，只有原生 App 有。
  //
  // 状态名是承重的：没有 "deleted"，也没有 "scheduled"，因为这个按钮观察不到那两件事。
  // 它唯一能知道的是「服务端收下了这次请求」——端点无论真发了邮件、被按账号节流吞掉还是
  // 发信失败都回同一个 200。
  type DeleteState = "idle" | "requesting" | "requested" | "failed";
  let deleteState = $state<DeleteState>("idle");
  // 发起这次请求的账号 + 一个单调递增的代号。两个都要，因为它们会分头失效：
  //  - 账号 id 挡住「A 的结果画到 B 的页面上」；
  //  - 代号挡住「登出后又用同一个账号登回来」——那时 id 又对上了，只有代号还能证明
  //    这条响应属于上一段会话。
  let deleteGen = 0;
  let deleteForUser = "";

  // 注销请求的提示语。空串 = 无话可说——但承载它的活动区域必须一直在（见模板里的
  // 注释），所以这里给的是内容，不是「渲不渲染」。
  const deleteNotice = $derived(
    deleteState === "requested" ? t.me.deleteRequested(session().user?.email ?? "")
    : deleteState === "failed" ? t.me.deleteFailed
    : "",
  );

  /** 这条在途响应还属于当前这段会话吗？ */
  function deleteStillCurrent(gen: number): boolean {
    return gen === deleteGen && (session().user?.id ?? "") === deleteForUser;
  }

  // 账号变了（登出、或换成另一个账号）就作废在途请求并清空反馈：一句关于某个账号的
  // 「已提交请求」出现在登出后的页面上、或者别人的账号上，都是在说一件没发生的事。
  function resetDeleteRequest() {
    // ConfirmModal is shared and now lives in App, outside this page entirely —
    // which makes this reset more load-bearing than when it was mounted here, not
    // less: the dialog survives leaving /me. Without
    // this, signing out, changing account, or leaving /me while the dialog is
    // open leaves the old account address visible (and retained in its state)
    // even though the request itself would later be rejected by the uid guard.
    resolveConfirm(false);
    deleteGen++;
    deleteForUser = "";
    deleteState = "idle";
  }

  async function requestAccountDeletion() {
    const uid = session().user?.id ?? "";
    if (!uid) return; // 未登录时这个区块根本不渲染；这里守的是过期视图/迟到的点击
    // 同一时刻只允许一条在途请求。这一处判断就够，不需要在弹窗之后再补一次：共享的
    // confirmDialog 同时只存在一个弹窗，第二次调用会先把上一个 resolve 成"取消"，
    // 于是先进来的那次在下一行就退出了，两条路径不可能同时走到发请求那步。
    if (deleteState === "requesting") return;
    // 先问，问完了才认领代号：取消那条路径因此一个字节都不改——既不发请求，也不会
    // 顺手抹掉上一次请求留在屏幕上的结果（那句话说的是上一次请求的事实，没被推翻）。
    if (!(await confirmDialog(t.me.deleteConfirm(session().user?.email ?? ""), t.me.deleteConfirmAction))) return;
    if ((session().user?.id ?? "") !== uid) return; // 弹窗开着的时候账号被换掉了
    const gen = ++deleteGen;
    deleteForUser = uid;
    deleteState = "requesting";
    let res: Response;
    try {
      res = await fetch("/api/account/delete/request", { method: "POST", credentials: "include" });
    } catch {
      if (!deleteStillCurrent(gen)) return;
      deleteState = "failed";
      return;
    }
    if (!deleteStillCurrent(gen)) return;
    // 这里**不**登出、**不**清会话、**不**动页面上的任何数据：什么都还没被删，账号
    // 依然可用，而且用户可能正需要这个会话来改主意。
    deleteState = res.ok ? "requested" : "failed";
  }

  // Load once per logged-in user; reload if a login happens while on this page.
  $effect(() => {
    const uid = session().user?.id ?? "";
    if (uid && uid !== loadedFor) {
      loadedFor = uid;
      const deviceGen = ++deviceSessionGen;
      devices = [];
      resetDeleteRequest();
      load(deviceGen);
    }
    if (!uid) {
      loadedFor = "";
      deviceSessionGen++;
      devices = [];
      stats = null; files = []; loading = false;
      nodes = []; strict = false; newToken = null; addingNode = false; renamingId = null;
      resetDeleteRequest();
    }
  });

  // 设备在线状态是**会过期**的（presence TTL 90s，心跳 30s）。列表拉过一次就不动的话，
  // 一台设备下线之后卡片会一直显示"在线"——而这一版的在线状态是要拿来做发送决策的。
  // 所以加一个有界的定时刷新，并且只在页面可见时发请求：后台标签页里刷新既没人看，
  // 又是白付的流量。切回前台时立刻补一次，不等下一个整周期。
  let presenceTick: ReturnType<typeof setInterval> | undefined;
  function refreshDevicesIfVisible() {
    if (typeof document !== "undefined" && document.hidden) return;
    if (!session().user) return;
    void loadDevices(deviceSessionGen);
  }
  function onVisibility() {
    if (typeof document !== "undefined" && !document.hidden) refreshDevicesIfVisible();
  }

  let tick: ReturnType<typeof setInterval>;
  onMount(async () => {
    await refreshSession();
    tick = setInterval(() => (nowSec = Math.floor(Date.now() / 1000)), 30_000);
    presenceTick = setInterval(refreshDevicesIfVisible, DEVICE_REFRESH_MS);
    if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVisibility);
  });
  onDestroy(() => {
    clearInterval(tick);
    if (presenceTick !== undefined) clearInterval(presenceTick);
    if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVisibility);
    deviceSessionGen++;
    resetDeleteRequest();
  });
</script>

<section class="me page-enter">

  <header class="me-head">
    <button class="back" onclick={() => navigate("lan")}>{t.me.back}</button>
    <h1>{t.me.title}</h1>
  </header>

  {#if actionErr}
    <p class="action-err" role="alert">{actionErr}</p>
  {/if}

  {#if !session().user}
    <div class="gate">
      <p>{t.me.loginRequired}</p>
      <button class="btn btn-primary" onclick={() => setLoginOpen(true)}>{t.me.signIn}</button>
      <WhyAccount compact />
    </div>
  {:else}
    <PlanCard />
    <QuotaMeters />

    <div class="stats reveal" use:reveal>
      <div class="stat">
        <span class="num" use:countUp={stats?.transfers ?? 0}>{stats?.transfers ?? 0}</span>
        <span class="lbl">{t.me.transfers}</span>
      </div>
      <div class="stat">
        <span class="num" use:countUp={stats?.downloads ?? 0}>{stats?.downloads ?? 0}</span>
        <span class="lbl">{t.me.downloads}</span>
      </div>
      <div class="stat wide">
        <span class="num">{formatSize(totalTraffic)}</span>
        <span class="lbl">{t.me.traffic}</span>
        <span class="parts">{t.me.trafficParts(
          formatSize(stats?.uploadBytes ?? 0),
          formatSize(stats?.downloadBytes ?? 0),
          formatSize(stats?.relayBytes ?? 0),
        )}</span>
      </div>
    </div>
    <p class="privacy">{t.me.privacyNote}</p>

    <section class="files">
      <div class="files-head">
        <h2>{t.me.filesTitle}</h2>
        <span class="note">{t.me.noName}</span>
      </div>
      <p class="link-hint">{t.me.linkHint}</p>

      {#if loading}
        <p class="muted">…</p>
      {:else if files.length === 0}
        <p class="muted">{t.me.filesEmpty}</p>
      {:else}
        <ul class="filelist">
          {#each files as f (f.id)}
            {@const secLeft = f.expiresAt - nowSec}
            <li>
              <span class="fid">#{f.id.slice(0, 8)}</span>
              <span class="fsize">{formatSize(f.size)}</span>
              {#if f.burnAfterRead}<span class="tag burn">🔥 {t.me.burnTag}</span>{/if}
              <span class="dl">↓ {t.me.downloadsN(f.downloadCount)}</span>
              <span class="exp" class:soon={secLeft < 3600}>
                ⏳ {t.me.expiresIn(formatRemaining(secLeft, t.download.durUnits))}
              </span>
              {#if fileKeys[f.id]}
                <button class="linkbtn" class:copied={linkCopy.value === f.id} onclick={() => copyLink(f.id)}>
                  {linkCopy.value === f.id ? "✓" : "🔗 " + t.me.copyLink}
                </button>
              {/if}
              <button class="del" onclick={() => del(f.id)} aria-label={t.me.del}>{t.me.del}</button>
            </li>
          {/each}
        </ul>
      {/if}
    </section>

    <section class="nodes">
      <div class="nodes-head">
        <h2>{t.me.nodesTitle}</h2>
      </div>
      <div class="routing" role="radiogroup" aria-label={t.me.routingTitle}>
        <label class="routeopt" class:sel={!strict}>
          <input type="radio" name="node-routing" checked={!strict} onchange={() => setStrict(false)} />
          <span class="ropt-text"><b>{t.me.routeAuto}</b><span class="hint">{t.me.routeAutoHint}</span></span>
        </label>
        <label class="routeopt" class:sel={strict} class:disabled={nodes.length === 0}>
          <input
            type="radio"
            name="node-routing"
            checked={strict}
            disabled={nodes.length === 0}
            title={nodes.length === 0 ? t.me.nodesEmpty : undefined}
            onchange={() => setStrict(true)}
          />
          <span class="ropt-text"><b>{t.me.strictLabel}</b><span class="hint">{t.me.strictHint}</span></span>
        </label>
      </div>
      <p class="hint">{t.me.nodesTrafficHint}</p>

      {#if newToken}
        <div class="token-reveal">
          <p class="hint">{t.me.tokenNote}</p>
          <CommandBlock code={nodeRunCommand(newToken, location.origin)} title="relayium-node" />
          <p class="hint ports-note">{t.me.tokenPortsNote}</p>
          <CommandBlock code={nodePortsCommand()} title={t.me.tokenPortsTitle} />
          <p class="hint">
            <a href={lang() === "en" ? "/guides/bring-your-own-node" : `/${lang()}/guides/bring-your-own-node`} target="_blank" rel="noopener">{t.me.tokenGuideLink} →</a>
          </p>
          <button class="btn btn-primary" onclick={() => (newToken = null)}>{t.me.tokenDone}</button>
        </div>
      {:else if addingNode}
        <form class="add-form" onsubmit={(e) => { e.preventDefault(); addNode(); }}>
          <input type="text" bind:value={newNodeName} placeholder={t.me.nodeNamePlaceholder} />
          <button type="submit" class="btn btn-primary">{t.me.addNodeSubmit}</button>
          <button type="button" class="btn-link" onclick={() => { addingNode = false; newNodeName = ""; }}>
            {t.me.addNodeCancel}
          </button>
        </form>
      {:else}
        <button class="btn btn-ghost" onclick={() => (addingNode = true)}>{t.me.addNode}</button>
      {/if}

      {#if nodes.length === 0}
        <p class="muted">{t.me.nodesEmpty}</p>
      {:else}
        <ul class="nodelist">
          {#each nodes as n (n.id)}
            {@const cr = checkResult[n.id]}
            <li>
              <span class="dot" class:on={n.online} aria-label={n.online ? t.me.nodeOnline : t.me.nodeOffline}></span>
              {#if renamingId === n.id}
                <input
                  class="rename"
                  bind:value={renameDraft}
                  placeholder={t.me.nodeNamePlaceholder}
                  use:focusRename
                  onkeydown={(e) => { if (e.key === "Enter") { e.preventDefault(); saveRename(n.id); } else if (e.key === "Escape") { renamingId = null; } }}
                  onblur={() => saveRename(n.id)}
                />
              {:else if n.name}
                <button class="nname" onclick={() => startRename(n)} title={t.me.nodeRename}>{n.name}</button>
              {/if}
              <span class="nid">{#if n.host}{n.host} · {/if}{n.region || "—"} · #{n.id.slice(0, 8)}</span>
              <span class="nstat">{t.me.nodeRelayed(formatSize(n.relayedBytes))} ({t.me.nodeFreeTag})</span>
              <span class="nstat">{t.me.nodeStorageFree(formatSize(n.storageFree), formatSize(n.storageTotal))}</span>
              {#if cr}
                <span class="probe" class:ok={cr.reachable} class:bad={!cr.reachable}>
                  {cr.reachable ? t.me.nodeReachable(String(cr.latencyMs)) : t.me.nodeUnreachable}
                </span>
              {/if}
              <button class="chk" onclick={() => startRename(n)}>{t.me.nodeRename}</button>
              <button class="chk" disabled={checking[n.id]} onclick={() => checkNode(n.id)}>
                {checking[n.id] ? "…" : t.me.checkNode}
              </button>
              <button class="del" onclick={() => deleteNode(n.id)} aria-label={t.me.delNode}>{t.me.delNode}</button>
            </li>
          {/each}
        </ul>
      {/if}
    </section>

    <section class="accountdevices">
      <h2>{t.me.deviceTitle}</h2>
      <p class="muted">{t.me.deviceIntro}</p>
      <p class="muted">{t.deviceInbox.sectionHint}</p>
      <!-- Where the send control comes from. The feature shipped with no
           explanation anywhere: a signed-in owner with three CLI devices saw
           no send affordance and nothing saying why not. -->
      <p class="muted">{t.deviceInbox.sendWhere}</p>
      {#if devices.length === 0}
        <p class="muted">{t.me.deviceEmpty}</p>
        <p class="muted">{t.me.deviceEmptyHint}</p>
        <p class="setup"><a href={cliInboxHref}>{t.deviceInbox.setupCta} →</a></p>
      {:else}
        {#if !anyInboxEnrolled}
          <!-- Devices exist, none can receive. Without this the page is silent
               about the difference between "no inbox yet" and "this feature
               does not exist", and the owner has no way to tell which. -->
          <p class="muted">{t.deviceInbox.noneEnrolled}</p>
          <p class="setup"><a href={cliInboxHref}>{t.deviceInbox.setupCta} →</a></p>
        {/if}
        <ul class="devicelist">
          <!-- Keyed by ID so a background presence refresh replaces the DATA of
               a row without destroying the card — an in-flight send and its
               status poll live in that component and must survive the refresh
               that keeps "online" honest. -->
          {#each devices as d (d.ID)}
            <DeviceCard
              device={d}
              kind={kindText(d)}
              lastUsed={lastUsedText(d)}
              signedIn={signedInText(d)}
              deviceRef={refText(d)}
              onRevoke={() => revokeDevice(d)}
              onRename={(name) => renameDevice(d, name)}
            />
          {/each}
        </ul>
      {/if}
    </section>

    <!-- 注销账户。放在最底下并用一条分隔线切开：它和上面那些日常操作不是一类东西，
         不该出现在用户扫一眼就会点到的地方，但也必须真的找得到——法律文本承诺了它。 -->
    <section class="danger-zone">
      <h2>{t.me.deleteTitle}</h2>
      <p class="muted">{t.me.deleteBody(session().user?.email ?? "")}</p>
      <button
        class="danger-btn"
        disabled={deleteState === "requesting"}
        onclick={requestAccountDeletion}
      >
        {deleteState === "requesting" ? t.me.deleteRequesting : t.me.deleteAction}
      </button>
      <!-- 活动区域一直在，不是等到有话要说的那一刻才建出来：读屏只播报**已存在**的
           活动区域内部的变化。含义全部写在句子里，颜色只是加强——失败那句自己就说了
           「没能请求成功、什么都没删、可以重试」。 -->
      <p class="del-status" class:ok={deleteState === "requested"} class:bad={deleteState === "failed"} role="status" aria-live="polite" aria-atomic="true">{deleteNotice}</p>
    </section>
  {/if}
</section>

<style>
  .accountdevices { margin-top: var(--section-gap); }
  /* 行本身的样式跟着 <li> 一起搬到了 DeviceCard.svelte —— Svelte 的样式是按组件
     作用域的，留在这里的 `.devicelist li` 选择器不会命中子组件里的那个 li。 */
  .devicelist { list-style: none; margin: var(--space-3) 0 0; padding: 0; display: flex; flex-direction: column; gap: var(--space-2); }
  /* 通往 /cli 上「设备收件箱」那一节的入口。空列表和"一台都没开收件箱"两种状态下
     都要有——这两种状态才是用户真正卡住的地方。 */
  .setup { margin: var(--space-2) 0 0; font-size: var(--fs-sm); }
  .setup a { color: var(--accent-fg); }

  /* 注销区块：一条分隔线 + 更大的上边距，把它和上面的日常操作断开。 */
  .danger-zone {
    margin-top: var(--section-gap);
    padding-top: var(--space-5);
    border-top: 1px solid var(--border);
  }
  .danger-zone h2 { font-size: var(--fs-h3); margin: 0 0 var(--space-2); }
  /* 这两段都嵌着用户的邮箱地址——窄屏上一个长地址不换行就会把区块撑出容器。 */
  .danger-zone .muted { margin: 0 0 var(--space-3); line-height: 1.6; max-width: 68ch; word-break: break-word; }
  .danger-btn {
    font: inherit; font-size: var(--fs-xs); background: none; cursor: pointer;
    border: 1px solid var(--danger-border); border-radius: var(--radius-sm); color: var(--danger);
    padding: var(--space-2) var(--space-4); transition: background-color .13s;
  }
  .danger-btn:hover:not(:disabled) { background: var(--danger-bg); }
  .danger-btn:disabled { opacity: .6; cursor: default; }
  /* 空的时候是零高度的：活动区域必须常驻，但没话说的时候不该占位或画出边框。 */
  .del-status { margin: 0; font-size: var(--fs-xs); line-height: 1.6; max-width: 68ch; word-break: break-word; }
  .del-status.ok, .del-status.bad {
    margin-top: var(--space-3); padding: 0.6rem 0.9rem;
    border: 1px solid var(--border); border-radius: var(--radius-sm);
  }
  .del-status.ok { color: var(--text-h); background: var(--social-bg); border-color: var(--accent-border); }
  .del-status.bad { color: var(--danger); background: var(--danger-bg); border-color: var(--danger-border); }

  .action-err {
    margin: 0 0 1rem;
    padding: 0.6rem 0.9rem;
    border-radius: 10px;
    background: color-mix(in srgb, var(--danger, #e5484d) 12%, transparent);
    color: var(--danger, #e5484d);
    font-size: 0.9rem;
  }

  .me { position: relative; max-width: 1120px; margin: 0 auto; }

  .me-head { text-align: center; padding: var(--space-2) 0 var(--space-5); position: relative; }
  .me-head h1 { font-size: 30px; margin: 0; letter-spacing: -.5px; }
  .back {
    position: absolute; inset-inline-start: 0; top: var(--space-2);
    font: inherit; font-size: var(--fs-xs); background: none; border: 0; color: var(--text); cursor: pointer;
    padding: var(--space-1) 0;
  }
  .back:hover { color: var(--text-h); }

  /* Narrow screens: the centred title is wide enough to collide with the
     absolutely-positioned back link. Drop out of that overlay layout — back
     link on its own line, title left-aligned below it. */
  @media (max-width: 560px) {
    .me-head { text-align: start; padding-top: 0; }
    .me-head .back { position: static; display: inline-block; margin-bottom: var(--space-3); }
    .me-head h1 { font-size: 24px; }
  }

  .gate {
    display: flex; flex-direction: column; align-items: center; gap: var(--space-3);
    padding: var(--space-8) var(--space-4); text-align: center; color: var(--text);
  }

  .stats { display: grid; grid-template-columns: repeat(2, 1fr); gap: var(--space-3); margin-top: var(--space-5); }
  .stat {
    display: flex; flex-direction: column; gap: 4px; align-items: center; justify-content: center;
    padding: var(--space-5) var(--space-4); border: 1px solid var(--border); border-radius: var(--radius);
    background: var(--social-bg); text-align: center;
  }
  .stat.wide { grid-column: 1 / -1; }
  .stat .num { font-size: 26px; font-weight: 600; color: var(--text-h); }
  .stat .lbl { font-size: var(--fs-xs); color: var(--text); }
  .stat .parts { font-size: var(--fs-xs); color: var(--text); margin-top: 2px; }

  .privacy { margin: var(--space-3) 0 0; font-size: var(--fs-xs); color: var(--text); text-align: center; }

  .files { margin-top: var(--space-6); }
  .files-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px 10px; margin-bottom: var(--space-3); }
  .files-head h2 { font-size: var(--fs-h3); margin: 0; }
  .files-head .note { font-size: var(--fs-xs); color: var(--text); }
  .muted { color: var(--text); font-size: var(--fs-xs); }

  .filelist { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--space-2); }
  .filelist li {
    display: flex; flex-wrap: wrap; align-items: center; gap: 6px 12px;
    padding: var(--space-3); border: 1px solid var(--border); border-radius: var(--radius-sm);
    background: var(--social-bg); font-size: var(--fs-xs);
  }
  .fid { font-family: ui-monospace, monospace; color: var(--text-h); }
  .fsize { color: var(--text); }
  .dl { color: var(--text-h); }
  .exp { color: var(--text); margin-inline-start: auto; }
  .exp.soon { color: var(--danger); }
  .tag.burn { color: var(--accent-fg); }
  .link-hint { margin: 0 0 var(--space-3); font-size: var(--fs-xs); color: var(--text); }
  .linkbtn {
    font: inherit; font-size: var(--fs-xs); background: none; cursor: pointer;
    border: 1px solid var(--border); border-radius: var(--radius-sm); color: var(--accent-fg);
    padding: 2px 10px; transition: border-color .13s;
  }
  .linkbtn:hover { border-color: var(--accent-border); }
  .linkbtn.copied { color: var(--ok); border-color: var(--ok-border); animation: pop-in .3s ease; }
  @media (prefers-reduced-motion: reduce) { .linkbtn.copied { animation: none; } }
  .del {
    font: inherit; font-size: var(--fs-xs); background: none; cursor: pointer;
    border: 1px solid var(--border); border-radius: var(--radius-sm); color: var(--text);
    padding: 2px 10px; transition: border-color .13s, color .13s;
  }
  .del:hover { border-color: var(--danger); color: var(--danger); }

  .nodes { margin-top: var(--space-6); }
  .nodes-head { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 6px 10px; margin-bottom: var(--space-2); }
  .nodes-head h2 { font-size: var(--fs-h3); margin: 0; }
  .nodes > .hint { margin: 0 0 var(--space-3); font-size: var(--fs-xs); color: var(--text); }

  /* Routing choice: auto-fastest vs only-my-nodes, as two radio cards. */
  .routing { display: flex; flex-direction: column; gap: var(--space-2); margin-bottom: var(--space-3); }
  .routeopt {
    display: flex; align-items: flex-start; gap: var(--space-2);
    padding: var(--space-3); border: 1px solid var(--border); border-radius: var(--radius-sm);
    background: var(--social-bg); cursor: pointer; transition: border-color .13s;
  }
  .routeopt.sel { border-color: var(--accent-border); }
  .routeopt.disabled { opacity: 0.55; cursor: not-allowed; }
  .routeopt input { margin-top: 2px; flex: none; accent-color: var(--accent); }
  .ropt-text { display: flex; flex-direction: column; gap: 2px; }
  .ropt-text b { color: var(--text-h); font-weight: 600; font-size: var(--fs-sm); }
  .ropt-text .hint { color: var(--text); font-size: var(--fs-xs); }

  .nname {
    font: inherit; font-size: var(--fs-xs); font-weight: 600; color: var(--text-h);
    background: none; border: 0; padding: 0; cursor: pointer; text-decoration: underline dotted; text-underline-offset: 2px;
  }
  .nname:hover { color: var(--accent-fg); }
  .rename {
    font: inherit; font-size: var(--fs-xs); padding: 2px 8px; width: 14ch; max-width: 45vw;
    border: 1px solid var(--accent); border-radius: var(--radius-sm); background: var(--surface); color: var(--text-h);
  }

  .add-form { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2); margin-bottom: var(--space-3); }
  .add-form input {
    padding: var(--space-2) var(--space-3); border-radius: var(--radius-sm); border: 1px solid var(--border);
    font: inherit; font-size: var(--fs-xs); background: var(--social-bg); color: var(--text-h);
  }

  .token-reveal { display: flex; flex-direction: column; gap: var(--space-3); margin-bottom: var(--space-3); }
  .token-reveal .hint { margin: 0; font-size: var(--fs-xs); color: var(--text); }
  .token-reveal .ports-note { padding-top: var(--space-2); border-top: 1px solid var(--border); }

  .nodelist { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--space-2); }
  .nodelist li {
    display: flex; flex-wrap: wrap; align-items: center; gap: 6px 12px;
    padding: var(--space-3); border: 1px solid var(--border); border-radius: var(--radius-sm);
    background: var(--social-bg); font-size: var(--fs-xs);
  }
  .dot { width: 9px; height: 9px; border-radius: 50%; background: var(--text); opacity: .4; flex: none; }
  .dot.on { background: var(--accent); opacity: 1; }
  .nid { font-family: ui-monospace, monospace; color: var(--text-h); }
  .nstat { color: var(--text); }
  .probe { font-size: var(--fs-xs); }
  .probe.ok { color: var(--ok); }
  .probe.bad { color: var(--danger); }
  .chk {
    font: inherit; font-size: var(--fs-xs); background: none; cursor: pointer; margin-inline-start: auto;
    border: 1px solid var(--border); border-radius: var(--radius-sm); color: var(--text);
    padding: 2px 10px; transition: border-color .13s, color .13s;
  }
  .chk:hover:not(:disabled) { border-color: var(--accent-border); color: var(--text-h); }
  .chk:disabled { opacity: .6; cursor: default; }

  @media (max-width: 520px) {
    .exp { margin-inline-start: 0; }
  }
</style>

<script lang="ts">
  // 配对传输留在服务器上的加密副本，以及释放它们的控件。
  //
  // 为什么在 /me 的用量表旁边，而不是配对卡片上：这不是一次传输的状态，是**账户
  // 的存储**。配对码那张卡说的是"这次传输怎么样了"，而这里的东西是那次传输结束
  // 之后还留着的字节——它计入套餐的存储上限、影响下一次上传能不能过闸，属于
  // 用量那一栏的语义。放在配对卡片上还有一层坏处：那张卡是"正在传"的时候才在场，
  // 而这些副本恰恰是在传完之后才成为问题。
  //
  // 组件独立而不是塞进 QuotaMeters：QuotaMeters 是纯展示的两条进度条，这里有取数、
  // 破坏性确认、冲突态和刷新副作用；把两者揉在一起，会让一个"读不到用量就整块不
  // 渲染"的组件同时承担删除动作的正确性。位置上紧贴它，语义上属于同一片区域。
  //
  // 空列表**不渲染任何东西**。绝大多数账户永远不会有这种存储，给他们看一句"没有"
  // 只是噪音；而一旦有了，它就出现在存储条正下方——这正是"被计费却看不见"这件事
  // 该被看见的时刻。
  import { lang, messages, type Messages } from "./i18n.svelte";
  import { session } from "./auth.svelte";
  import { formatSize } from "./format";
  import { confirmDialog } from "./confirm-dialog.svelte";
  import { invalidateUsage } from "./usage.svelte";

  const t = $derived<Messages>(messages[lang()]);

  interface Room {
    id: string;
    createdAt: number;
    joinedAt: number;
    objects: number;
    bytes: number;
    // 服务端自己的资格判定。**不要在前端重算**：能不能释放取决于房间里还有没有
    // 在途上传，那是只有服务端看得见的事实，前端重建一遍就会有一份会过时、会
    // 算错的副本——错的那一侧是"把删除按钮摆在一个还在上传的传输旁边"。
    releasable: boolean;
  }
  interface Holdings {
    rooms: Room[];
    totals: { rooms: number; objects: number; bytes: number };
    limit: number;
    truncated: boolean;
  }

  let holdings = $state<Holdings | null>(null);
  let loadError = $state(false);
  // notice 是那块 aria-live 区域里唯一的内容：成功、冲突、失败共用一句话的位置，
  // 因为同一时刻只可能发生其中一件事。空串 = 无话可说。
  let notice = $state("");
  let noticeIsError = $state(false);
  // 正在释放的房间 id。按钮据此禁用，防止同一行被连点两次——第二次是幂等的
  // （服务端对已释放的房间回 200），但界面上不该出现两个都在转的按钮。
  let releasing = $state("");
  // 单调递增的取数代号：换账号、或一次释放之后重新取数时，把在途的旧响应作废。
  let gen = 0;

  // 载入中和空列表都渲染成"什么都没有"，这不是偷懒：这块区域的存在本身就是信息
  // （"你有一批看不见却在计费的存储"），所以在服务端确认之前它必须不在场。一个
  // 先出现再消失的骨架屏，会让绝大多数、本来就没有这种存储的账户看到一次假警报。
  async function load(uid: string, mine: number): Promise<void> {
    try {
      const res = await fetch("/api/pair-rooms", { credentials: "include" });
      if (!stillCurrent(uid, mine)) return;
      if (!res.ok) { holdings = null; loadError = true; return; }
      holdings = (await res.json()) as Holdings;
      loadError = false;
    } catch {
      // “未知”不能伪装成“没有”：这块界面的目的正是让永久计费的密文可见；静默
      // 留白会在服务暂时失败时重新制造同一个问题。只报告读取失败，不猜是否有房间。
      if (stillCurrent(uid, mine)) { holdings = null; loadError = true; }
    }
  }

  function stillCurrent(uid: string, mine: number): boolean {
    return mine === gen && (session().user?.id ?? "") === uid;
  }

  // 跟着会话走，和 QuotaMeters 同款守卫：/me 页在登出后不会立刻卸载，无条件写
  // holdings 会把上一个账号的存储画出来。
  $effect(() => {
    const uid = session().user?.id ?? "";
    const mine = ++gen;
    holdings = null;
    loadError = false;
    notice = "";
    releasing = "";
    if (!uid) return;
    void load(uid, mine);
  });

  // 只显示房间 id 的前 8 位。它是不透明的实例 id，不是配对码，也不授权任何东西；
  // 截断只是为了让一行读得完。
  const shortID = (id: string) => id.slice(0, 8);

  const dateOf = (unix: number) => new Date(unix * 1000).toLocaleDateString(lang());

  async function release(room: Room): Promise<void> {
    const uid = session().user?.id ?? "";
    if (!uid || releasing) return;
    // 服务端说不能释放就不问：把确认弹窗弹给一个注定 409 的操作，是在教用户
    // 无视确认弹窗。
    if (!room.releasable) { fail(t.pairStorage.errBusy); return; }
    // 先问，问完了才动。取消这条路径一个字节都不改，也不清掉上一次留在屏幕上
    // 的提示——那句话说的是上一次操作的事实，没有被推翻。
    if (!(await confirmDialog(t.pairStorage.confirm, t.pairStorage.confirmAction))) return;
    if ((session().user?.id ?? "") !== uid) return; // 弹窗开着的时候换了账号
    releasing = room.id;
    notice = "";
    let res: Response;
    try {
      res = await fetch(`/api/pair-rooms/${encodeURIComponent(room.id)}`, {
        method: "DELETE",
        credentials: "include",
      });
    } catch {
      releasing = "";
      fail(t.pairStorage.errFailed);
      return;
    }
    releasing = "";
    if ((session().user?.id ?? "") !== uid) return;
    if (res.status === 409) {
      // 冲突是有具体原因的，照实说。**绝不乐观地把这一行从列表里减掉**：什么都
      // 没有被删除，列表里的数字仍然成立。
      const why = await conflictReason(res);
      fail(why === "pair_room_waiting" ? t.pairStorage.errWaiting : t.pairStorage.errBusy);
      await refresh(uid);
      return;
    }
    if (!res.ok) { fail(t.pairStorage.errFailed); return; }
    notice = t.pairStorage.released;
    noticeIsError = false;
    // 重新取数，而不是在本地把这一行删掉：真相在服务端，而且释放会改变存储用量，
    // 上面那条存储条必须跟着变（invalidateUsage 会让它重取）。乐观地在本地减一个
    // 数字，正是"界面说删掉了、账单说没有"的来源。
    invalidateUsage();
    await refresh(uid);
  }

  async function conflictReason(res: Response): Promise<string> {
    try {
      const body = (await res.json()) as { error?: string };
      return body.error ?? "";
    } catch {
      return "";
    }
  }

  async function refresh(uid: string): Promise<void> {
    const mine = ++gen;
    await load(uid, mine);
  }

  function retryLoad(): void {
    const uid = session().user?.id ?? "";
    if (!uid) return;
    loadError = false;
    void refresh(uid);
  }

  function fail(msg: string): void {
    notice = msg;
    noticeIsError = true;
  }

  const rooms = $derived(holdings?.rooms ?? []);
  const totals = $derived(holdings?.totals ?? { rooms: 0, objects: 0, bytes: 0 });
</script>

{#if session().user && (rooms.length > 0 || notice || loadError)}
  <section class="pairstore">
    <h2>{t.pairStorage.title}</h2>
    {#if loadError}
      <p class="loaderr" role="alert">{t.pairStorage.loadFailed}</p>
      <button class="retry" type="button" onclick={retryLoad}>{t.pairStorage.retry}</button>
    {:else}
      <p class="intro">{t.pairStorage.intro}</p>
      <p class="noname">{t.pairStorage.noName}</p>

    {#if rooms.length > 0}
      <p class="totals">{t.pairStorage.totals(totals.rooms, formatSize(totals.bytes))}</p>
      <ul class="roomlist">
        {#each rooms as r (r.id)}
          <li>
            <span class="rid">#{shortID(r.id)}</span>
            <span class="objs">{t.pairStorage.objects(r.objects)}</span>
            <span class="size">{formatSize(r.bytes)}</span>
            <span class="since">{t.pairStorage.since(dateOf(r.joinedAt || r.createdAt))}</span>
            <button
              class="rel"
              type="button"
              disabled={!r.releasable || releasing === r.id}
              title={r.releasable ? undefined : t.pairStorage.busy}
              aria-label={t.pairStorage.releaseAria(shortID(r.id))}
              onclick={() => release(r)}
            >{t.pairStorage.release}</button>
            {#if !r.releasable}
              <span class="busy">{t.pairStorage.busy}</span>
            {/if}
          </li>
        {/each}
      </ul>
      {#if holdings?.truncated}
        <p class="trunc">{t.pairStorage.truncated(rooms.length)}</p>
      {/if}
    {/if}
    {/if}

    <!-- 活动区域一直在场（内容为空也在），否则第一次出现提示时屏幕阅读器读不到
         它——插入一个本来不存在的 aria-live 容器不会触发播报。 -->
    <p class="notice" class:err={noticeIsError} role="status" aria-live="polite">{notice}</p>
  </section>
{/if}

<style>
  /* 和 QuotaMeters 的 .quota 同款卡片：它就在那块的正下方，是同一片"用量"区域。 */
  .pairstore {
    margin-top: var(--space-3);
    padding: var(--space-5) var(--space-4);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--social-bg);
  }
  .pairstore h2 { margin: 0; font-size: var(--fs-h3); color: var(--text-h); }
  .intro { margin: var(--space-3) 0 0; color: var(--text); font-size: var(--fs-xs); }
  .noname, .trunc { margin: var(--space-2) 0 0; color: var(--text); font-size: var(--fs-xs); }
  .totals { margin: var(--space-3) 0 0; color: var(--text-h); }
  .roomlist { list-style: none; margin: var(--space-3) 0 0; padding: 0; }
  .roomlist li {
    display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2);
    padding: var(--space-2) 0; border-top: 1px solid var(--border);
  }
  .rid { font-family: var(--mono, monospace); color: var(--text); }
  .objs, .size, .since, .busy { color: var(--text); font-size: var(--fs-xs); }
  /* 同 MePage 的 .del：破坏性动作用同一套朴素外观，不做成主按钮。 */
  .rel {
    margin-inline-start: auto;
    font: inherit; font-size: var(--fs-xs); background: none; cursor: pointer;
    border: 1px solid var(--border); border-radius: var(--radius-sm); color: var(--text);
    padding: 2px 10px; transition: border-color .13s, color .13s;
  }
  .rel:hover:not([disabled]) { border-color: var(--danger); color: var(--danger); }
  .rel[disabled] { opacity: .5; cursor: not-allowed; }
  .notice { margin: var(--space-3) 0 0; min-height: 1em; color: var(--text); font-size: var(--fs-xs); }
  .notice.err { color: var(--danger); }
  .loaderr { margin: var(--space-3) 0 0; color: var(--danger); font-size: var(--fs-xs); }
  .retry { margin-top: var(--space-2); }
</style>

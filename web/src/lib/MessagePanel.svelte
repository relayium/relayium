<script lang="ts">
  // 消息面板。**纯展示 + 纯回调**，和 DeviceRadar 一样的分工：状态机在
  // text-session.svelte.ts 里，这里一个字节的会话状态都不持有，所以它能在没有
  // WebRTC 的情况下被完整测。
  //
  // 关于正文渲染，这里做的事情少得刻意：一个转义过的文本节点，pre-wrap，dir="auto"。
  // **不**做链接化、不做 Markdown、不做代码高亮、不做任何预览——每一样都是"把解析器
  // 对着敌方输入跑一遍"，而其中链接化还会顺手把发送方选的东西变成一个可点击目标。
  import { lang, messages, type Messages } from "./i18n.svelte";
  import { copyFeedback } from "./clipboard.svelte";
  import { textByteLength, TEXT_MAX_BYTES } from "./text-wire";
  import type { TextMessage, TextStatus, TextErrorKey } from "./text-session.svelte";
  import type { ConnPath } from "./webrtc";

  let {
    status, peerName, sasCode, path, history, errorKey, prefill = "", revealTarget = $bindable(),
    onSend, onAccept, onReject, onClear, onEnd, onPrefillConsumed,
  }: {
    status: TextStatus;
    peerName: string;
    sasCode: string;
    path?: ConnPath;
    history: TextMessage[];
    errorKey: TextErrorKey;
    prefill?: string;
    revealTarget?: HTMLElement;
    onSend: (body: string) => void;
    onAccept: () => void;
    onReject: () => void;
    onClear: () => void;
    onEnd: () => void;
    onPrefillConsumed?: () => void;
  } = $props();

  const t = $derived<Messages>(messages[lang()]);
  const copied = copyFeedback();

  let draft = $state("");
  let lastPrefill = "";
  $effect(() => {
    // 粘贴过来的文本只灌进草稿框，**不发送**：粘贴不是同意发送，而粘贴常常是手误。
    if (prefill && prefill !== lastPrefill) {
      lastPrefill = prefill;
      draft = prefill;
      onPrefillConsumed?.();
    }
  });

  // 字节，不是字符。计数器显示的必须就是限制在比的那个数，否则一条中文或 emoji 消息
  // 会在用户被告知"还装得下"之后才被拒。
  const used = $derived(textByteLength(draft));
  const overLimit = $derived(used > TEXT_MAX_BYTES);
  const canSend = $derived(status === "open" && !overLimit && draft !== "");

  function stateText(m: Messages, s: TextStatus): string {
    switch (s) {
      case "connecting": return m.text.connecting;
      case "waitingAccept": return m.text.waitingAccept;
      case "open": return m.text.open_;
      case "ended": return m.text.ended;
      case "failed": return m.text.failed;
      case "refused": return m.text.refused;
      case "unsupported": return m.text.unsupported;
      case "peerBusy": return m.text.peerBusy;
      default: return ""; // idle / incomingRequest render their own copy
    }
  }
  function pathLabel(m: Messages, p: ConnPath): string {
    return p === "lan" ? m.pathLan : p === "relay" ? m.pathRelay : m.pathP2p;
  }

  function submit() {
    if (!canSend) return;
    onSend(draft); // NOT draft.trim() — the content is the content
    draft = "";
  }

  function keydown(e: KeyboardEvent) {
    // 回车换行。这个功能的全部意义就是保留多行，所以"回车即发送"在这里是错的默认值。
    if (e.key !== "Enter" || !(e.metaKey || e.ctrlKey)) return;
    e.preventDefault();
    submit();
  }
</script>

<section class="ui-card ui-stack msgpanel">
  <h2>{t.text.panelTitle}</h2>

  {#if status === "incomingRequest"}
    <!-- 这里一个字的正文都不渲染，而且也解不开：会话的 onmessage 在 accept() 之前
         根本没挂上（见 text-session）。SAS 先到屏幕上，消息才可能到。 -->
    <p class="req">{t.text.requestHead(peerName)}</p>
    <div class="sas" bind:this={revealTarget}>{t.codeLabel} <code>{sasCode}</code> — {t.text.sasCompare}</div>
    <div class="act">
      <button type="button" class="btn btn-primary" onclick={onAccept}>{t.text.accept}</button>
      <button type="button" class="btn btn-ghost" onclick={onReject}>{t.text.reject}</button>
    </div>
  {:else}
    <div class="sess">
      <span class="pname">{t.text.peer(peerName)}</span>
      <span class="state">{stateText(t, status)}</span>
      {#if path}
        <span class="path path-{path}"><i class="dot" aria-hidden="true"></i>{pathLabel(t, path)}</span>
      {/if}
    </div>
    {#if sasCode && status !== "ended"}
      <div class="sas" bind:this={revealTarget}>{t.codeLabel} <code>{sasCode}</code> — {t.text.sasCompare}</div>
    {/if}

    <ol class="msglist" role="log" aria-live="polite">
      {#each history as m (m.id)}
        <li class="msg" class:out={m.dir === "out"} class:failed={m.failed}>
          <span class="who">
            {m.dir === "out" ? t.text.you : t.text.peer(peerName)}
            {#if m.failed}<span class="failed-label">{t.status.sendFail}</span>{/if}
          </span>
          <time>{new Date(m.at).toLocaleTimeString()}</time>
          <!-- 转义过的文本节点。dir="auto" 让阿拉伯语正文在英文界面下也读得对，
               而界面本身的方向由 dir(lang()) 管，两者互不干涉。 -->
          <span class="msg-body" dir="auto">{m.body}</span>
          <button
            type="button"
            class="btn btn-link copy"
            class:copied={copied.value === String(m.id)}
            onclick={() => copied.copy(m.body, String(m.id))}
          >{copied.value === String(m.id) ? t.text.copied : t.text.copy}</button>
        </li>
      {:else}
        <li class="empty">{t.text.emptyHistory}</li>
      {/each}
    </ol>

    {#if status === "open"}
      <label class="sr-only" for="msg-compose">{t.text.panelTitle}</label>
      <textarea
        id="msg-compose"
        bind:value={draft}
        onkeydown={keydown}
        autocomplete="off"
        spellcheck="false"
        rows="4"
        aria-describedby="msg-bytes msg-hint"
        placeholder={t.text.composePlaceholder}
      ></textarea>
      <div class="compose-foot">
        <!-- 有意不加 aria-live：每敲一个键都变的值放进 live region 会把读屏器灌满。
             DownloadPage 里已经把这条反模式写下来了。 -->
        <span class="byte-count" id="msg-bytes" class:over={overLimit}>{t.text.byteCount(used, TEXT_MAX_BYTES)}</span>
        <span class="hint" id="msg-hint">{t.text.sendHint}</span>
        <button type="button" class="btn btn-primary send" disabled={!canSend} onclick={submit}>{t.text.send}</button>
      </div>
      {#if overLimit}
        <p class="over-note">{t.text.tooLong} {t.text.useFileInstead}</p>
      {/if}
    {/if}

    {#if errorKey}<p class="bad">{t.text[errorKey]}</p>{/if}
    <p class="note">{t.text.ephemeralNote}</p>
    <p class="note">{t.text.clipboardNote}</p>
    <div class="act">
      <button type="button" class="btn btn-ghost clear" onclick={onClear}>{t.text.clear}</button>
      {#if status === "open"}
        <button type="button" class="btn btn-ghost end" onclick={onEnd}>{t.startOver}</button>
      {/if}
    </div>
  {/if}
</section>

<style>
  /* 卡片外壳（.ui-card）、SAS 盒子（.sas）、链路徽章（.path/.dot）现在都来自
     app.css 里的共享原语。以前这三样在本组件里要么重复、要么根本没写——`.card`
     只存在于 App.svelte 的**局部**样式里，跨不过组件边界，所以这个面板一直是没
     边框、没背景、标题按 30px 营销尺寸渲染的。 */
  .msgpanel { text-align: start; margin-block-end: var(--space-4); }
  .sas {
    scroll-margin-block-start: calc(64px + var(--space-3));
    overflow-anchor: none;
  }
  .req { margin: 0; font-size: var(--fs-h3); color: var(--text-h); }
  .sess { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2); font-size: var(--fs-sm); }
  .sess .pname { font-weight: 600; color: var(--text-h); }
  .sess .state { color: var(--text); }

  /* 消息列表在自己的盒子里滚动，页面本身永远不会横向滚动。 */
  .msglist {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    max-height: 48vh;
    overflow-y: auto;
    overflow-x: hidden;
  }
  .msg {
    display: grid;
    grid-template-columns: auto 1fr auto;
    grid-template-areas: "who time copy" "body body body";
    gap: var(--space-1) var(--space-2);
    padding: var(--space-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--surface);
  }
  .msg.out { background: var(--accent-bg); border-color: var(--accent-border); }
  /* Keep a solid danger edge as a redundant visual cue; .failed-label carries
     the localized, non-colour-only state for sighted and assistive-tech users. */
  .msg.failed { border-color: var(--danger); }
  .who { grid-area: who; display: inline-flex; flex-wrap: wrap; gap: var(--space-1); font-size: var(--fs-xs); font-weight: 600; color: var(--text-h); }
  .failed-label { color: var(--danger); }
  time { grid-area: time; font-size: var(--fs-xs); color: var(--text); opacity: 0.7; }
  .copy { grid-area: copy; font-size: var(--fs-xs); }

  /*
   * 正文渲染的全部内容。pre-wrap 让被完整保留下来的空白真的显示出来（缩进、空行、
   * 制表符），而不是被 HTML 折叠掉；overflow-wrap: anywhere 让一行没有空格的超长
   * 内容在这个盒子里断开，而不是把页面推宽。这两条都是内容保真的一部分，不是装饰。
   */
  .msg-body {
    grid-area: body;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    font-family: var(--mono);
    font-size: var(--fs-sm);
    color: var(--text-h);
  }
  .empty { font-size: var(--fs-sm); color: var(--text); opacity: 0.8; }

  textarea {
    inline-size: 100%;
    box-sizing: border-box;
    resize: vertical;
    padding: var(--space-2);
    /* 输入框是控件，边框要过 3:1；--border 在暗色下是 1.36:1。 */
    border: 1px solid var(--control-border);
    border-radius: var(--radius-sm);
    background: var(--surface);
    color: var(--text-h);
    font-family: var(--mono);
    font-size: var(--fs-sm);
    /* 草稿本身也是多行内容，输入框里就得按多行显示。 */
    white-space: pre-wrap;
  }
  .compose-foot { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2); }
  .byte-count { font-size: var(--fs-xs); font-variant-numeric: tabular-nums; color: var(--text); }
  .byte-count.over { color: var(--danger); font-weight: 600; }
  .hint { font-size: var(--fs-xs); color: var(--text); opacity: 0.75; flex: 1; }
  .compose-foot .send { margin-inline-start: auto; }
  .over-note { margin: 0; font-size: var(--fs-sm); color: var(--danger); }
  .bad { margin: 0; font-size: var(--fs-sm); color: var(--danger); }
  .note { margin: 0; font-size: var(--fs-xs); color: var(--text); opacity: 0.75; }
  .act { display: flex; flex-wrap: wrap; gap: var(--space-2); }

  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
    border: 0;
  }
  /* 44px 触控目标现在由 app.css 里 `.btn` 的全局 coarse-pointer 规则统一提供
     （这三个控件都是 .btn），不再每个组件抄一份。 */
</style>

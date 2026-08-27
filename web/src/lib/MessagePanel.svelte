<script lang="ts">
  // 消息面板。**纯展示 + 纯回调**，和 DeviceRadar 一样的分工：状态机在
  // mixed-text-session.svelte.ts 里，形状在 text-model.ts 里；这里一个字节的会话
  // 状态都不持有，所以它能在没有 WebRTC 的情况下被完整测。
  //
  // 关于正文渲染，这里做的事情少得刻意：一个转义过的文本节点，pre-wrap，dir="auto"。
  // **不**做链接化、不做 Markdown、不做代码高亮、不做任何预览——每一样都是"把解析器
  // 对着敌方输入跑一遍"，而其中链接化还会顺手把发送方选的东西变成一个可点击目标。
  //
  // On a unified (`link/1`) workspace this panel stops being "the text card" and
  // becomes the peer's whole activity surface, so it also carries the file and
  // folder attachment controls — the unified workspace renders no peer card to
  // put them on. That mode is entirely opt-in (`unified`), and every default
  // below reproduces the legacy panel exactly: the legacy surface is what ships.
  //
  // Attachment stays a pure affordance here too. The component never reads a
  // File, never touches bytes and never decides anything about a transfer; it
  // hands the caller the change event and the caller owns everything after it.
  import { lang, messages, type Messages } from "./i18n.svelte";
  import { copyFeedback } from "./clipboard.svelte";
  import { textByteLength, TEXT_MAX_BYTES } from "./text-wire";
  import type { TextMessage, TextStatus, TextErrorKey } from "./text-model";
  import type { ConnPath } from "./webrtc";
  import Icon from "./Icon.svelte";

  let {
    status, peerName, sasCode, path, history, errorKey, prefill = "", showSas = true,
    unified = false, attachmentsEnabled = false, folderPickSupported = false,
    revealTarget = $bindable(),
    onSend, onAccept, onReject, onClear, onEnd, onPrefillConsumed,
    onPickFiles, onPickFolder, onRestart,
  }: {
    status: TextStatus;
    peerName: string;
    sasCode: string;
    path?: ConnPath;
    /** False on a unified (`link/1`) workspace: the link owns exactly one SAS and
     *  the workspace header already renders it. A second copy here would present
     *  the same authentication step twice and invite a "which one do I compare?"
     *  mistake. The panel then renders NO verification code at all. */
    showSas?: boolean;
    /** Unified `link/1` workspace mode. Off by default, and off is the legacy
     *  panel down to the last selector. */
    unified?: boolean;
    /** Whether the caller's peer can accept another intent right now — the ONLY
     *  input to whether attachment is usable. Deliberately not derived from the
     *  text status: "is this conversation open?" and "can this link take another
     *  file?" are different questions, and answering the second with the first
     *  is what produced the old greyed-out picker during a live conversation.
     *  The caller turns it off for teardown or a stale workspace. */
    attachmentsEnabled?: boolean;
    /** iOS/iPadOS Safari has no folder picker (see platform.ts), so the caller
     *  tells the panel whether the control would do anything at all. */
    folderPickSupported?: boolean;
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
    /** The raw change event of the hidden <input>, forwarded untouched. The
     *  panel does not normalise, filter or read the FileList: `e.currentTarget`
     *  is the input, `.files` is what the user picked, and both the picked-file
     *  mapping and the input reset belong to the caller that owns the transfer. */
    onPickFiles?: (e: Event) => void;
    onPickFolder?: (e: Event) => void;
    /** Unified terminal states offer this instead of silently reopening. A dead
     *  conversation reopening by itself would re-run consent on the peer without
     *  anyone asking for it. */
    onRestart?: () => void;
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

  // 统一模式下草稿框在 connecting/waitingAccept 就已经在屏幕上了：会话还在建立时
  // 输入框消失，用户打的字就"看起来没了"（其实 draft 还在，但看不见等于丢了）。
  // 只是**显示**，不是允许发送——canSend 仍然要求 status === "open"。
  const composing = $derived(
    unified ? status === "open" || status === "connecting" || status === "waitingAccept" : status === "open",
  );
  // 终局态。会话没了，历史和附件还在，但重开必须是用户按下去的一次动作。
  const terminal = $derived(
    status === "ended" || status === "failed" || status === "refused" ||
    status === "unsupported" || status === "peerBusy",
  );
  // 同意界面之前不显示附件，除非调用方明确开了：那个屏幕上唯一该被理解的事情是
  // "要不要接受这条会话"。其余状态下附件一直在，禁用与否只看 attachmentsEnabled。
  const showAttachments = $derived(
    unified && !!onPickFiles && (status !== "incomingRequest" || attachmentsEnabled),
  );
  const showFolderPick = $derived(folderPickSupported && !!onPickFolder);

  // 新的在最上面。`history` 本身仍然是时间顺序（协议、通知、保留逻辑都靠它），这里
  // 只反转**渲染**：这是一个只增不减的列表，把刚到的那条放在底部就等于每来一条都要
  // 再滚一次，而正在等的那条恰恰是最难够到的那条。终局态和进行中一视同仁。
  const shown = $derived(history.slice().reverse());

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

<!-- 隐藏的 file input + 可见 <label> 按钮，和 peer card 上那两个是同一套原语：
     .file-pick-input 把 input 裁到 1px（焦点环由 label 画），.btn 提供全局的 44px
     coarse 触控下限，:disabled 对 <label> 不生效所以停用态走 .is-disabled。
     aria-labelledby 指向那段可见文案本身，所以读屏器念出来的名字就是屏幕上写的。 -->
{#snippet attachments()}
  <div class="attach">
    <label class="btn btn-secondary btn-sm" class:is-disabled={!attachmentsEnabled}>
      <span class="at-icon" aria-hidden="true"><Icon name="file" /></span><span class="at-label" id="msg-attach-file">{t.sendFile}</span>
      <input
        class="file-pick-input attach-file"
        type="file"
        multiple
        disabled={!attachmentsEnabled}
        aria-labelledby="msg-attach-file"
        onchange={(e) => onPickFiles?.(e)}
      />
    </label>
    {#if showFolderPick}
      <label class="btn btn-secondary btn-sm" class:is-disabled={!attachmentsEnabled}>
        <span class="at-icon" aria-hidden="true"><Icon name="folder" /></span><span class="at-label" id="msg-attach-folder">{t.sendFolder}</span>
        <input
          class="file-pick-input attach-folder"
          type="file"
          webkitdirectory
          multiple
          disabled={!attachmentsEnabled}
          aria-labelledby="msg-attach-folder"
          onchange={(e) => onPickFolder?.(e)}
        />
      </label>
    {/if}
  </div>
{/snippet}

<section class="ui-card ui-stack msgpanel">
  {#if !showSas}
    <!-- 统一工作区里 SAS 只在顶部那一处渲染，这个面板没有验证框可滚。用一个零高度
         锚点接住那次一次性 reveal，指向会话顶部——和 App.svelte 的活动锚点同一套做法。 -->
    <div class="reveal-anchor" bind:this={revealTarget} aria-hidden="true"></div>
  {/if}
  <h2>{t.text.panelTitle}</h2>

  {#if status === "incomingRequest"}
    <!-- 这里一个字的正文都不渲染，而且也解不开：会话在 accept() 之前不投递任何正文
         （见 mixed-text-session）。SAS 先到屏幕上，消息才可能到。 -->
    <p class="req">{t.text.requestHead(peerName)}</p>
    {#if showSas}
      <div class="sas" bind:this={revealTarget}>{t.codeLabel} <code>{sasCode}</code> — {t.text.sasCompare}</div>
    {/if}
    <div class="act">
      <button type="button" class="btn btn-primary" onclick={onAccept}>{t.text.accept}</button>
      <button type="button" class="btn btn-ghost" onclick={onReject}>{t.text.reject}</button>
    </div>
    <!-- After the two choices, never before them: the pending decision is what
         this screen is for, and nothing here is focused or otherwise pre-armed. -->
    {#if showAttachments}{@render attachments()}{/if}
  {:else}
    <div class="sess">
      <span class="pname">{t.text.peer(peerName)}</span>
      <span class="state">{stateText(t, status)}</span>
      {#if path}
        <span class="path path-{path}"><i class="dot" aria-hidden="true"></i>{pathLabel(t, path)}</span>
      {/if}
    </div>
    {#if sasCode && status !== "ended" && showSas}
      <div class="sas" bind:this={revealTarget}>{t.codeLabel} <code>{sasCode}</code> — {t.text.sasCompare}</div>
    {/if}

    <!-- The live region is this wrapper, not the list itself: ARIA does not
         allow role="log" on <ol>, and setting it there also overrode the list
         semantics, orphaning every <li> inside. Announcements behave the same
         from a wrapper — a live region announces changes anywhere in its subtree. -->
    <div class="msglog" role="log" aria-live="polite">
      <ol class="msglist">
        {#each shown as m (m.id)}
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
    </div>

    {#if composing}
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
      <!-- 附件在草稿框和 Send 之间：Tab 顺序就是"写字 → 加附件 → 发送"。 -->
      {#if showAttachments}{@render attachments()}{/if}
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
    {:else if showAttachments}
      <!-- A conversation that ended does not end the link. Files still go, so the
           attachment controls stay exactly where they were. -->
      {@render attachments()}
    {/if}

    {#if errorKey}<p class="bad">{t.text[errorKey]}</p>{/if}
    <p class="note">{t.text.ephemeralNote}</p>
    <p class="note">{t.text.clipboardNote}</p>
    <div class="act">
      {#if unified && terminal && onRestart}
        <!-- 明确的一次动作，绝不自动重开：重开会在对方那边再弹一次同意提示，那必须
             是有人按下去的结果。文案复用"开始会话"那颗按钮的既有翻译。 -->
        <button type="button" class="btn btn-primary restart" onclick={onRestart}>{t.text.open}</button>
      {/if}
      <button type="button" class="btn btn-ghost clear" onclick={onClear}>{t.text.clear}</button>
      <!-- 统一工作区里断开连接属于 WorkspaceHeader。这里再放一颗"重新开始"只会拆掉
           文本这一条腿，把一个仍然连着、仍然能传文件的工作区显示成坏掉的样子。
           传统模式一字不改。 -->
      {#if status === "open" && !unified}
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
  /* Zero-height reveal anchor for the no-SAS (unified workspace) case. No
     scroll-margin: clearing the sticky workspace header that owns the SAS is
     App's job, and it does it by measuring that header at scroll time — its
     height is not a constant a stylesheet can know. The negative margin cancels
     the .ui-stack gap a zero-height flex item would otherwise still add above
     the title. */
  .reveal-anchor {
    block-size: 0;
    margin-block-end: calc(-1 * var(--space-3));
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
  time { grid-area: time; font-size: var(--fs-xs); color: var(--text); }
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
  /* No opacity on any of these: --text IS the secondary tier (5.73:1 on white),
     and multiplying it by 0.7–0.8 dropped the timestamp, the empty state, the
     composer hint and both privacy notes to 3.3–3.7:1. Size already carries the
     hierarchy. */
  .empty { font-size: var(--fs-sm); color: var(--text); }

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
  .hint { font-size: var(--fs-xs); color: var(--text); flex: 1; }
  .compose-foot .send { margin-inline-start: auto; }
  /* 附件按钮行。和 peer card 上那一行同样的排布：图标不压缩，文案可以在窄屏和
     长翻译（de/pt）下换行而不是把按钮撑出卡片。 */
  .attach { display: flex; flex-wrap: wrap; gap: var(--space-2); }
  .at-icon { flex: none; }
  .at-label { min-inline-size: 0; overflow-wrap: anywhere; }
  .over-note { margin: 0; font-size: var(--fs-sm); color: var(--danger); }
  .bad { margin: 0; font-size: var(--fs-sm); color: var(--danger); }
  .note { margin: 0; font-size: var(--fs-xs); color: var(--text); }
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

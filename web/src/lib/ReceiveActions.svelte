<script lang="ts">
  import { lang, messages, type Messages } from "./i18n.svelte";
  import { formatSize } from "./format";
  import { warnsAboutMemory, asksWhereToSave, type FileMetaLite } from "./filesink";

  /**
   * 接收请求卡片的收/拒按钮，外加一条大批次的内存提示。
   *
   * 提示为什么在这里：接受这一下就是用户手势，pickSaveTarget 紧接着在同一个
   * 手势里开保存选择器。要拦就得拦在按下之前 —— 这是唯一还知道「这批多大」
   * 且一个字节都没开始收的时刻。
   *
   * 这条路比异步下载页那条更危险：req.files 带 path（文件夹拖放产出的），没有
   * File System Access API 时 pickSaveTarget 走 ZipWriter，整批攒内存还要复制
   * 一份，峰值约 2× 批次总量。warnsAboutMemory 已经把这个 2× 算进去了。
   *
   * 提示不是硬拦：桌面 Firefox 上内存管够的用户比我们更清楚自己的情况。但默认
   * 不继续 —— 提示状态下「接收」按钮根本不渲染，只有明确的「仍要接收」才走
   * onAccept，「拒绝」升为主按钮。
   *
   * 按钮上方还有一行「点下去会发生什么」：会弹保存位置选择器，还是直接落到
   * 浏览器的下载目录。手机上这一句是必需的，也一定是后者 —— 那条选择器分支在
   * 手机上整条关着（filesink 的 pickersAllowed），所以这句话和实际行为逐字一致。
   *
   * `retry` 是上一次被用户在选择器里取消之后的**再问一次**（桌面独有）。那次取消
   * 在线路上什么都没留下，所以这里不是失败卡片，而是同一张同意卡片换一句话。
   */
  let { files, total, retry = false, onAccept, onReject }: {
    files: FileMetaLite[];
    total: number;
    retry?: boolean;
    onAccept: () => void;
    onReject: () => void;
  } = $props();

  const t = $derived<Messages>(messages[lang()]);

  // 用户已经看过提示并选择继续。组件随接收请求一起挂载/卸载，所以下一个请求
  // 会拿到一个干净的 false，不会继承上一次的决定。
  let forced = $state(false);
  const warn = $derived(!forced && warnsAboutMemory(files, total));
  // 与 pickSaveTarget 实际会走的分支同一套条件（filesink 里同一个函数回答两边）。
  //
  // 传整个 files 而不是 files.length：一个带目录层级的单文件（solo/only.txt）没有
  // 目录选择器时会被打成 ZIP 落到下载目录，而按数量问只会看到「单文件 +
  // showSaveFilePicker 存在」并答「会问你存哪里」—— 卡片承诺了一个永远不会弹出来
  // 的选择器，正是这条文案当初被加进来要解决的那种事故。
  const willAsk = $derived(asksWhereToSave(files));

  function acceptAnyway() {
    forced = true;
    onAccept();
  }
</script>

{#if warn}
  <div class="memwarn" role="alert">
    <p>{t.recvMemWarn(formatSize(total))}</p>
    <div class="actions">
      <button class="btn btn-primary" onclick={onReject}>{t.decline}</button>
      <button class="btn btn-ghost" onclick={acceptAnyway}>{t.recvMemWarnAccept}</button>
    </div>
  </div>
{:else}
  <!-- role="status" 一直在，不是只在 retry 时才加：读屏只播报**已存在**的活动区域
       内部的变化，等到要播报的那一刻才把区域建出来是播不出来的。而「取消之后卡片
       原地换了一句话」正是最需要被播报的那一次变化。 -->
  <p class="savehint" class:retry role="status">
    {retry ? t.recvSaveRetry : willAsk ? t.recvSaveHintPicker : t.recvSaveHintDownload}
  </p>
  <div class="actions">
    <button class="btn btn-primary" onclick={onAccept}>{t.accept}</button>
    <button class="btn btn-ghost" onclick={onReject}>{t.decline}</button>
  </div>
{/if}

<style>
  .actions { display: flex; gap: var(--space-3); }
  .savehint {
    margin: 0 0 var(--space-2); font-size: var(--fs-xs); line-height: 1.5; color: var(--text);
  }
  /* 重问一次不是失败，但也不能和第一次长得一模一样——否则按了取消的用户只会看到
     卡片原地不动。用强调色区分，不用 danger：什么都没坏。 */
  .savehint.retry { color: var(--accent-fg); font-weight: 500; }
  .memwarn {
    font-size: var(--fs-xs); line-height: 1.55; color: var(--text-h);
    padding: var(--space-3) var(--space-4); border-radius: var(--radius-sm);
    background: var(--code-bg); border: 1px solid var(--danger);
  }
  .memwarn p { margin: 0 0 var(--space-3); }
</style>

<script lang="ts">
  import { lang, messages, type Messages } from "./i18n.svelte";
  import { formatSize } from "./format";
  import { warnsAboutMemory, type FileMetaLite } from "./filesink";

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
   */
  let { files, total, onAccept, onReject }: {
    files: FileMetaLite[];
    total: number;
    onAccept: () => void;
    onReject: () => void;
  } = $props();

  const t = $derived<Messages>(messages[lang()]);

  // 用户已经看过提示并选择继续。组件随接收请求一起挂载/卸载，所以下一个请求
  // 会拿到一个干净的 false，不会继承上一次的决定。
  let forced = $state(false);
  const warn = $derived(!forced && warnsAboutMemory(files, total));

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
  <div class="actions">
    <button class="btn btn-primary" onclick={onAccept}>{t.accept}</button>
    <button class="btn btn-ghost" onclick={onReject}>{t.decline}</button>
  </div>
{/if}

<style>
  .actions { display: flex; gap: var(--space-3); }
  .memwarn {
    font-size: var(--fs-xs); line-height: 1.55; color: var(--text-h);
    padding: var(--space-3) var(--space-4); border-radius: var(--radius-sm);
    background: var(--code-bg); border: 1px solid var(--danger);
  }
  .memwarn p { margin: 0 0 var(--space-3); }
</style>

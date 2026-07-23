/**
 * 模态框焦点圈禁的 Svelte action：`<div role="dialog" use:trapFocus>`。
 *
 * 做三件事，缺一个键盘/读屏用户就会走丢：
 *  1. 打开时把焦点移进对话框（否则焦点还留在背后的页面上，读屏根本不知道弹了东西）；
 *  2. Tab / Shift+Tab 在对话框内部循环，不会跑到背景那些此刻点不动的控件上；
 *  3. 关闭时把焦点还给打开它的那个元素——不还的话焦点回到 <body>，键盘用户得从
 *     页面顶部重新 Tab 一遍才能回到原处。
 *
 * 不处理 Escape：各个对话框的取消语义不同（有的要 resolve(false)），留给调用方。
 */
export function trapFocus(node: HTMLElement) {
  const restoreTo = document.activeElement as HTMLElement | null;

  const focusable = (): HTMLElement[] =>
    Array.from(
      node.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    ).filter((el) => el.offsetParent !== null || el === document.activeElement);

  // 对话框自身兜底可聚焦：内容全是纯文本时上面那组会是空的。
  if (!node.hasAttribute("tabindex")) node.tabIndex = -1;
  const first = focusable()[0];
  (first ?? node).focus();

  const onKeydown = (e: KeyboardEvent) => {
    if (e.key !== "Tab") return;
    const items = focusable();
    if (items.length === 0) {
      e.preventDefault(); // 无处可去，也绝不能 Tab 出去
      return;
    }
    const firstEl = items[0];
    const lastEl = items[items.length - 1];
    const active = document.activeElement;
    if (e.shiftKey && (active === firstEl || active === node)) {
      e.preventDefault();
      lastEl.focus();
    } else if (!e.shiftKey && active === lastEl) {
      e.preventDefault();
      firstEl.focus();
    }
  };
  node.addEventListener("keydown", onKeydown);

  return {
    destroy() {
      node.removeEventListener("keydown", onKeydown);
      // 只在焦点还在（已经拆掉的）对话框里时才还原：用户如果自己点去了别处，
      // 把焦点抢回来比不还原更烦人。
      if (restoreTo?.isConnected && (!document.activeElement || node.contains(document.activeElement) || document.activeElement === document.body)) {
        restoreTo.focus();
      }
    },
  };
}

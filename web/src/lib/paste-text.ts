/**
 * What a window-level paste should hand to the message composer, or null to leave
 * the event alone.
 *
 * 这个应用里**一个 paste 处理器都没有**，所以 window 上这个位置是干净的接缝；但配对码
 * 输入框和改名输入框靠的是浏览器原生的粘贴，为了加这个功能把那两处弄坏是笔坏交易，
 * 所以目标落在文本控件上的粘贴不归我们管。
 *
 * 它读的是**粘贴事件本身**，不是 navigator.clipboard.readText()：事件里只有用户刚刚
 * 主动粘贴的那一份，不需要权限，也无法被用来偷看剪贴板。这个应用从来没读过剪贴板，
 * 这里也不开这个头。
 *
 * 不做任何裁剪。它喂的是一个承诺"原样保留"的输入框，在入口处 trim 一下就等于在源头
 * 悄悄破坏那个承诺。
 */
export function pastedText(e: ClipboardEvent): string | null {
  const el = e.target as (HTMLElement & { closest?: (s: string) => Element | null }) | null;
  const tag = el?.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return null;
  // isContentEditable is inherited, so a paste targeting a node *inside* a
  // rich-text region is caught too; closest() is the fallback for environments
  // that do not implement the property.
  if (el?.isContentEditable) return null;
  if (typeof el?.closest === "function" && el.closest("[contenteditable]:not([contenteditable=false])")) return null;
  const text = e.clipboardData?.getData("text/plain");
  return text ? text : null;
}

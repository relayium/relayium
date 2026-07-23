/**
 * "复制 + 显示 ✓ 两秒" 这套反馈的共享实现。
 *
 * 五处（分享链接、配对码/链接、CLI 命令、我的文件里的每一行、debug 面板）各写
 * 一遍的时候，最容易走样的不是那两秒，而是**剪贴板不可用时该怎么办**：
 * navigator.clipboard 在非安全上下文、权限被拒、以及 Safari 的一些手势规则下会
 * 直接 reject，此时绝不能显示 ✓——那是在骗用户"已经复制好了"，而剪贴板里还是
 * 上一次的内容。所以这里统一成"失败即返回 false 且不打勾"。
 *
 * 只抽逻辑不抽组件：五处的按钮外观/位置各不相同，统一成一个 CopyButton 会为了
 * 迁就彼此把 CSS 拧成一团，而真正重复的从来是这段行为。
 */
export function copyFeedback(resetMs = 2000) {
  let flag = $state<string>("");
  return {
    /** 当前处于"刚复制好"状态的标记（单按钮场景传/读 "1" 即可）。 */
    get value(): string {
      return flag;
    },
    /** 复制文本；成功返回 true 并把标记置为 `mark`，resetMs 之后自动清掉。 */
    async copy(text: string, mark = "1"): Promise<boolean> {
      try {
        await navigator.clipboard.writeText(text);
      } catch {
        return false; // 剪贴板不可用——不打勾，值本身在页面上仍然可见可选中
      }
      flag = mark;
      setTimeout(() => {
        if (flag === mark) flag = "";
      }, resetMs);
      return true;
    },
  };
}

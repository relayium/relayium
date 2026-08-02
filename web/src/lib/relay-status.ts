// Turning a RelayAvailability into the one sentence the user actually needs.
//
// 这两个函数存在的理由是：**"连接失败"和"没有中继可用"是两件不同的事**，而以前它们
// 在界面上长得一模一样。跨网传输真正建不起来的时候，绝大多数情况根本不是传输出了问题，
// 而是这一场会话压根没拿到中继——可能是配额用完、可能是邮箱没验证、可能是 /api/ice
// 那一下没读到（限流/抖动），也可能是部署本身没配中继。用户能做的事在这四种情况里
// 完全不同（等下个月 / 去验证邮箱 / 重试 / 联系管理员），所以必须分开说。
//
// 纯函数、独立成文件：它们要被单测钉住，而调用点在 Svelte 组件的模板里。
import type { RelayAvailability } from "./ice";
import type { Messages } from "./i18n.svelte";

/**
 * The note to show under a cross-network transfer that failed at "connecting".
 *
 * Returns "" when a relay WAS available — then the failure really is about the
 * connection (peer vanished, both networks unreachable) and the generic status
 * line is the honest thing to show. Never invent a relay explanation for a
 * failure that had nothing to do with the relay.
 */
export function relayFailNote(t: Messages, status: RelayAvailability): string {
  switch (status) {
    case "quota":
      return t.crossnet.relayQuotaFail;
    case "unverified":
      return t.crossnet.relayUnverifiedFail;
    case "ratelimited":
    case "unavailable":
      // Same sentence for both: from the user's side they are the same
      // situation and the same remedy — the settings did not arrive, wait a
      // moment and reload. The two stay distinct in RelayAvailability because
      // they demand different things of the CODE (a rate limit must never be
      // retried automatically).
      return t.crossnet.relayUnavailableFail;
    case "none":
      return t.crossnet.relayNoneFail;
    default:
      return "";
  }
}

/**
 * The note to show on the pairing card *before* anything is attempted, when we
 * already know this session has no relay. Warning early beats a 30-second wait
 * that ends in a failure the user could have been told about up front.
 *
 * "unavailable" deliberately warns too: it means we could not read /api/ice at
 * all, so we cannot promise a relay — but it is phrased as retryable, because
 * unlike quota/unverified it usually is.
 */
export function relayWarnNote(t: Messages, status: RelayAvailability): string {
  switch (status) {
    case "quota":
      return t.crossnet.relayQuotaWarn;
    case "unverified":
      return t.crossnet.relayUnverifiedWarn;
    case "ratelimited":
    case "unavailable":
      return t.crossnet.relayUnavailableWarn;
    case "none":
      return t.crossnet.relayNoneWarn;
    default:
      return "";
  }
}

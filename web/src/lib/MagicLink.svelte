<script lang="ts">
  // 邮件登录链接的落地页：/magic-link?token=<t>。
  //
  // 这个页面存在的唯一理由是**它需要一次点击**。邮件里的链接指向服务端的 GET，
  // 那个 GET 只把浏览器重定向到这里、不碰令牌；令牌由下面这颗按钮 POST 掉。
  //
  // 企业邮件网关（Proofpoint / Mimecast / Defender Safe Links）在投递前会预取邮件里
  // 的每个链接。原来 GET 就消费令牌并下发 30 天会话 cookie，于是每封登录邮件都有
  // 两个后果：用户点开时看到"链接已过期"，以及一个活着的登录态被交给了第三方的扫描
  // 基础设施。挂载即自动提交会把这道防线原样搬回去——**别这么做**，扫描器执行 JS
  // 的情形并不罕见。
  import { onDestroy, onMount } from "svelte";
  import { completeMagicLink } from "./auth.svelte";
  import { lang, messages, type Messages } from "./i18n.svelte";
  import { navigate } from "./router.svelte";
  import AuthLanding from "./AuthLanding.svelte";

  const t = $derived<Messages>(messages[lang()]);

  type Phase = "boot" | "confirm" | "working" | "success" | "invalid" | "no-token";
  let phase = $state<Phase>("boot");
  let token = "";
  let redirectTimer: ReturnType<typeof setTimeout> | undefined;

  const status = $derived(
    phase === "success" ? t.magicLink.done
      : phase === "invalid" ? t.magicLink.expired
      : phase === "no-token" ? t.magicLink.noToken
      : phase === "boot" ? ""
      : t.magicLink.lead,
  );
  const tone = $derived<"neutral" | "success" | "danger">(
    phase === "success" ? "success" : phase === "invalid" || phase === "no-token" ? "danger" : "neutral",
  );

  onMount(() => {
    const tok = new URLSearchParams(location.search).get("token");
    // 立刻把令牌从 URL 里抹掉：留着它会进浏览器历史，也会在之后的导航里通过
    // Referer 漏出去。与 /verify-email、/reset-password 同一套做法。
    if (tok) history.replaceState(null, "", location.pathname);
    if (!tok) { phase = "no-token"; return; }
    token = tok;
    phase = "confirm";
  });

  async function signIn() {
    if (phase === "working") return;
    phase = "working";
    const res = await completeMagicLink(token);
    if (res.ok) {
      phase = "success";
      redirectTimer = setTimeout(() => navigate("lan"), 900);
      return;
    }
    if (res.pendingDeletion && res.reactivateToken) {
      // 账号处于待删除冻结态：没有会话，但拿到了一枚新的恢复令牌。沿用
      // Account.svelte 既有的接法（fragment 里读、读完即抹），不另开一条路径。
      location.hash = `account=pending_deletion&token=${encodeURIComponent(res.reactivateToken)}`;
      navigate("lan");
      return;
    }
    phase = "invalid";
  }

  onDestroy(() => {
    if (redirectTimer) clearTimeout(redirectTimer);
  });
</script>

<AuthLanding title={t.magicLink.title} {status} {tone}>
  {#if phase === "no-token" || phase === "invalid"}
    <button class="btn btn-ghost" onclick={() => navigate("lan")}>{t.magicLink.home}</button>
  {:else if phase === "confirm" || phase === "working"}
    <button class="btn btn-primary auth-action" disabled={phase === "working"} onclick={signIn}>
      {phase === "working" ? t.magicLink.working : t.magicLink.cta}
    </button>
  {/if}
</AuthLanding>

<style>
  .auth-action { inline-size: 100%; }
  @media (pointer: coarse) { .auth-action { min-block-size: 44px; } }
</style>

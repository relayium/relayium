<script lang="ts">
  // 首页折叠线以下的营销区块：使用步骤 → 跨网络引流 → 特性 → CLI → 场景 → FAQ。
  //
  // 单独成一个组件只有一个目的：给它们**一个懒加载边界**。它们原本静态挂在
  // App.svelte 上，于是每一个深链访客（/d/<id> 下载页、/me、/pricing…）都要先下载
  // 一份自己根本不会看到的首页长文案。合成一个组件而不是五个各自动态 import，是因为
  // 五个边界会让打包器把它们共享的东西复制五份——上一次把 Account 改成懒加载正是
  // 这么变大的（首屏反而 +20KB，已回退）。这次照样是先量再留。
  import { lang, messages, type Messages } from "./i18n.svelte";
  // 文本区块的字节上限直接读 text-wire 的常量，不写死在九种译文里：改了协议上限，
  // 首页跟着变。text-wire 已经在主 chunk 里（App.svelte 静态引入 MessagePanel），
  // 所以这里引它不会给懒加载块多加体积。
  import { TEXT_MAX_BYTES } from "./text-wire";
  import { navigate } from "./router.svelte";
  import { reveal } from "./reveal";
  import FeatureStrip from "./FeatureStrip.svelte";
  import CliCallout from "./CliCallout.svelte";
  import HowToSteps from "./HowToSteps.svelte";
  import UseCases from "./UseCases.svelte";
  import Faq from "./Faq.svelte";

  const { maxFiles }: { maxFiles: number } = $props();
  const t = $derived<Messages>(messages[lang()]);
</script>

<HowToSteps {maxFiles} />

<!-- 文本是与文件并列的一等传输方式，但入口只在传输面板里，读首页的人看不到它存在。
     这一块紧跟「使用步骤」，说清三件事实（端到端加密且只作用于这次会话 / 实时、双方
     必须在线 / 从不落服务器），再给出每条上限和"更大就当文件发"的出口。措辞刻意避开
     "聊天"，因为它没有服务端历史，任何暗示都会变成不实承诺。 -->
<section class="textsec" aria-labelledby="home-text-title">
  <div class="head">
    <h2 id="home-text-title">{t.homeText.title}</h2>
    <p class="sub">{t.homeText.sub}</p>
  </div>
  <ul class="points">
    {#each t.homeText.points as p, i (p)}
      <li class="reveal" use:reveal={{ delay: i * 60 }}>{p}</li>
    {/each}
  </ul>
  <p class="limit">{t.homeText.limit(TEXT_MAX_BYTES)}</p>
</section>

<section class="crosscta reveal" use:reveal>
  <div class="cc-text">
    <h3>{t.homeCross.title}</h3>
    <p>{t.homeCross.desc}</p>
  </div>
  <div class="cc-actions">
    <button class="btn btn-primary" onclick={() => navigate("cross")}>{t.homeCross.realtimeCta}</button>
    <button class="btn btn-ghost" onclick={() => navigate("offline")}>{t.homeCross.offlineCta}</button>
  </div>
</section>

<FeatureStrip />
<CliCallout />
<UseCases />
<Faq variant="home" />

<style>
  .textsec { margin: var(--section-gap) 0 var(--space-2); }
  .textsec .head { margin-bottom: var(--space-5); }
  .textsec .head h2 { font-size: var(--fs-h2); margin: 0 0 var(--space-2); }
  .textsec .head .sub { color: var(--text); font-size: var(--fs-sm); max-width: 60ch; margin: 0; }

  /* One column per fact on wide viewports, stacked below 900px.
     `padding-inline-start`/`inset-inline-start` rather than the physical
     properties so the tick gutter flips with dir=rtl (Arabic). */
  .textsec .points {
    list-style: none; margin: 0 0 var(--space-4); padding: 0;
    display: grid; gap: var(--space-3);
    grid-template-columns: repeat(3, 1fr);
  }
  .textsec .points li {
    position: relative;
    border: 1px solid var(--border); border-radius: var(--radius);
    background: var(--surface-2); padding: var(--space-4) var(--space-5);
    padding-inline-start: calc(var(--space-5) + 18px);
    font-size: var(--fs-xs); line-height: 1.55; color: var(--text);
  }
  .textsec .points li::before {
    content: "✓";
    position: absolute; inset-inline-start: var(--space-5); top: var(--space-4);
    color: var(--accent); font-weight: 700;
  }
  .textsec .limit {
    margin: 0; padding: 9px 12px;
    border: 1px solid var(--accent-border); border-radius: 10px;
    background: var(--accent-bg);
    font-size: var(--fs-xs); line-height: 1.5; color: var(--text);
  }
  @media (max-width: 900px) { .textsec .points { grid-template-columns: 1fr; } }

  .crosscta {
    margin: var(--section-gap) 0 var(--space-2);
    display: flex; align-items: center; gap: var(--space-5); flex-wrap: wrap;
    padding: var(--space-5) var(--space-6); border-radius: var(--radius);
    border: 1px solid var(--accent-border); background: var(--accent-bg);
  }
  .crosscta .cc-text { flex: 1 1 260px; min-width: 0; }
  .crosscta h3 { margin: 0 0 6px; font-size: 18px; color: var(--text-h); font-weight: 600; }
  .crosscta p { margin: 0; font-size: 13.5px; line-height: 1.55; color: var(--text); }
  .crosscta .btn { white-space: nowrap; }
  .crosscta .cc-actions { display: flex; gap: var(--space-3); flex-wrap: wrap; }
</style>

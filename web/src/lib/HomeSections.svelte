<script lang="ts">
  // 首页折叠线以下的营销区块：使用步骤 → 跨网络引流 → 特性 → CLI → 场景 → FAQ。
  //
  // 单独成一个组件只有一个目的：给它们**一个懒加载边界**。它们原本静态挂在
  // App.svelte 上，于是每一个深链访客（/d/<id> 下载页、/me、/pricing…）都要先下载
  // 一份自己根本不会看到的首页长文案。合成一个组件而不是五个各自动态 import，是因为
  // 五个边界会让打包器把它们共享的东西复制五份——上一次把 Account 改成懒加载正是
  // 这么变大的（首屏反而 +20KB，已回退）。这次照样是先量再留。
  import { lang, messages, type Messages } from "./i18n.svelte";
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

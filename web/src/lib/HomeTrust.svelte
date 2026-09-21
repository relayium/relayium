<script lang="ts">
  // 首页「每一条都可以验证」区块。FeatureStrip 负责**陈述**隐私主张；这一块是主张
  // 之后的那一步——四件访客自己就能做的核对，每件恰好一个链接。它刻意不是"背书"：
  // 没有用户评价、没有 logo 墙、没有"已审计"字样，因为这些现在都不是事实；也不放
  // "尚未经过独立审计"那句和漏洞报告入口（owner 决定，2026-09-21），那两样留在
  // README / SECURITY.md。
  //
  // 每一行都是关于本组件之外某样东西的事实陈述（许可证文件、协议规范目录、发布工作流、
  // README 的一节），所以这些句子由 scripts/test/home-trust-claims-test.mjs 钉在仓库上——
  // 它跑在没有路径过滤的 repo-hygiene 里，改 README 或工作流的那次提交也会被判定；
  // HomeTrust.test.ts 只钉组件结构。
  import { lang, messages, legalUrl, type Messages } from "./i18n.svelte";
  import { reveal } from "./reveal";
  import Icon, { type IconName } from "./Icon.svelte";
  import { HOME_TRUST_LINKS } from "./home-trust-links";

  const t = $derived<Messages>(messages[lang()]);

  // Index-aligned with `t.homeTrust.items`: code, protocol, connection, install.
  // The third row is our own page and stays in this tab; the others leave the site.
  const rows = $derived<{ icon: IconName; href: string; external: boolean }[]>([
    { icon: "file", href: HOME_TRUST_LINKS.source, external: true },
    { icon: "network", href: HOME_TRUST_LINKS.protocol, external: true },
    { icon: "shield", href: legalUrl("security", lang()), external: false },
    { icon: "package", href: HOME_TRUST_LINKS.verify, external: true },
  ]);
</script>

<section class="trust reveal" aria-labelledby="home-trust-title" use:reveal>
  <div class="lede">
    <h2 id="home-trust-title">{t.homeTrust.title}</h2>
    <p class="sub">{t.homeTrust.sub}</p>
  </div>
  <ul class="rows">
    {#each t.homeTrust.items as item, i (item.title)}
      {@const row = rows[i]!}
      <li>
        <span class="mark"><Icon name={row.icon} size={20} /></span>
        <div class="body">
          <h3>{item.title}</h3>
          <p>{item.desc}</p>
          {#if row.external}
            <a href={row.href} target="_blank" rel="noopener">{item.link}</a>
          {:else}
            <a href={row.href}>{item.link}</a>
          {/if}
        </div>
      </li>
    {/each}
  </ul>
</section>

<style>
  /* One panel, not a second grid of tiles: it has to read as a single statement
     and must not be mistaken for more feature cards. `minmax(0, …)` on both
     tracks so a long link label can shrink the column instead of widening the
     page. Logical properties throughout, so the layout flips with dir=rtl. */
  .trust {
    margin: var(--section-gap) 0 var(--space-2);
    display: grid;
    grid-template-columns: minmax(0, 5fr) minmax(0, 7fr);
    gap: var(--space-6);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--surface-2);
    padding: var(--space-6);
  }
  .lede h2 { font-size: var(--fs-h2); margin: 0 0 var(--space-2); }
  .lede .sub { margin: 0; color: var(--text); font-size: var(--fs-sm); max-width: 44ch; }

  .rows { list-style: none; margin: 0; padding: 0; }
  .rows li {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr);
    gap: var(--space-3);
    padding-block: var(--space-4);
    border-block-start: 1px solid var(--border);
  }
  .rows li:first-child { padding-block-start: 0; border-block-start: 0; }
  .rows li:last-child { padding-block-end: 0; }

  .mark { color: var(--accent-fg); display: inline-flex; padding-block-start: 1px; }
  .body h3 {
    margin: 0 0 var(--space-1);
    font-size: var(--fs-sm);
    font-weight: 600;
    color: var(--text-h);
  }
  .body p {
    margin: 0 0 var(--space-2);
    font-size: var(--fs-xs);
    line-height: 1.5;
    color: var(--text);
  }
  /* inline-block, not inline: a long label wraps at phone width, and a wrapped
     inline link has a bounding box whose middle is empty — the focus ring splits
     in two and a tap on the box can miss the link. */
  .body a {
    display: inline-block;
    line-height: 1.4;
    font-size: var(--fs-xs);
    font-weight: 500;
    color: var(--accent-fg);
    text-decoration: none;
    overflow-wrap: anywhere;
  }
  .body a:hover { text-decoration: underline; }

  @media (max-width: 760px) {
    .trust { grid-template-columns: minmax(0, 1fr); gap: var(--space-5); padding: var(--space-5); }
    .lede .sub { max-width: none; }
  }
</style>

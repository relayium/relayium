<script lang="ts">
  import { lang, messages, pageUrl, type Messages } from "./i18n.svelte";
  import { reveal } from "./reveal";
  import Icon, { type IconName } from "./Icon.svelte";
  const t = $derived<Messages>(messages[lang()]);

  // The four cards are the most self-identifying thing on the homepage — a
  // reader picks the one that is their situation — and they were plain text, so
  // that recognition led nowhere. Each now opens the guide that answers it.
  //
  // Indexed by position, so this array and `useCases.items` in i18n/*.ts must
  // stay the same length and order; the test in use-cases.test.ts fails if they
  // drift apart. Trailing slash: these are generated directories, and the
  // slash-less form 301s.
  const CASE_SLUGS = [
    "how-to/send-large-files-without-cloud", // 🌍 big files across the world
    "how-to/share-a-file-with-an-expiring-link", // ⏳ when they're not online
    "how-to/send-files-pc-to-phone-wirelessly", // 📱 phone ↔ computer
    "guides/how-relayium-encrypts-your-files", // 🔒 privacy-sensitive one-shot
    "how-to/send-text-between-devices", // 💬 text, links, commands, code
  ];
  const CASE_ICONS: readonly IconName[] = ["globe", "clock", "devices", "lock", "message"];
  const caseHref = (i: number) => pageUrl(CASE_SLUGS[i], lang()) + "/";
</script>

<section class="cases" aria-label={t.useCases.title}>
  <div class="head">
    <h2>{t.useCases.title}</h2>
    <p class="sub">{t.useCases.sub}</p>
  </div>
  <div class="grid">
    {#each t.useCases.items as c, i (c.title)}
      <a class="case reveal" href={caseHref(i)} use:reveal={{ delay: i * 60 }}>
        <span class="icon" aria-hidden="true"><Icon name={CASE_ICONS[i]} size={22} /></span>
        <div class="body">
          <h3>{c.title}</h3>
          <p>{c.desc}</p>
        </div>
      </a>
    {/each}
  </div>
</section>

<style>
  .cases { margin: var(--section-gap) 0 var(--space-2); }
  .head { margin-bottom: var(--space-5); }
  .head h2 { font-size: var(--fs-h2); margin: 0 0 var(--space-2); }
  .head .sub { color: var(--text); font-size: var(--fs-sm); max-width: 60ch; }

  .grid {
    display: grid; gap: var(--space-4);
    grid-template-columns: repeat(2, 1fr);
  }
  .case {
    display: flex; gap: var(--space-4); align-items: flex-start;
    border: 1px solid var(--border); border-radius: var(--radius);
    background: var(--surface-2); padding: var(--space-5);
    transition: border-color .13s, box-shadow .13s;
    text-decoration: none; color: inherit;
  }
  /* An odd number of cards would otherwise leave a hole in the last row; let the
     trailing card span the full width instead. In the single-column layout below
     `grid-column: 1 / -1` is already the default, so this is a no-op there. */
  .case:last-child:nth-child(odd) { grid-column: 1 / -1; }
  .case:hover { border-color: var(--accent-border); box-shadow: var(--shadow); }
  .case:hover h3 { color: var(--accent); }
  .case:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .icon {
    flex: none; width: 44px; height: 44px; line-height: 44px; text-align: center;
    display: grid; place-items: center; color: var(--accent);
    border-radius: var(--radius-sm); background: var(--accent-bg);
  }
  .body { min-width: 0; }
  .case h3 { margin: 2px 0 var(--space-2); font-size: var(--fs-body); color: var(--text-h); font-weight: 600; }
  .case p { margin: 0; font-size: var(--fs-xs); line-height: 1.55; color: var(--text); }

  @media (max-width: 640px) { .grid { grid-template-columns: 1fr; } }
</style>

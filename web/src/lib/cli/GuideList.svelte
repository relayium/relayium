<script lang="ts">
  // All nine CLI guides, grouped the same way the modes are.
  //
  // Nine equal cards is the shape that made the previous six unreadable: every
  // entry had the same weight, so the list answered "which one do I need?" with
  // "any of them". Grouping under the task taxonomy makes each group answerable,
  // and an open list with hairline separators keeps nine entries from turning
  // into a wall of rims.
  //
  // The hrefs always end in a slash. The article pages are directories, so
  // /guides/x costs every reader and every crawler a redirect.
  import { GUIDE_GROUPS, GUIDES, guidePath, type GuideKey } from "../cli-page-data";
  import type { Messages } from "../i18n.svelte";

  let { cli, lang }: { cli: Messages["cliPage"]; lang: string } = $props();

  const slugOf = Object.fromEntries(GUIDES.map((g) => [g.key, g.slug])) as Record<GuideKey, string>;
</script>

<p class="lead">{cli.guidesIntro}</p>

<div class="groups">
  {#each GUIDE_GROUPS as group (group.key)}
    <div class="group">
      <h3 id={`guides-${group.key}`}>{cli.guideGroups[group.key]}</h3>
      <ul aria-labelledby={`guides-${group.key}`}>
        {#each group.guides as key (key)}
          <li>
            <a href={guidePath(slugOf[key], lang)}>
              <span>{cli.guides[key]}</span>
              <span class="arrow" aria-hidden="true">→</span>
            </a>
          </li>
        {/each}
      </ul>
    </div>
  {/each}
</div>

<style>
  .lead {
    color: var(--text);
    line-height: 1.65;
    margin: 0 0 var(--space-5);
    max-inline-size: 62ch;
  }

  .groups {
    display: grid;
    gap: var(--space-6);
  }
  @media (min-width: 760px) {
    .groups {
      grid-template-columns: repeat(2, minmax(0, 1fr));
      column-gap: var(--space-7);
    }
  }

  h3 {
    font-size: var(--fs-sm);
    color: var(--text);
    font-weight: 600;
    letter-spacing: 0.02em;
    margin: 0 0 var(--space-2);
  }

  ul {
    list-style: none;
    margin: 0;
    padding: 0;
    border-block-start: 1px solid var(--border);
  }
  li {
    border-block-end: 1px solid var(--border);
  }

  a {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
    /* 44px on every viewport: nine links in a column is exactly where a short
       target starts costing mis-taps. */
    min-block-size: 44px;
    padding-block: var(--space-2);
    color: var(--text-h);
    text-decoration: none;
    font-size: var(--fs-sm);
    line-height: 1.5;
  }
  a:hover {
    color: var(--accent-fg);
  }
  a:focus-visible {
    outline: var(--focus-width) solid var(--focus);
    outline-offset: -1px;
  }
  .arrow {
    color: var(--accent-fg);
    flex: 0 0 auto;
  }
</style>

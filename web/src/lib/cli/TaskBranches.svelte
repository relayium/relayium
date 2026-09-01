<script lang="ts">
  // "Choose by task" — three branches, and the taxonomy is connectivity and
  // ownership rather than a persona.
  //
  // A persona split ("developers", "teams", "people sending a photo") asks the
  // reader to classify themselves, which they cannot get wrong in a way the page
  // can detect and cannot get right in a way that helps. Connectivity and
  // ownership are decidable from facts they already know — can the other machine
  // be offline, do I administer it — and each answer maps to a specific set of
  // modes. Every mode appears in exactly one branch; the tests assert that,
  // because a mode in two branches is a page that cannot answer "which one".
  import { TASK_BRANCHES, CLI_MODES, type ModeKey } from "../cli-page-data";
  import type { Messages } from "../i18n.svelte";

  let {
    cli,
    id,
    onNavigate,
  }: {
    cli: Messages["cliPage"];
    id: string;
    onNavigate: (event: MouseEvent, id: string) => void;
  } = $props();

  const byKey = Object.fromEntries(CLI_MODES.map((m) => [m.key, m])) as Record<
    ModeKey,
    (typeof CLI_MODES)[number]
  >;
</script>

<section class="tasks" {id} aria-labelledby="cli-tasks-h">
  <h2 id="cli-tasks-h">{cli.sections.tasks}</h2>
  <p class="lead">{cli.tasksIntro}</p>

  <div class="branches">
    {#each TASK_BRANCHES as branch (branch.key)}
      <div class="branch">
        <h3 id={`task-${branch.key}`}>{cli.tasks[branch.key].title}</h3>
        <p>{cli.tasks[branch.key].body}</p>
        <!-- Named by the branch heading, so a screen reader announces which of
             the three lists of modes this is. -->
        <ul aria-labelledby={`task-${branch.key}`}>
          {#each branch.modes as key (key)}
            <li>
              <a href={`#${byKey[key].id}`} onclick={(e) => onNavigate(e, byKey[key].id)}>
                <code dir="ltr">{byKey[key].name}</code>
              </a>
            </li>
          {/each}
        </ul>
      </div>
    {/each}
  </div>
</section>

<style>
  .tasks h2 {
    font-size: var(--fs-h2);
    color: var(--text-h);
    letter-spacing: -0.4px;
    margin: 0 0 var(--space-2);
  }
  .lead {
    color: var(--text);
    line-height: 1.65;
    margin: 0 0 var(--space-6);
    max-inline-size: 62ch;
  }

  /* Three open columns split by hairlines. No fills, no rounded rims: this is a
     signpost, and three tinted boxes here would compete with the seven mode
     sections that follow — the part of the page that carries the content. */
  .branches {
    display: grid;
    gap: var(--space-6);
  }
  @media (min-width: 860px) {
    .branches {
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: var(--space-5);
    }
    .branch + .branch {
      padding-inline-start: var(--space-5);
      border-inline-start: 1px solid var(--border);
    }
  }

  h3 {
    font-size: var(--fs-h3);
    color: var(--text-h);
    margin: 0 0 var(--space-2);
    text-wrap: balance;
  }
  .branch p {
    color: var(--text);
    font-size: var(--fs-sm);
    line-height: 1.65;
    margin: 0 0 var(--space-3);
  }

  ul {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  li + li {
    border-block-start: 1px solid var(--border);
  }
  a {
    display: flex;
    align-items: center;
    /* 44px: on a phone these are the links that take you to the mode. */
    min-block-size: 44px;
    text-decoration: none;
  }
  a:focus-visible {
    outline: var(--focus-width) solid var(--focus);
    outline-offset: -1px;
  }
  code {
    font-family: var(--mono);
    font-size: var(--fs-sm);
    color: var(--accent-fg);
  }
  a:hover code {
    text-decoration: underline;
  }
</style>
